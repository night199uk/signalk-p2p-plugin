import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decodeEnvelope, encodeEnvelope } from "../data/envelope.js";
import type { Identity } from "../identity.js";
import { LiveClient, type LiveLogger } from "../live/client.js";
import type { LiveMessage } from "../live/message.js";
import {
  decryptRecord,
  deriveDataKey,
  encryptRecord,
  groupDataTopic,
  groupInviteTopic,
  groupRosterTopic,
  openEpochKey,
  sealEpochKey,
} from "./crypto.js";
import {
  addApproval,
  approvalCount,
  proposalHash,
  signInvite,
  signJoinRequest,
  signRoster,
  verifyInvite,
  verifyJoinRequest,
  verifyRoster,
  type GroupInfo,
  type GroupInvite,
  type GroupMember,
  type GroupProposal,
  type GroupRole,
  type GroupRoster,
  type GroupState,
  DEFAULT_GROUP_RATE_CAP_HZ,
  clampGroupRate,
  groupPublishRate,
  groupRateCap,
  type JoinRequest,
  type PendingRequest,
  type ProposalInfo,
  type SignedRoster,
  type WrappedKey,
} from "./types.js";
import {
  formatInviteCode,
  generateInviteCode,
  looksLikeInviteCode,
  normalizeInviteCode,
} from "./invite-code.js";

export interface GroupManagerOptions {
  dataDir: string;
  identity: Identity;
  selfId: string;
  log?: LiveLogger;
  onData: (groupId: string, message: LiveMessage) => void;
  now?: () => number;
  /** Do not start transports; useful for tests. */
  autoStart?: boolean;
}

interface Runtime {
  control?: LiveClient;
  data?: LiveClient;
  requestTimer?: ReturnType<typeof setInterval>;
}

interface PersistedInvite {
  code: string;
  token: string;
  groupId: string;
  nonce: string;
  expiresAt: number;
}

interface ActiveInvite extends PersistedInvite {
  client?: LiveClient;
  expiryTimer?: ReturnType<typeof setInterval>;
}

interface Persisted {
  groups: GroupState[];
  requests: PendingRequest[];
  proposals?: GroupProposal[];
  invites?: PersistedInvite[];
}

const ROLES: GroupRole[] = ["owner", "admin", "member", "viewer"];

/**
 * Private group state and transport.
 *
 * Roster changes are **multi-signature proposals**: an admin signs a candidate
 * roster, and it is adopted once `adminThreshold` distinct current admins have
 * signed the same candidate. A change below the threshold is stored and
 * broadcast as a proposal, and other admins approve it.
 */
export class GroupManager {
  private readonly groups = new Map<string, GroupState>();
  private readonly runtimes = new Map<string, Runtime>();
  private readonly pending: PendingRequest[] = [];
  private readonly proposals = new Map<string, Map<string, GroupProposal>>();
  private readonly invites = new Map<string, ActiveInvite>();
  private readonly identity: Identity;
  private readonly selfId: string;
  private readonly log: LiveLogger | undefined;
  private readonly onData: (groupId: string, message: LiveMessage) => void;
  private readonly now: () => number;
  private readonly autoStart: boolean;
  private readonly path: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: GroupManagerOptions) {
    this.identity = options.identity;
    this.selfId = options.selfId;
    this.log = options.log;
    this.onData = options.onData;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.autoStart = options.autoStart ?? true;
    this.path = join(options.dataDir, "groups.json");
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Persisted;
      if (Array.isArray(parsed.groups)) {
        for (const state of parsed.groups) {
          if (state?.roster?.groupId) {
            this.groups.set(state.roster.groupId, state);
          }
        }
      }
      if (Array.isArray(parsed.requests)) {
        this.pending.push(...parsed.requests);
      }
      if (Array.isArray(parsed.proposals)) {
        for (const proposal of parsed.proposals) {
          this.storeProposal(proposal.hash, proposal.signed);
        }
      }
      if (Array.isArray(parsed.invites)) {
        for (const entry of parsed.invites) {
          if (
            entry &&
            typeof entry.code === "string" &&
            typeof entry.token === "string" &&
            typeof entry.groupId === "string" &&
            typeof entry.nonce === "string" &&
            typeof entry.expiresAt === "number"
          ) {
            this.invites.set(normalizeInviteCode(entry.code), {
              code: normalizeInviteCode(entry.code),
              token: entry.token,
              groupId: entry.groupId,
              nonce: entry.nonce,
              expiresAt: entry.expiresAt,
            });
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.log?.error(`groups: load failed: ${String(error)}`);
      }
    }
  }

  async start(): Promise<void> {
    for (const state of [...this.groups.values()]) {
      await this.startGroup(state);
    }
    for (const entry of [...this.invites.values()]) {
      await this.startInvite(entry);
    }
  }

  async stop(): Promise<void> {
    for (const groupId of [...this.runtimes.keys()]) {
      await this.stopGroup(groupId);
    }
    for (const code of [...this.invites.keys()]) {
      await this.stopInvite(code, false);
    }
  }

  list(): GroupInfo[] {
    return [...this.groups.values()].map((state) => this.info(state));
  }

  requests(): PendingRequest[] {
    return [...this.pending];
  }

  proposalsFor(groupId?: string): ProposalInfo[] {
    const groups = groupId
      ? [this.groups.get(groupId)].filter((state): state is GroupState =>
          Boolean(state),
        )
      : [...this.groups.values()];
    const result: ProposalInfo[] = [];
    for (const state of groups) {
      const proposals = this.proposals.get(state.roster.groupId);
      if (!proposals) continue;
      for (const proposal of proposals.values()) {
        result.push({
          hash: proposal.hash,
          groupId: proposal.groupId,
          version: proposal.version,
          approvals: approvalCount(proposal.signed, state.roster.adminKeys),
          threshold: proposal.signed.roster.adminThreshold,
        });
      }
    }
    return result;
  }

  async createGroup(name: string): Promise<GroupInfo> {
    if (!name.trim()) throw new Error("group name is required");
    const epochKey = randomBytes(32);
    const roster: GroupRoster = {
      groupId: randomBytes(32).toString("hex"),
      name: name.trim(),
      version: 1,
      epoch: 1,
      rateCapHz: DEFAULT_GROUP_RATE_CAP_HZ,
      adminThreshold: 1,
      members: [this.selfMember("owner")],
      wrappedKeys: [this.wrap(epochKey, this.identity.boxPublicKey)],
      adminKeys: [this.identity.publicKeyRaw.toString("hex")],
      updatedAt: this.now(),
    };
    const signed = signRoster(roster, this.identity);
    const state = this.stateFrom(roster, signed, epochKey, "owner");
    this.groups.set(roster.groupId, state);
    await this.save();
    if (this.autoStart) await this.startGroup(state);
    return this.info(state);
  }

  createInvite(
    groupId: string,
    role: GroupRole = "member",
    expiresInSeconds = 24 * 3600,
  ): string {
    const state = this.requireGroup(groupId);
    if (!this.isAdmin(state)) {
      throw new Error("only an owner or admin can invite");
    }
    if (!this.isRole(role)) throw new Error("invalid role");
    const invite: Omit<GroupInvite, "signature"> = {
      v: 1,
      groupId,
      name: state.roster.name,
      epoch: state.roster.epoch,
      epochKey: state.epochKey,
      rosterTopic: state.rosterTopic,
      adminKey: this.identity.publicKeyRaw.toString("hex"),
      role,
      expiresAt: this.now() + Math.max(60, expiresInSeconds),
      nonce: randomBytes(16).toString("hex"),
      roster: {
        roster: structuredClone(state.roster),
        approvals: structuredClone(state.approvals),
      },
    };
    return Buffer.from(
      JSON.stringify(signInvite(invite, this.identity)),
    ).toString("base64url");
  }

  /**
   * Create a short, per-invite code. The full signed invite is distributed to
   * the group and served by any online member or relay, so the admin does not
   * need to stay online after the record is distributed.
   */
  async createInviteCode(
    groupId: string,
    role: GroupRole = "member",
    expiresInSeconds = 24 * 3600,
  ): Promise<string> {
    const state = this.requireGroup(groupId);
    if (!this.isAdmin(state)) {
      throw new Error("only an owner or admin can invite");
    }
    if (!this.isRole(role)) throw new Error("invalid role");
    const code = generateInviteCode();
    const invite: Omit<GroupInvite, "signature"> = {
      v: 2,
      code,
      groupId,
      name: state.roster.name,
      epoch: state.roster.epoch,
      epochKey: state.epochKey,
      rosterTopic: state.rosterTopic,
      adminKey: this.identity.publicKeyRaw.toString("hex"),
      role,
      expiresAt: this.now() + Math.max(60, expiresInSeconds),
      nonce: randomBytes(16).toString("hex"),
      roster: {
        roster: structuredClone(state.roster),
        approvals: structuredClone(state.approvals),
      },
    };
    const token = Buffer.from(
      JSON.stringify(signInvite(invite, this.identity)),
    ).toString("base64url");
    const entry: ActiveInvite = {
      code,
      token,
      groupId,
      nonce: invite.nonce,
      expiresAt: invite.expiresAt,
    };
    this.invites.set(code, entry);
    await this.save();
    this.broadcastInvite({ kind: "record", token }, groupId);
    if (this.autoStart) await this.startInvite(entry);
    return formatInviteCode(code);
  }

  async join(token: string, mmsi?: string): Promise<GroupInfo> {
    let inviteToken = token.trim();
    if (looksLikeInviteCode(inviteToken)) {
      inviteToken = await this.fetchInvite(normalizeInviteCode(inviteToken));
    }
    const invite = JSON.parse(
      Buffer.from(inviteToken, "base64url").toString("utf8"),
    ) as GroupInvite;
    if (!verifyInvite(invite)) throw new Error("invalid invite signature");
    if (invite.v !== 1 && invite.v !== 2) {
      throw new Error("unsupported invite version");
    }
    if (invite.v === 2 && !invite.code) {
      throw new Error("invalid invite code");
    }
    if (invite.expiresAt <= this.now()) throw new Error("invite expired");
    if (invite.groupId !== invite.roster.roster.groupId) {
      throw new Error("invite group mismatch");
    }
    if (!invite.roster.roster.adminKeys.includes(invite.adminKey)) {
      throw new Error("inviter is not an admin");
    }
    if (!verifyRoster(invite.roster, invite.roster.roster.adminKeys)) {
      throw new Error("roster is not approved");
    }
    const existing = this.groups.get(invite.groupId);
    if (existing) return this.info(existing);

    const epochKey = Buffer.from(invite.epochKey, "base64");
    if (epochKey.length !== 32) throw new Error("invalid epoch key");
    const state = this.stateFrom(
      invite.roster.roster,
      invite.roster,
      epochKey,
      invite.role,
    );
    this.groups.set(invite.groupId, state);
    await this.save();
    if (this.autoStart) await this.startGroup(state);

    const member: GroupMember = {
      ...this.selfMember(invite.role),
      ...(mmsi ? { mmsi } : {}),
    };
    const request = signJoinRequest(
      {
        groupId: invite.groupId,
        invite,
        inviteNonce: invite.nonce,
        member,
        requestedAt: this.now(),
      },
      this.identity,
    );
    this.runtimes
      .get(invite.groupId)
      ?.control?.enqueue(
        encodeEnvelope("group-join", Buffer.from(JSON.stringify(request))),
      );
    return this.info(state);
  }

  async approveJoin(
    groupId: string,
    nonce: string,
    role?: GroupRole,
    mmsi?: string,
  ): Promise<GroupInfo> {
    const state = this.requireGroup(groupId);
    if (!this.isAdmin(state)) {
      throw new Error("only an owner or admin can approve members");
    }
    const pending = this.pending.find(
      (entry) =>
        entry.groupId === groupId && entry.request.inviteNonce === nonce,
    );
    if (!pending) throw new Error("no matching join request");
    const request = pending.request;
    if (state.usedInvites?.includes(request.inviteNonce)) {
      throw new Error("invite already used");
    }
    if (!verifyJoinRequest(request)) {
      throw new Error("invalid join request signature");
    }
    if (!verifyInvite(request.invite)) {
      throw new Error("invalid invite");
    }
    if (request.invite.expiresAt <= this.now()) {
      throw new Error("invite expired");
    }
    const member: GroupMember = {
      ...request.member,
      role: role && this.isRole(role) ? role : request.member.role,
      ...(mmsi ? { mmsi } : {}),
    };
    if (!this.isRole(member.role)) throw new Error("invalid role");
    if (
      state.roster.members.some(
        (existing) =>
          existing.selfId === member.selfId ||
          (member.mmsi !== undefined && existing.mmsi === member.mmsi),
      )
    ) {
      throw new Error("member or MMSI already in the group");
    }

    const candidate = structuredClone(state.roster);
    candidate.members.push(member);
    if (
      member.role === "admin" &&
      !candidate.adminKeys.includes(member.ed25519Key)
    ) {
      candidate.adminKeys.push(member.ed25519Key);
    }
    this.ensureWrappedIn(
      candidate,
      member.boxPublicKey,
      Buffer.from(state.epochKey, "base64"),
    );
    candidate.version += 1;
    candidate.updatedAt = this.now();
    state.usedInvites = [
      ...(state.usedInvites ?? []),
      request.inviteNonce,
    ].slice(-1000);
    this.pending.splice(this.pending.indexOf(pending), 1);
    const usedInvite = [...this.invites.values()].find(
      (invite) =>
        invite.groupId === groupId && invite.nonce === request.inviteNonce,
    );
    if (usedInvite) await this.stopInvite(usedInvite.code, true);
    await this.propose(state, candidate);
    return this.info(state);
  }

  async removeMember(groupId: string, selfId: string): Promise<GroupInfo> {
    const state = this.requireGroup(groupId);
    if (!this.isAdmin(state)) {
      throw new Error("only an owner or admin can remove members");
    }
    const candidate = structuredClone(state.roster);
    const member = candidate.members.find((entry) => entry.selfId === selfId);
    if (!member) throw new Error("member not found");
    if (member.role === "owner") {
      throw new Error("cannot remove the owner");
    }
    candidate.members = candidate.members.filter((entry) => entry !== member);
    candidate.adminKeys = candidate.adminKeys.filter(
      (key) => key !== member.ed25519Key,
    );

    const epochKey = randomBytes(32);
    candidate.epoch += 1;
    candidate.wrappedKeys = candidate.members.map((entry) =>
      this.wrap(epochKey, Buffer.from(entry.boxPublicKey, "hex")),
    );
    candidate.version += 1;
    candidate.updatedAt = this.now();
    await this.propose(state, candidate);
    return this.info(state);
  }

  async promoteMember(
    groupId: string,
    selfId: string,
    role: GroupRole,
  ): Promise<GroupInfo> {
    const state = this.requireGroup(groupId);
    if (!this.isAdmin(state)) {
      throw new Error("only an owner or admin can change roles");
    }
    if (!this.isRole(role)) throw new Error("invalid role");
    const candidate = structuredClone(state.roster);
    const member = candidate.members.find((entry) => entry.selfId === selfId);
    if (!member) throw new Error("member not found");
    if (member.role === "owner") throw new Error("cannot change the owner");
    member.role = role;
    if (role === "admin" && !candidate.adminKeys.includes(member.ed25519Key)) {
      candidate.adminKeys.push(member.ed25519Key);
    }
    if (role === "member" || role === "viewer") {
      candidate.adminKeys = candidate.adminKeys.filter(
        (key) => key !== member.ed25519Key,
      );
    }
    candidate.version += 1;
    candidate.updatedAt = this.now();
    await this.propose(state, candidate);
    return this.info(state);
  }

  async setAdminThreshold(
    groupId: string,
    threshold: number,
  ): Promise<GroupInfo> {
    const state = this.requireGroup(groupId);
    if (!this.isAdmin(state)) {
      throw new Error("only an owner or admin can change the threshold");
    }
    if (
      !Number.isInteger(threshold) ||
      threshold < 1 ||
      threshold > state.roster.adminKeys.length
    ) {
      throw new Error("threshold must be between 1 and the number of admins");
    }
    const candidate = structuredClone(state.roster);
    candidate.adminThreshold = threshold;
    candidate.version += 1;
    candidate.updatedAt = this.now();
    await this.propose(state, candidate);
    return this.info(state);
  }

  async setRateCap(groupId: string, rateHz: number): Promise<GroupInfo> {
    const state = this.requireGroup(groupId);
    if (!this.isAdmin(state)) {
      throw new Error("only an owner or admin can change the rate cap");
    }
    const candidate = structuredClone(state.roster);
    candidate.rateCapHz = clampGroupRate(rateHz);
    candidate.version += 1;
    candidate.updatedAt = this.now();
    await this.propose(state, candidate);
    return this.info(state);
  }

  async setPublishRate(groupId: string, rateHz: number): Promise<GroupInfo> {
    const state = this.requireGroup(groupId);
    if (!this.canPublish(groupId)) {
      throw new Error("this member cannot publish to the group");
    }
    const cap = groupRateCap(state.roster);
    state.publishRateHz = Math.min(clampGroupRate(rateHz), cap);
    await this.save();
    return this.info(state);
  }

  async approveProposal(groupId: string, hash: string): Promise<GroupInfo> {
    const state = this.requireGroup(groupId);
    if (!this.isAdmin(state)) {
      throw new Error("only an owner or admin can approve a proposal");
    }
    const proposal = this.proposals.get(groupId)?.get(hash);
    if (!proposal) throw new Error("proposal not found");
    const signed = addApproval(proposal.signed, this.identity);
    if (verifyRoster(signed, state.roster.adminKeys)) {
      await this.finalizeRoster(state, signed);
    } else {
      this.storeProposal(hash, signed);
      await this.save();
      this.broadcastRoster(signed);
    }
    return this.info(state);
  }

  exportProposal(groupId: string, hash: string): SignedRoster | undefined {
    const proposal = this.proposals.get(groupId)?.get(hash);
    return proposal ? structuredClone(proposal.signed) : undefined;
  }

  exportRoster(groupId: string): SignedRoster {
    const state = this.requireGroup(groupId);
    return {
      roster: structuredClone(state.roster),
      approvals: structuredClone(state.approvals),
    };
  }

  /** Apply a join request received from the roster topic (or a test). */
  async receiveJoinRequest(request: JoinRequest): Promise<void> {
    const state = this.groups.get(request.groupId);
    if (!state || !this.isAdmin(state)) return;
    if (!verifyJoinRequest(request) || !verifyInvite(request.invite)) {
      return;
    }
    if (
      !this.pending.some(
        (entry) =>
          entry.groupId === request.groupId &&
          entry.request.inviteNonce === request.inviteNonce,
      )
    ) {
      this.pending.push({
        groupId: request.groupId,
        request,
        receivedAt: this.now(),
      });
      await this.save();
    }
  }

  /** Apply a signed roster or proposal received from the roster topic. */
  async receiveRoster(signed: SignedRoster): Promise<void> {
    const state = this.groups.get(signed.roster.groupId);
    if (!state) return;
    await this.applyRoster(state, signed);
  }

  async setRelay(groupId: string, enabled: boolean): Promise<void> {
    const state = this.requireGroup(groupId);
    state.relay = enabled;
    this.runtimes.get(groupId)?.data?.setAggregator(enabled);
    await this.save();
  }

  async leave(groupId: string): Promise<void> {
    await this.stopGroup(groupId);
    this.groups.delete(groupId);
    this.proposals.delete(groupId);
    await this.save();
  }

  authorize(
    groupId: string,
    selfId: string,
    sourceKey: Buffer,
    publish = false,
  ): boolean {
    const state = this.groups.get(groupId);
    if (!state || state.removed) return false;
    const member = state.roster.members.find(
      (entry) =>
        entry.selfId === selfId &&
        entry.ed25519Key === sourceKey.toString("hex"),
    );
    if (!member) return false;
    return !publish || member.role !== "viewer";
  }

  canPublish(groupId: string): boolean {
    const state = this.groups.get(groupId);
    return Boolean(state && !state.removed && state.role !== "viewer");
  }

  enqueueData(groupId: string, record: Buffer): void {
    this.runtimes.get(groupId)?.data?.enqueue(record);
  }

  private async propose(
    state: GroupState,
    candidate: GroupRoster,
  ): Promise<void> {
    const signed = signRoster(candidate, this.identity);
    if (verifyRoster(signed, state.roster.adminKeys)) {
      await this.finalizeRoster(state, signed);
      return;
    }
    this.storeProposal(proposalHash(signed), signed);
    await this.save();
    this.broadcastRoster(signed);
  }

  private async finalizeRoster(
    state: GroupState,
    signed: SignedRoster,
  ): Promise<void> {
    if (!verifyRoster(signed, state.roster.adminKeys)) return;
    if (signed.roster.version <= state.roster.version) return;

    const roster = structuredClone(signed.roster);
    const approvals = structuredClone(signed.approvals);
    const me = roster.members.find(
      (member) =>
        member.selfId === this.selfId &&
        member.ed25519Key === this.identity.publicKeyRaw.toString("hex"),
    );

    this.clearProposals(roster.groupId, roster.version);

    if (!me) {
      state.removed = true;
      state.roster = roster;
      state.approvals = approvals;
      await this.stopGroup(roster.groupId);
      await this.save();
      return;
    }

    const wrapped = roster.wrappedKeys.find(
      (entry) =>
        entry.boxPublicKey === this.identity.boxPublicKey.toString("hex"),
    );
    if (!wrapped) return;
    const epochKey = openEpochKey(
      Buffer.from(wrapped.sealedKey, "base64"),
      this.identity.boxPublicKey,
      this.identity.boxSecretKey,
    );
    if (!epochKey) return;

    const previousTopic = state.dataTopic;
    state.roster = roster;
    state.approvals = approvals;
    state.epochKey = epochKey.toString("base64");
    state.dataKey = deriveDataKey(epochKey).toString("base64");
    state.dataTopic = groupDataTopic(epochKey).toString("hex");
    state.role = me.role;
    state.removed = false;
    state.publishRateHz = Math.min(
      state.publishRateHz ?? groupRateCap(roster),
      groupRateCap(roster),
    );
    await this.save();
    this.broadcastRoster({ roster, approvals });
    if (state.dataTopic !== previousTopic) {
      await this.restartData(state);
    }
  }

  private async applyRoster(
    state: GroupState,
    signed: SignedRoster,
  ): Promise<void> {
    const count = approvalCount(signed, state.roster.adminKeys);
    if (count === 0) return;
    if (!verifyRoster(signed, state.roster.adminKeys)) {
      if (signed.roster.version > state.roster.version) {
        this.storeProposal(proposalHash(signed), signed);
        await this.save();
      }
      return;
    }
    if (signed.roster.version <= state.roster.version) return;
    await this.finalizeRoster(state, signed);
  }

  private async startGroup(state: GroupState): Promise<void> {
    if (state.removed || this.runtimes.has(state.roster.groupId)) return;
    const control = new LiveClient({
      identity: this.identity,
      selfId: this.selfId,
      topic: Buffer.from(state.rosterTopic, "hex"),
      batchIntervalMs: 1000,
      log: this.log,
    });
    control.onMessage((message) => {
      void this.handleControl(state, message).catch((error) =>
        this.log?.error(`groups: control failed: ${String(error)}`),
      );
    });
    await control.start();
    control.enqueue(
      encodeEnvelope(
        "group-invite",
        Buffer.from(
          JSON.stringify({ kind: "sync", groupId: state.roster.groupId }),
        ),
      ),
    );
    const data = this.createDataClient(state);
    await data.start();
    this.requestRoster(state);
    const requestTimer = setInterval(() => this.requestRoster(state), 60_000);
    requestTimer.unref?.();
    this.runtimes.set(state.roster.groupId, {
      control,
      data,
      requestTimer,
    });
  }

  private requestRoster(state: GroupState): void {
    this.runtimes.get(state.roster.groupId)?.control?.enqueue(
      encodeEnvelope(
        "group-roster-request",
        Buffer.from(
          JSON.stringify({
            groupId: state.roster.groupId,
            version: state.roster.version,
          }),
        ),
      ),
    );
  }

  private createDataClient(state: GroupState): LiveClient {
    const dataKey = Buffer.from(state.dataKey, "base64");
    const data = new LiveClient({
      identity: this.identity,
      selfId: this.selfId,
      topic: Buffer.from(state.dataTopic, "hex"),
      batchIntervalMs: 2000,
      log: this.log,
      transformOutgoing: (record) => encryptRecord(dataKey, record),
      transformIncoming: (record) => decryptRecord(dataKey, record),
    });
    data.setAggregator(state.relay ?? false);
    data.onMessage((message) => {
      const member = state.roster.members.find(
        (entry) =>
          entry.selfId === message.selfId &&
          entry.ed25519Key === message.sourceKey.toString("hex"),
      );
      if (!member || member.role === "viewer") return;
      this.onData(state.roster.groupId, message);
    });
    return data;
  }

  private async restartData(state: GroupState): Promise<void> {
    const runtime = this.runtimes.get(state.roster.groupId);
    if (!runtime) return;
    await runtime.data?.stop();
    const data = this.createDataClient(state);
    await data.start();
    runtime.data = data;
  }

  private broadcastInvite(
    payload: Record<string, unknown>,
    groupId?: string,
  ): void {
    const gid =
      groupId ??
      (typeof payload.groupId === "string" ? payload.groupId : undefined);
    if (!gid) return;
    this.runtimes
      .get(gid)
      ?.control?.enqueue(
        encodeEnvelope(
          "group-invite",
          Buffer.from(JSON.stringify({ ...payload, groupId: gid })),
        ),
      );
  }

  private async startInvite(entry: ActiveInvite): Promise<void> {
    if (entry.expiresAt <= this.now()) {
      await this.stopInvite(entry.code, false);
      return;
    }
    const existing = this.invites.get(entry.code);
    if (!existing || existing.client) return;
    const group = this.groups.get(entry.groupId);
    if (!group) return;
    let invite: GroupInvite;
    try {
      invite = JSON.parse(
        Buffer.from(entry.token, "base64url").toString("utf8"),
      ) as GroupInvite;
    } catch {
      return;
    }
    if (
      invite.v !== 2 ||
      !invite.code ||
      normalizeInviteCode(invite.code) !== entry.code ||
      invite.groupId !== entry.groupId ||
      invite.expiresAt <= this.now() ||
      !verifyInvite(invite) ||
      !group.roster.adminKeys.includes(invite.adminKey)
    ) {
      return;
    }

    const client = new LiveClient({
      identity: this.identity,
      selfId: this.selfId,
      topic: groupInviteTopic(entry.code),
      batchIntervalMs: 500,
      log: this.log,
    });
    client.onMessage((message) => {
      for (const record of message.records) {
        try {
          const envelope = decodeEnvelope(record);
          if (envelope.type !== "group-invite") continue;
          const request = JSON.parse(envelope.payload.toString("utf8")) as {
            kind?: string;
            code?: string;
          };
          if (request.kind !== "request") continue;
          if (
            request.code &&
            normalizeInviteCode(request.code) !== entry.code
          ) {
            continue;
          }
          client.enqueue(
            encodeEnvelope(
              "group-invite",
              Buffer.from(
                JSON.stringify({ kind: "offer", token: entry.token }),
              ),
            ),
          );
        } catch {
          // ignore malformed requests
        }
      }
    });
    await client.start();
    existing.client = client;
    const remaining = Math.max(1000, (entry.expiresAt - this.now()) * 1000);
    existing.expiryTimer = setInterval(() => {
      void this.stopInvite(entry.code, false);
    }, remaining);
    existing.expiryTimer.unref?.();
  }

  private async stopInvite(code: string, broadcast: boolean): Promise<void> {
    const normalized = normalizeInviteCode(code);
    const entry = this.invites.get(normalized);
    if (!entry) return;
    if (entry.expiryTimer) clearInterval(entry.expiryTimer);
    await entry.client?.stop();
    this.invites.delete(normalized);
    await this.save();
    if (broadcast) {
      this.broadcastInvite({ kind: "revoke", code: normalized }, entry.groupId);
    }
  }

  private async fetchInvite(code: string): Promise<string> {
    const client = new LiveClient({
      identity: this.identity,
      selfId: this.selfId,
      topic: groupInviteTopic(code),
      batchIntervalMs: 500,
      log: this.log,
    });
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let retry: ReturnType<typeof setInterval> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error, token?: string): void => {
        if (settled) return;
        settled = true;
        if (retry) clearInterval(retry);
        if (timeout) clearTimeout(timeout);
        void client.stop();
        if (error) reject(error);
        else resolve(token as string);
      };
      const request = (): void => {
        client.enqueue(
          encodeEnvelope(
            "group-invite",
            Buffer.from(JSON.stringify({ kind: "request", code })),
          ),
        );
      };
      timeout = setTimeout(() => {
        finish(
          new Error(
            "invite code not found; a group member or relay must be online",
          ),
        );
      }, 30_000);
      client.onMessage((message) => {
        for (const record of message.records) {
          try {
            const envelope = decodeEnvelope(record);
            if (envelope.type !== "group-invite") continue;
            const offer = JSON.parse(envelope.payload.toString("utf8")) as {
              kind?: string;
              token?: string;
            };
            if (offer.kind !== "offer" || typeof offer.token !== "string") {
              continue;
            }
            const invite = JSON.parse(
              Buffer.from(offer.token, "base64url").toString("utf8"),
            ) as GroupInvite;
            if (
              invite.v !== 2 ||
              !invite.code ||
              normalizeInviteCode(invite.code) !== code ||
              invite.expiresAt <= this.now() ||
              !verifyInvite(invite)
            ) {
              continue;
            }
            finish(undefined, offer.token);
            return;
          } catch {
            // ignore malformed offers
          }
        }
      });
      client
        .start()
        .then(() => {
          request();
          retry = setInterval(request, 5000);
          retry.unref?.();
        })
        .catch((error) => {
          finish(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private async handleControl(
    state: GroupState,
    message: LiveMessage,
  ): Promise<void> {
    for (const record of message.records) {
      let envelope;
      try {
        envelope = decodeEnvelope(record);
      } catch {
        continue;
      }
      try {
        if (envelope.type === "group-invite") {
          const payload = JSON.parse(envelope.payload.toString("utf8")) as {
            kind?: string;
            groupId?: string;
            token?: string;
            code?: string;
          };
          if (payload.groupId !== state.roster.groupId) continue;
          if (payload.kind === "record") {
            if (typeof payload.token !== "string") continue;
            let invite: GroupInvite;
            try {
              invite = JSON.parse(
                Buffer.from(payload.token, "base64url").toString("utf8"),
              ) as GroupInvite;
            } catch {
              continue;
            }
            if (
              invite.v !== 2 ||
              !invite.code ||
              invite.groupId !== state.roster.groupId ||
              invite.expiresAt <= this.now() ||
              !verifyInvite(invite) ||
              !state.roster.adminKeys.includes(invite.adminKey)
            ) {
              continue;
            }
            const code = normalizeInviteCode(invite.code);
            const existing = this.invites.get(code);
            const entry: ActiveInvite = {
              code,
              token: payload.token,
              groupId: invite.groupId,
              nonce: invite.nonce,
              expiresAt: invite.expiresAt,
              client: existing?.client,
              expiryTimer: existing?.expiryTimer,
            };
            this.invites.set(code, entry);
            await this.save();
            if (this.autoStart && !entry.client) {
              await this.startInvite(entry);
            }
          } else if (payload.kind === "sync") {
            for (const entry of this.invites.values()) {
              if (
                entry.groupId !== state.roster.groupId ||
                entry.expiresAt <= this.now()
              ) {
                continue;
              }
              this.broadcastInvite(
                { kind: "record", token: entry.token },
                entry.groupId,
              );
            }
          } else if (payload.kind === "revoke") {
            if (
              typeof payload.code !== "string" ||
              !state.roster.adminKeys.includes(
                message.sourceKey.toString("hex"),
              )
            ) {
              continue;
            }
            await this.stopInvite(normalizeInviteCode(payload.code), false);
          }
          continue;
        }
        if (envelope.type === "group-roster-request") {
          const request = JSON.parse(envelope.payload.toString("utf8")) as {
            groupId?: string;
            version?: number;
          };
          if (request.groupId !== state.roster.groupId) continue;
          const version =
            typeof request.version === "number" ? request.version : 0;
          if (state.roster.version > version) {
            this.broadcastRoster({
              roster: state.roster,
              approvals: state.approvals,
            });
          }
          for (const proposal of this.proposals
            .get(state.roster.groupId)
            ?.values() ?? []) {
            if (proposal.version > version) {
              this.broadcastRoster(proposal.signed);
            }
          }
          continue;
        }
        if (envelope.type === "group-roster") {
          const signed = JSON.parse(
            envelope.payload.toString("utf8"),
          ) as SignedRoster;
          if (signed.roster.groupId === state.roster.groupId) {
            await this.applyRoster(state, signed);
          }
        } else if (envelope.type === "group-join") {
          if (!this.isAdmin(state)) continue;
          const request = JSON.parse(
            envelope.payload.toString("utf8"),
          ) as JoinRequest;
          if (request.groupId !== state.roster.groupId) continue;
          if (request.member.ed25519Key !== message.sourceKey.toString("hex")) {
            continue;
          }
          await this.receiveJoinRequest(request);
        }
      } catch (error) {
        this.log?.error(`groups: bad control record: ${String(error)}`);
      }
    }
  }

  private async stopGroup(groupId: string): Promise<void> {
    const runtime = this.runtimes.get(groupId);
    if (!runtime) return;
    if (runtime.requestTimer) {
      clearInterval(runtime.requestTimer);
    }
    await runtime.data?.stop();
    await runtime.control?.stop();
    this.runtimes.delete(groupId);
  }

  private broadcastRoster(signed: SignedRoster): void {
    this.runtimes
      .get(signed.roster.groupId)
      ?.control?.enqueue(
        encodeEnvelope("group-roster", Buffer.from(JSON.stringify(signed))),
      );
  }

  private storeProposal(hash: string, signed: SignedRoster): void {
    const groupId = signed.roster.groupId;
    let proposals = this.proposals.get(groupId);
    if (!proposals) {
      proposals = new Map();
      this.proposals.set(groupId, proposals);
    }
    proposals.set(hash, {
      hash,
      groupId,
      version: signed.roster.version,
      signed,
      createdAt: this.now(),
    });
  }

  private clearProposals(groupId: string, version: number): void {
    const proposals = this.proposals.get(groupId);
    if (!proposals) return;
    for (const [hash, proposal] of proposals) {
      if (proposal.version <= version) proposals.delete(hash);
    }
    if (proposals.size === 0) this.proposals.delete(groupId);
  }

  private ensureWrappedIn(
    roster: GroupRoster,
    boxPublicKey: string,
    epochKey: Buffer,
  ): void {
    if (
      !roster.wrappedKeys.some((entry) => entry.boxPublicKey === boxPublicKey)
    ) {
      roster.wrappedKeys.push(
        this.wrap(epochKey, Buffer.from(boxPublicKey, "hex")),
      );
    }
  }

  private wrap(epochKey: Buffer, boxPublicKey: Buffer): WrappedKey {
    return {
      boxPublicKey: boxPublicKey.toString("hex"),
      sealedKey: sealEpochKey(epochKey, boxPublicKey).toString("base64"),
    };
  }

  private selfMember(role: GroupRole): GroupMember {
    return {
      selfId: this.selfId,
      ed25519Key: this.identity.publicKeyRaw.toString("hex"),
      boxPublicKey: this.identity.boxPublicKey.toString("hex"),
      role,
      addedAt: this.now(),
    };
  }

  private stateFrom(
    roster: GroupRoster,
    signed: SignedRoster,
    epochKey: Buffer,
    role: GroupRole,
  ): GroupState {
    return {
      roster,
      approvals: structuredClone(signed.approvals),
      epochKey: epochKey.toString("base64"),
      dataKey: deriveDataKey(epochKey).toString("base64"),
      dataTopic: groupDataTopic(epochKey).toString("hex"),
      rosterTopic: groupRosterTopic(
        Buffer.from(roster.groupId, "hex"),
      ).toString("hex"),
      role,
      publishRateHz: groupRateCap(roster),
    };
  }

  private info(state: GroupState): GroupInfo {
    return {
      id: state.roster.groupId,
      name: state.roster.name,
      role: state.role,
      epoch: state.roster.epoch,
      members: state.roster.members.length,
      removed: Boolean(state.removed),
      pendingProposals: this.proposals.get(state.roster.groupId)?.size ?? 0,
      rateCapHz: groupRateCap(state.roster),
      publishRateHz: groupPublishRate(state),
    };
  }

  private requireGroup(groupId: string): GroupState {
    const state = this.groups.get(groupId);
    if (!state) throw new Error("group not found");
    return state;
  }

  private isAdmin(state: GroupState): boolean {
    return (
      (state.role === "owner" || state.role === "admin") &&
      state.roster.adminKeys.includes(
        this.identity.publicKeyRaw.toString("hex"),
      )
    );
  }

  private isRole(role: string): role is GroupRole {
    return (ROLES as string[]).includes(role);
  }

  private save(): Promise<void> {
    const proposals: GroupProposal[] = [];
    for (const group of this.proposals.values()) {
      proposals.push(...group.values());
    }
    const data = JSON.stringify(
      {
        groups: [...this.groups.values()],
        requests: this.pending,
        proposals,
        invites: [...this.invites.values()].map((entry) => ({
          code: entry.code,
          token: entry.token,
          groupId: entry.groupId,
          nonce: entry.nonce,
          expiresAt: entry.expiresAt,
        })),
      },
      null,
      2,
    );
    const temporary = `${this.path}.tmp`;
    this.writeQueue = this.writeQueue
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(temporary, data, { mode: 0o600 });
        await chmod(temporary, 0o600);
        await rename(temporary, this.path);
      })
      .catch((error) => {
        this.log?.error(`groups: save failed: ${String(error)}`);
      });
    return this.writeQueue;
  }
}
