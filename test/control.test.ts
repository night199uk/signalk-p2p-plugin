import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateIdentity } from "../src/identity.js";
import { createClaimControl, isAttestor } from "../src/security/control.js";
import {
  ClaimRegistry,
  type ClaimRegistryOptions,
} from "../src/security/registry.js";
import type { ClaimRecord } from "../src/security/claim.js";

const selfId = "urn:mrn:signalk:uuid:6b0e776f-811a-4b35-980e-b93405371bc5";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function setup(
  options: Partial<ClaimRegistryOptions> = {},
  attestorList?: string[],
): Promise<{
  control: ReturnType<typeof createClaimControl>;
  registry: ClaimRegistry;
  attestor: ReturnType<typeof generateIdentity>;
  broadcasts: ClaimRecord[];
}> {
  const directory = await mkdtemp(join(tmpdir(), "skp2p-control-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));

  const attestor = generateIdentity();
  const attestors = attestorList ?? [attestor.publicKeyRaw.toString("hex")];
  const registry = new ClaimRegistry({
    path: join(directory, "claims.json"),
    attestors,
    now: () => 1000,
    ...options,
  });
  await registry.load();

  const broadcasts: ClaimRecord[] = [];
  const control = createClaimControl({
    identity: () => attestor,
    registry: () => registry,
    attestors: () => attestors,
    broadcast: (record) => broadcasts.push(record),
    now: () => 1000,
  });

  return { control, registry, attestor, broadcasts };
}

function subjectClaim() {
  const subject = generateIdentity();
  return {
    subject,
    claim: {
      kind: "claim" as const,
      selfId,
      subjectKey: subject.publicKeyRaw,
      issuerKey: subject.publicKeyRaw,
      issuedAt: 900,
      expiresAt: 0,
    },
  };
}

describe("claim control", () => {
  it("recognises a configured attestor", () => {
    const identity = generateIdentity();
    expect(isAttestor(identity, [identity.publicKeyRaw.toString("hex")])).toBe(
      true,
    );
    expect(isAttestor(identity, [])).toBe(false);
  });

  it("attests a known claim and broadcasts the record", async () => {
    const { control, registry, broadcasts } = await setup();
    const { claim } = subjectClaim();
    registry.applyClaim(claim);

    const result = control.attest({ selfId });

    expect(result.ok).toBe(true);
    expect(result.claim?.status).toBe("attested");
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].kind).toBe("attest");
  });

  it("revokes a claim and broadcasts the record", async () => {
    const { control, registry, broadcasts } = await setup();
    const { claim } = subjectClaim();
    registry.applyClaim(claim);
    control.attest({ selfId });

    const result = control.revoke({ selfId });

    expect(result.ok).toBe(true);
    expect(result.claim?.status).toBe("revoked");
    expect(broadcasts.map((record) => record.kind)).toEqual([
      "attest",
      "revoke",
    ]);
  });

  it("refuses to attest when the instance is not an attestor", async () => {
    const { control, registry } = await setup({}, []);
    const { claim } = subjectClaim();
    registry.applyClaim(claim);

    const result = control.attest({ selfId });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a configured public attestor/);
  });

  it("rejects an invalid key", async () => {
    const { control } = await setup();
    const result = control.attest({ selfId, key: "not-hex" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/64 hex/);
  });

  it("reports the identity and whether it can attest", async () => {
    const { control, attestor } = await setup();
    expect(control.identity()).toEqual({
      publicKey: attestor.publicKeyRaw.toString("hex"),
      fingerprint: attestor.fingerprint,
      isAttestor: true,
    });
  });
});
