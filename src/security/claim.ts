import { verifyDetached, type Identity } from "../identity.js";
import { readString8, requireU32, writeString8 } from "../data/codec.js";

export const CLAIM_VERSION = 1;

export type ClaimKind = "claim" | "attest" | "revoke";

const KIND: Record<ClaimKind, number> = {
  claim: 1,
  attest: 2,
  revoke: 3,
};

const KIND_NAMES: Record<number, ClaimKind> = {
  1: "claim",
  2: "attest",
  3: "revoke",
};

const FLAG_SIGNED = 1;
const KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const PREFIX = Buffer.from("signalk-p2p/claim/v1", "utf8");

export interface ClaimRecord {
  kind: ClaimKind;
  /** The Signal K selfId being claimed, attested or revoked. */
  selfId: string;
  /** The key that owns (or is being attested for) the selfId. */
  subjectKey: Buffer;
  /** The key that issued this record (the subject for a claim). */
  issuerKey: Buffer;
  /** Unix seconds. */
  issuedAt: number;
  /** Unix seconds; 0 means no expiry. */
  expiresAt: number;
  /** 64 bytes for attest/revoke; absent for a claim. */
  signature?: Buffer;
}

/** Canonical bytes an attestor signs. */
export function claimSignable(record: ClaimRecord): Buffer {
  if (record.subjectKey.length !== KEY_BYTES) {
    throw new Error("claim: subjectKey must be 32 bytes");
  }
  if (record.issuerKey.length !== KEY_BYTES) {
    throw new Error("claim: issuerKey must be 32 bytes");
  }
  const selfId = Buffer.from(record.selfId, "utf8");
  if (selfId.length > 255) {
    throw new Error("claim: selfId too long");
  }
  const out = Buffer.allocUnsafe(
    PREFIX.length + 1 + 1 + selfId.length + KEY_BYTES * 2 + 4 + 4,
  );
  let offset = 0;
  PREFIX.copy(out, offset);
  offset += PREFIX.length;
  out.writeUInt8(KIND[record.kind], offset);
  offset += 1;
  out.writeUInt8(selfId.length, offset);
  offset += 1;
  selfId.copy(out, offset);
  offset += selfId.length;
  record.subjectKey.copy(out, offset);
  offset += KEY_BYTES;
  record.issuerKey.copy(out, offset);
  offset += KEY_BYTES;
  out.writeUInt32BE(record.issuedAt, offset);
  offset += 4;
  out.writeUInt32BE(record.expiresAt, offset);
  return out;
}

export function signClaim(
  record: ClaimRecord,
  identity: Identity,
): ClaimRecord {
  return {
    ...record,
    signature: identity.sign(claimSignable(record)),
  };
}

export function verifyClaimSignature(record: ClaimRecord): boolean {
  if (record.kind === "claim") return true;
  if (!record.signature) return false;
  return verifyDetached(
    record.issuerKey,
    claimSignable(record),
    record.signature,
  );
}

export function encodeClaim(record: ClaimRecord): Buffer {
  if (record.subjectKey.length !== KEY_BYTES) {
    throw new Error("claim: subjectKey must be 32 bytes");
  }
  if (record.issuerKey.length !== KEY_BYTES) {
    throw new Error("claim: issuerKey must be 32 bytes");
  }
  const signed = record.kind !== "claim";
  if (signed && (!record.signature || record.signature.length !== 64)) {
    throw new Error("claim: attest/revoke require a 64-byte signature");
  }
  const selfId = Buffer.from(record.selfId, "utf8");
  if (selfId.length > 255) {
    throw new Error("claim: selfId too long");
  }

  const total =
    3 +
    1 +
    selfId.length +
    KEY_BYTES * 2 +
    4 +
    4 +
    (signed ? SIGNATURE_BYTES : 0);
  const out = Buffer.allocUnsafe(total);
  let offset = 0;
  out.writeUInt8(CLAIM_VERSION, offset);
  offset += 1;
  out.writeUInt8(KIND[record.kind], offset);
  offset += 1;
  out.writeUInt8(signed ? FLAG_SIGNED : 0, offset);
  offset += 1;
  offset = writeString8(out, offset, record.selfId);
  record.subjectKey.copy(out, offset);
  offset += KEY_BYTES;
  record.issuerKey.copy(out, offset);
  offset += KEY_BYTES;
  out.writeUInt32BE(requireU32(record.issuedAt, "issuedAt"), offset);
  offset += 4;
  out.writeUInt32BE(requireU32(record.expiresAt, "expiresAt"), offset);
  offset += 4;
  if (signed) {
    (record.signature as Buffer).copy(out, offset);
    offset += SIGNATURE_BYTES;
  }
  if (offset !== total) {
    throw new Error("claim: internal length mismatch");
  }
  return out;
}

export function decodeClaim(data: Buffer): ClaimRecord {
  let offset = 0;
  const take = (bytes: number): number => {
    if (offset + bytes > data.length) {
      throw new Error("claim: truncated record");
    }
    const start = offset;
    offset += bytes;
    return start;
  };

  const version = data.readUInt8(take(1));
  if (version !== CLAIM_VERSION) {
    throw new Error(`claim: unsupported version ${version}`);
  }
  const kindValue = data.readUInt8(take(1));
  const kind = KIND_NAMES[kindValue];
  if (!kind) {
    throw new Error(`claim: unknown kind ${kindValue}`);
  }
  const flags = data.readUInt8(take(1));
  const signed = (flags & FLAG_SIGNED) !== 0;

  const read = readString8(data, offset);
  const selfId = read.value;
  offset = read.offset;

  const readBytes = (bytes: number): Buffer => {
    const start = take(bytes);
    return Buffer.from(data.subarray(start, start + bytes));
  };

  const subjectKey = readBytes(KEY_BYTES);
  const issuerKey = readBytes(KEY_BYTES);
  const issuedAt = data.readUInt32BE(take(4));
  const expiresAt = data.readUInt32BE(take(4));

  let signature: Buffer | undefined;
  if (signed) {
    signature = readBytes(SIGNATURE_BYTES);
  }
  if (offset !== data.length) {
    throw new Error(`claim: ${data.length - offset} trailing bytes`);
  }

  return {
    kind,
    selfId,
    subjectKey,
    issuerKey,
    issuedAt,
    expiresAt,
    signature,
  };
}
