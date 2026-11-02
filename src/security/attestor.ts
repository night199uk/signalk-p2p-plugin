import type { Identity } from "../identity.js";
import { signClaim, type ClaimRecord } from "./claim.js";

export interface AttestOptions {
  /** Unix seconds; 0 means no expiry. */
  expiresAt?: number;
  now?: number;
}

export function createAttestation(
  identity: Identity,
  selfId: string,
  subjectKey: Buffer,
  options: AttestOptions = {},
): ClaimRecord {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  return signClaim(
    {
      kind: "attest",
      selfId,
      subjectKey,
      issuerKey: identity.publicKeyRaw,
      issuedAt: now,
      expiresAt: options.expiresAt ?? 0,
    },
    identity,
  );
}

export function createRevocation(
  identity: Identity,
  selfId: string,
  subjectKey: Buffer,
  options: AttestOptions = {},
): ClaimRecord {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  return signClaim(
    {
      kind: "revoke",
      selfId,
      subjectKey,
      issuerKey: identity.publicKeyRaw,
      issuedAt: now,
      expiresAt: 0,
    },
    identity,
  );
}
