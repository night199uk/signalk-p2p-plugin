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

export const MIN_GROUP_RATE_HZ = 0.01;
export const MAX_GROUP_RATE_HZ = 10;
export const DEFAULT_GROUP_RATE_CAP_HZ = 0.05;

export interface GroupRoster {
  /** Hex-encoded 32-byte group id. */
  groupId: string;
  name: string;
  /** Maximum snapshot publish rate for members, set by the group admin. */
  rateCapHz?: number;
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
  /** Local member preference, always <= the roster rate cap. */
  publishRateHz?: number;
  /** Invite nonces already used by this admin. */
  usedInvites?: string[];
  removed?: boolean;
  /** A join request has been sent and is awaiting admin approval. */
  pendingApproval?: boolean;
  /** Unix seconds after which the invite can no longer be approved. */
  pendingUntil?: number;
}

export interface GroupInvite {
  v: 1 | 2;
  /** Short lookup code for v2 invites. */
  code?: string;
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
  pendingApproval: boolean;
  pendingUntil?: number;
  pendingProposals: number;
  rateCapHz: number;
  publishRateHz: number;
}

export function groupRateCap(roster: GroupRoster): number {
  const value = roster.rateCapHz;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_GROUP_RATE_CAP_HZ;
  }
  return Math.min(Math.max(value, MIN_GROUP_RATE_HZ), MAX_GROUP_RATE_HZ);
}

export function groupPublishRate(state: GroupState): number {
  const cap = groupRateCap(state.roster);
  const value = state.publishRateHz;
  if (typeof value !== "number" || !Number.isFinite(value)) return cap;
  return Math.min(Math.max(value, MIN_GROUP_RATE_HZ), cap);
}

export function clampGroupRate(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("rate must be a number");
  }
  return Math.min(Math.max(value, MIN_GROUP_RATE_HZ), MAX_GROUP_RATE_HZ);
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
