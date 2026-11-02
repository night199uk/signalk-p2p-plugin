import { describe, expect, it } from "vitest";
import {
  decodeCapability,
  encodeCapability,
  type CapabilityRecord,
} from "../src/live/capability.js";

const topic = Buffer.alloc(32, 7);

const record: CapabilityRecord = {
  topic,
  selfId: "urn:mrn:signalk:uuid:6b0e776f-811a-4b35-980e-b93405371bc5",
  updatedAt: 1_765_000_000,
  uptimeSince: 1_764_000_000,
  relayConsent: true,
  reachable: true,
  unmetered: true,
  capacity: 10,
  load: 5,
};

describe("capability codec", () => {
  it("round-trips a capability record", () => {
    const decoded = decodeCapability(encodeCapability(record));
    expect(decoded).toEqual(record);
  });

  it("rejects a topic that is not 32 bytes", () => {
    expect(() =>
      encodeCapability({ ...record, topic: Buffer.alloc(16) }),
    ).toThrow(/32 bytes/);
  });

  it("rejects a truncated record", () => {
    const encoded = encodeCapability(record);
    expect(() =>
      decodeCapability(encoded.subarray(0, encoded.length - 1)),
    ).toThrow(/truncated/);
  });
});
