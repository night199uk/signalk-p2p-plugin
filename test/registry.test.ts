import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateIdentity } from "../src/identity.js";
import { signClaim, type ClaimRecord } from "../src/security/claim.js";
import {
  ClaimRegistry,
  type ClaimRegistryOptions,
} from "../src/security/registry.js";

const selfId = "urn:mrn:signalk:uuid:6b0e776f-811a-4b35-980e-b93405371bc5";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function createRegistry(
  options: Partial<ClaimRegistryOptions> = {},
): Promise<ClaimRegistry> {
  const directory = await mkdtemp(join(tmpdir(), "skp2p-registry-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const registry = new ClaimRegistry({
    path: join(directory, "claims.json"),
    now: () => 1000,
    ...options,
  });
  await registry.load();
  return registry;
}

function claim(identity: ReturnType<typeof generateIdentity>): ClaimRecord {
  return {
    kind: "claim",
    selfId,
    subjectKey: identity.publicKeyRaw,
    issuerKey: identity.publicKeyRaw,
    issuedAt: 100,
    expiresAt: 0,
  };
}

function attestation(
  attestor: ReturnType<typeof generateIdentity>,
  subject: ReturnType<typeof generateIdentity>,
  options: { issuedAt?: number; expiresAt?: number } = {},
): ClaimRecord {
  return signClaim(
    {
      kind: "attest",
      selfId,
      subjectKey: subject.publicKeyRaw,
      issuerKey: attestor.publicKeyRaw,
      issuedAt: options.issuedAt ?? 200,
      expiresAt: options.expiresAt ?? 0,
    },
    attestor,
  );
}

describe("ClaimRegistry", () => {
  it("binds an unclaimed selfId to the first verified key (TOFU)", async () => {
    const owner = generateIdentity();
    const registry = await createRegistry();

    expect(registry.authorize(selfId, owner.publicKeyRaw).ok).toBe(true);
    expect(registry.get(selfId)?.status).toBe("unverified");
    expect(registry.authorize(selfId, generateIdentity().publicKeyRaw).ok).toBe(
      false,
    );
  });

  it("does not let a different key take over an active claim", async () => {
    const owner = generateIdentity();
    const impostor = generateIdentity();
    const registry = await createRegistry();

    expect(registry.applyClaim(claim(owner))).toBe("accepted");
    expect(registry.applyClaim(claim(impostor))).toBe("conflict");
    expect(registry.authorize(selfId, owner.publicKeyRaw).ok).toBe(true);
    expect(registry.authorize(selfId, impostor.publicKeyRaw).ok).toBe(false);
  });

  it("lets an attested claim override an unverified one", async () => {
    const owner = generateIdentity();
    const attestedOwner = generateIdentity();
    const attestor = generateIdentity();
    const registry = await createRegistry({
      attestors: [attestor.publicKeyRaw.toString("hex")],
    });

    expect(registry.applyClaim(claim(owner))).toBe("accepted");
    expect(
      registry.applyAttestation(attestation(attestor, attestedOwner)),
    ).toBe(true);
    expect(registry.get(selfId)?.status).toBe("attested");
    expect(registry.authorize(selfId, attestedOwner.publicKeyRaw).ok).toBe(
      true,
    );
    expect(registry.authorize(selfId, owner.publicKeyRaw).ok).toBe(false);
  });

  it("rejects an attestation from a key that is not an attestor", async () => {
    const owner = generateIdentity();
    const notAttestor = generateIdentity();
    const trusted = generateIdentity();
    const registry = await createRegistry({
      attestors: [trusted.publicKeyRaw.toString("hex")],
    });

    expect(registry.applyAttestation(attestation(notAttestor, owner))).toBe(
      false,
    );
  });

  it("requires the configured number of distinct attestations", async () => {
    const owner = generateIdentity();
    const attestorA = generateIdentity();
    const attestorB = generateIdentity();
    const registry = await createRegistry({
      requireAttestation: true,
      attestationThreshold: 2,
      attestors: [
        attestorA.publicKeyRaw.toString("hex"),
        attestorB.publicKeyRaw.toString("hex"),
      ],
    });

    expect(registry.applyAttestation(attestation(attestorA, owner))).toBe(true);
    expect(registry.get(selfId)?.status).toBe("unverified");
    expect(registry.authorize(selfId, owner.publicKeyRaw).ok).toBe(false);

    expect(registry.applyAttestation(attestation(attestorB, owner))).toBe(true);
    expect(registry.get(selfId)?.status).toBe("attested");
    expect(registry.authorize(selfId, owner.publicKeyRaw).ok).toBe(true);
  });

  it("can require attestation before authorizing data", async () => {
    const owner = generateIdentity();
    const attestor = generateIdentity();
    const registry = await createRegistry({
      requireAttestation: true,
      attestors: [attestor.publicKeyRaw.toString("hex")],
    });

    expect(registry.authorize(selfId, owner.publicKeyRaw).ok).toBe(false);
    expect(registry.applyAttestation(attestation(attestor, owner))).toBe(true);
    expect(registry.authorize(selfId, owner.publicKeyRaw).ok).toBe(true);
  });

  it("revokes a claim", async () => {
    const owner = generateIdentity();
    const attestor = generateIdentity();
    const registry = await createRegistry({
      attestors: [attestor.publicKeyRaw.toString("hex")],
    });

    registry.applyAttestation(attestation(attestor, owner));
    expect(registry.authorize(selfId, owner.publicKeyRaw).ok).toBe(true);

    const revocation = signClaim(
      {
        kind: "revoke",
        selfId,
        subjectKey: owner.publicKeyRaw,
        issuerKey: attestor.publicKeyRaw,
        issuedAt: 300,
        expiresAt: 0,
      },
      attestor,
    );
    expect(registry.applyRevocation(revocation)).toBe(true);
    expect(registry.authorize(selfId, owner.publicKeyRaw).ok).toBe(false);
  });

  it("revalidates attestation signatures, expiry and the current attestor set", async () => {
    const owner = generateIdentity();
    const attestor = generateIdentity();
    const directory = await mkdtemp(join(tmpdir(), "skp2p-registry-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "claims.json");
    let clock = 1000;

    const registry = new ClaimRegistry({
      path,
      attestors: [attestor.publicKeyRaw.toString("hex")],
      requireAttestation: true,
      now: () => clock,
    });
    await registry.load();
    expect(
      registry.applyAttestation(
        attestation(attestor, owner, { expiresAt: 2000 }),
      ),
    ).toBe(true);
    expect(registry.authorize(selfId, owner.publicKeyRaw).ok).toBe(true);

    clock = 3000;
    expect(registry.authorize(selfId, owner.publicKeyRaw).ok).toBe(false);
    await registry.flush();

    const noAttestors = new ClaimRegistry({
      path,
      attestors: [],
      requireAttestation: true,
      now: () => 1000,
    });
    await noAttestors.load();
    expect(noAttestors.authorize(selfId, owner.publicKeyRaw).ok).toBe(false);
  });

  it("rejects a tampered or future-dated attestation", async () => {
    const owner = generateIdentity();
    const attestor = generateIdentity();
    const registry = await createRegistry({
      attestors: [attestor.publicKeyRaw.toString("hex")],
    });

    const valid = attestation(attestor, owner);
    expect(
      registry.applyAttestation({
        ...valid,
        signature: Buffer.alloc(64),
      }),
    ).toBe(false);
    expect(
      registry.applyAttestation(
        attestation(attestor, owner, { issuedAt: 2000 }),
      ),
    ).toBe(false);
  });

  it("persists and reloads the binding", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skp2p-registry-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "claims.json");
    const owner = generateIdentity();

    const first = new ClaimRegistry({ path, now: () => 1000 });
    await first.load();
    first.authorize(selfId, owner.publicKeyRaw);
    await first.flush();

    const second = new ClaimRegistry({ path, now: () => 1000 });
    await second.load();
    expect(second.get(selfId)?.key).toBe(owner.publicKeyRaw.toString("hex"));
    expect(second.authorize(selfId, owner.publicKeyRaw).ok).toBe(true);
  });
});
