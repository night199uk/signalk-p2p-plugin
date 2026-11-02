import { createHash } from "node:crypto";
import { verifyDetached, type Identity } from "../identity.js";

export type GroupRole = "owner" | "admin" | "member" | "viewer";

export interface GroupMember {
  selfId: string;
  /** Hex-encoded Ed25519 identity key. */
  ed25519Key: string;
  /** Hex-encoded X25519 box key. */
  boxPublicKey: string;
  mmsi?: string;
  role: GroupRole;
  addedAt: number;
}

export interface WrappedKey {
  boxPublicKey: string;
  /** Base64 sealed epoch key. */
  sealedKey: string;
}

export interface GroupRoster {
  /** Hex-encoded 32-byte group id. */
  groupId: string;
  name: string;
  version: number;
  epoch: number;
  /** Distinct admin approvals required before this roster is adopted. */
  adminThreshold: number;
  members: GroupMember[];
  wrappedKeys: WrappedKey[];
  /** Hex-encoded Ed25519 keys allowed to approve the next roster. */
  adminKeys: string[];
  updatedAt: number;
}

export interface RosterApproval {
  /** Hex-encoded admin Ed25519 key. */
  key: string;
  /** Base64 signature over canonicalJson(roster). */
  signature: string;
}

export interface SignedRoster {
  roster: GroupRoster;
  approvals: RosterApproval[];
}

export interface GroupProposal {
  hash: string;
  groupId: string;
  version: number;
  signed: SignedRoster;
  createdAt: number;
}

export interface GroupState {
  roster: GroupRoster;
  approvals: RosterApproval[];
  /** Base64 epoch key. */
  epochKey: string;
  /** Base64 AES key derived from the epoch key. */
  dataKey: string;
  /** Hex data topic. */
  dataTopic: string;
  /** Hex roster topic. */
  rosterTopic: string;
  role: GroupRole;
  /** This instance forwards encrypted group data. */
  relay?: boolean;
  /** Invite nonces already used by this admin. */
  usedInvites?: string[];
  removed?: boolean;
}

export interface GroupInvite {
  v: 1;
  groupId: string;
  name: string;
  epoch: number;
  epochKey: string;
  rosterTopic: string;
  adminKey: string;
  role: GroupRole;
  expiresAt: number;
  nonce: string;
  roster: SignedRoster;
  signature: string;
}

export interface JoinRequest {
  groupId: string;
  invite: GroupInvite;
  inviteNonce: string;
  member: GroupMember;
  requestedAt: number;
  signature: string;
}

export interface PendingRequest {
  groupId: string;
  request: JoinRequest;
  receivedAt: number;
}

export interface GroupInfo {
  id: string;
  name: string;
  role: GroupRole;
  epoch: number;
  members: number;
  removed: boolean;
  pendingProposals: number;
}

export interface ProposalInfo {
  hash: string;
  groupId: string;
  version: number;
  approvals: number;
  threshold: number;
}

/** Deterministic JSON with sorted object keys, used for signatures. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function signable(value: unknown, signatureField?: string): Buffer {
  if (signatureField) {
    const copy = { ...(value as Record<string, unknown>) };
    delete copy[signatureField];
    return Buffer.from(canonicalJson(copy));
  }
  return Buffer.from(canonicalJson(value));
}

function approvalFor(roster: GroupRoster, identity: Identity): RosterApproval {
  return {
    key: identity.publicKeyRaw.toString("hex"),
    signature: identity.sign(signable(roster)).toString("base64"),
  };
}

export function signRoster(
  roster: GroupRoster,
  identity: Identity,
): SignedRoster {
  return { roster, approvals: [approvalFor(roster, identity)] };
}

export function addApproval(
  signed: SignedRoster,
  identity: Identity,
): SignedRoster {
  const key = identity.publicKeyRaw.toString("hex");
  return {
    roster: signed.roster,
    approvals: [
      ...signed.approvals.filter(
        (approval) => approval.key.toLowerCase() !== key,
      ),
      approvalFor(signed.roster, identity),
    ],
  };
}

/** Distinct, valid approvals from keys in `adminKeys`. */
export function approvalCount(
  signed: SignedRoster,
  adminKeys: string[],
): number {
  const allowed = new Set(adminKeys.map((key) => key.toLowerCase()));
  const bytes = signable(signed.roster);
  const seen = new Set<string>();
  for (const approval of signed.approvals) {
    const key = approval.key.toLowerCase();
    if (!allowed.has(key) || seen.has(key)) continue;
    if (
      verifyDetached(
        Buffer.from(key, "hex"),
        bytes,
        Buffer.from(approval.signature, "base64"),
      )
    ) {
      seen.add(key);
    }
  }
  return seen.size;
}

export function verifyRoster(
  signed: SignedRoster,
  adminKeys: string[],
): boolean {
  return (
    signed.roster.adminThreshold >= 1 &&
    approvalCount(signed, adminKeys) >= signed.roster.adminThreshold
  );
}

export function proposalHash(signed: SignedRoster): string {
  return createHash("sha256").update(signable(signed.roster)).digest("hex");
}

export function signInvite(
  invite: Omit<GroupInvite, "signature">,
  identity: Identity,
): GroupInvite {
  return {
    ...invite,
    signature: identity.sign(signable(invite, "signature")).toString("base64"),
  };
}

export function verifyInvite(invite: GroupInvite): boolean {
  return verifyDetached(
    Buffer.from(invite.adminKey, "hex"),
    signable(invite, "signature"),
    Buffer.from(invite.signature, "base64"),
  );
}

export function signJoinRequest(
  request: Omit<JoinRequest, "signature">,
  identity: Identity,
): JoinRequest {
  return {
    ...request,
    signature: identity.sign(signable(request, "signature")).toString("base64"),
  };
}

export function verifyJoinRequest(request: JoinRequest): boolean {
  return verifyDetached(
    Buffer.from(request.member.ed25519Key, "hex"),
    signable(request, "signature"),
    Buffer.from(request.signature, "base64"),
  );
}
