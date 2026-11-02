import { describe, expect, it } from "vitest";
import { generateIdentity, verifyDetached } from "../src/identity.js";
import {
  claimSignable,
  decodeClaim,
  encodeClaim,
  signClaim,
  verifyClaimSignature,
  type ClaimRecord,
} from "../src/security/claim.js";

const selfId = "urn:mrn:signalk:uuid:6b0e776f-811a-4b35-980e-b93405371bc5";

describe("claim codec", () => {
  it("round-trips a claim", () => {
    const identity = generateIdentity();
    const record: ClaimRecord = {
      kind: "claim",
      selfId,
      subjectKey: identity.publicKeyRaw,
      issuerKey: identity.publicKeyRaw,
      issuedAt: 100,
      expiresAt: 0,
    };
    const decoded = decodeClaim(encodeClaim(record));

    expect(decoded.kind).toBe("claim");
    expect(decoded.selfId).toBe(selfId);
    expect(decoded.subjectKey.equals(identity.publicKeyRaw)).toBe(true);
    expect(decoded.signature).toBeUndefined();
  });

  it("signs and verifies an attestation", () => {
    const subject = generateIdentity();
    const attestor = generateIdentity();
    const record = signClaim(
      {
        kind: "attest",
        selfId,
        subjectKey: subject.publicKeyRaw,
        issuerKey: attestor.publicKeyRaw,
        issuedAt: 100,
        expiresAt: 0,
      },
      attestor,
    );
    expect(record.signature).toHaveLength(64);

    const decoded = decodeClaim(encodeClaim(record));
    expect(verifyClaimSignature(decoded)).toBe(true);
    expect(
      verifyDetached(
        decoded.issuerKey,
        claimSignable(decoded),
        decoded.signature as Buffer,
      ),
    ).toBe(true);
  });

  it("detects a tampered attestation", () => {
    const subject = generateIdentity();
    const attestor = generateIdentity();
    const record = signClaim(
      {
        kind: "attest",
        selfId,
        subjectKey: subject.publicKeyRaw,
        issuerKey: attestor.publicKeyRaw,
        issuedAt: 100,
        expiresAt: 0,
      },
      attestor,
    );
    const decoded = decodeClaim(encodeClaim(record));
    const tampered: ClaimRecord = {
      ...decoded,
      subjectKey: generateIdentity().publicKeyRaw,
    };

    expect(verifyClaimSignature(tampered)).toBe(false);
  });

  it("round-trips a revocation", () => {
    const subject = generateIdentity();
    const attestor = generateIdentity();
    const record = signClaim(
      {
        kind: "revoke",
        selfId,
        subjectKey: subject.publicKeyRaw,
        issuerKey: attestor.publicKeyRaw,
        issuedAt: 300,
        expiresAt: 0,
      },
      attestor,
    );
    const decoded = decodeClaim(encodeClaim(record));

    expect(decoded.kind).toBe("revoke");
    expect(verifyClaimSignature(decoded)).toBe(true);
  });
});
