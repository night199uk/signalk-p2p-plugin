import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateIdentity } from "../src/identity.js";
import { ALL_VESSELS_TOPIC } from "../src/live/topic.js";
import {
  DEFAULT_OPERATOR_FINGERPRINT,
  DEFAULT_OPERATOR_PUBLIC_KEY,
  effectivePolicy,
  loadShippedPolicy,
  saveCachedPolicy,
} from "../src/policy/operator.js";
import {
  decodePolicy,
  defaultPolicy,
  encodePolicy,
  signPolicy,
  verifyPolicy,
} from "../src/policy/policy.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("network policy", () => {
  it("ships a valid default signed by the pinned operator key", () => {
    const signed = loadShippedPolicy();
    expect(signed).toBeDefined();
    expect(signed?.policy.topic).toBe(ALL_VESSELS_TOPIC);
    expect(signed?.policy.version).toBeGreaterThanOrEqual(1);
    expect(
      createHash("sha256")
        .update(Buffer.from(DEFAULT_OPERATOR_PUBLIC_KEY, "hex"))
        .digest("hex"),
    ).toBe(DEFAULT_OPERATOR_FINGERPRINT);
  });

  it("signs, encodes and verifies a policy", () => {
    const identity = generateIdentity();
    const signed = signPolicy(defaultPolicy(2, 1000), identity);
    const key = identity.publicKeyRaw.toString("hex");
    expect(verifyPolicy(signed, [key], ALL_VESSELS_TOPIC, 1000)).toBe(true);
    expect(verifyPolicy(signed, [key], "signalk-p2p/other/v1", 1000)).toBe(
      false,
    );

    const decoded = decodePolicy(encodePolicy(signed));
    expect(decoded.policy.version).toBe(2);
    expect(verifyPolicy(decoded, [key], ALL_VESSELS_TOPIC, 1000)).toBe(true);
  });

  it("rejects tampered, expired and wrong-protocol policies", () => {
    const identity = generateIdentity();
    const key = identity.publicKeyRaw.toString("hex");
    const signed = signPolicy(defaultPolicy(2, 1000), identity);

    const tampered = structuredClone(signed);
    tampered.policy.rates.maxSnapshotHzUnderway = 5;
    expect(verifyPolicy(tampered, [key], ALL_VESSELS_TOPIC, 1000)).toBe(false);

    const expired = signPolicy(
      { ...defaultPolicy(3, 1000), notAfter: 900 },
      identity,
    );
    expect(verifyPolicy(expired, [key], ALL_VESSELS_TOPIC, 1000)).toBe(false);

    const wrongProtocol = signPolicy(
      { ...defaultPolicy(4, 1000), protocol: 99 },
      identity,
    );
    expect(verifyPolicy(wrongProtocol, [key], ALL_VESSELS_TOPIC, 1000)).toBe(
      false,
    );
  });

  it("prefers a newer cached policy at startup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skp2p-policy-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const identity = generateIdentity();
    const key = identity.publicKeyRaw.toString("hex");
    const signed = signPolicy(defaultPolicy(7, 1000), identity);
    saveCachedPolicy(directory, signed);
    const effective = effectivePolicy(directory, [key]);
    expect(effective.version).toBe(7);
  });
});
