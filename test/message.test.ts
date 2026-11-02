import { describe, expect, it } from "vitest";
import { generateIdentity, verifyDetached } from "../src/identity.js";
import { decodeLiveMessages, encodeLiveMessage } from "../src/live/message.js";

const selfId = "urn:mrn:signalk:uuid:6b0e776f-811a-4b35-980e-b93405371bc5";

describe("live message codec", () => {
  it("signs and verifies a batch", () => {
    const identity = generateIdentity();
    const encoded = encodeLiveMessage(
      {
        sourceKey: identity.publicKeyRaw,
        selfId,
        records: [Buffer.from("one"), Buffer.from("two")],
      },
      { sign: (data) => identity.sign(data) },
    );
    const [decoded] = decodeLiveMessages(encoded);

    expect(decoded.sourceKey.equals(identity.publicKeyRaw)).toBe(true);
    expect(decoded.selfId).toBe(selfId);
    expect(decoded.records.map(String)).toEqual(["one", "two"]);
    expect(decoded.signature).toHaveLength(64);
    expect(
      verifyDetached(
        decoded.sourceKey,
        decoded.signedBytes as Buffer,
        decoded.signature as Buffer,
      ),
    ).toBe(true);
  });

  it("detects a tampered record", () => {
    const identity = generateIdentity();
    const encoded = encodeLiveMessage(
      {
        sourceKey: identity.publicKeyRaw,
        selfId,
        records: [Buffer.from("tamper-me")],
      },
      { sign: (data) => identity.sign(data) },
    );
    const tampered = Buffer.from(encoded);
    const index = tampered.indexOf(Buffer.from("tamper-me"));
    tampered[index] ^= 0xff;

    const [decoded] = decodeLiveMessages(tampered);
    expect(
      verifyDetached(
        decoded.sourceKey,
        decoded.signedBytes as Buffer,
        decoded.signature as Buffer,
      ),
    ).toBe(false);
  });

  it("supports an unsigned message but marks it", () => {
    const identity = generateIdentity();
    const encoded = encodeLiveMessage({
      sourceKey: identity.publicKeyRaw,
      selfId,
      records: [Buffer.from("x")],
    });
    const [decoded] = decodeLiveMessages(encoded);

    expect(decoded.signature).toBeUndefined();
    expect(decoded.signedBytes).toBeUndefined();
  });

  it("splits concatenated signed messages", () => {
    const firstIdentity = generateIdentity();
    const secondIdentity = generateIdentity();
    const first = encodeLiveMessage(
      {
        sourceKey: firstIdentity.publicKeyRaw,
        selfId: "first",
        records: [Buffer.from("1")],
      },
      { sign: (data) => firstIdentity.sign(data) },
    );
    const second = encodeLiveMessage(
      {
        sourceKey: secondIdentity.publicKeyRaw,
        selfId: "second",
        records: [Buffer.from("2")],
      },
      { sign: (data) => secondIdentity.sign(data) },
    );
    const decoded = decodeLiveMessages(Buffer.concat([first, second]));

    expect(decoded).toHaveLength(2);
    for (const message of decoded) {
      expect(
        verifyDetached(
          message.sourceKey,
          message.signedBytes as Buffer,
          message.signature as Buffer,
        ),
      ).toBe(true);
    }
  });

  it("rejects a truncated message", () => {
    const identity = generateIdentity();
    const encoded = encodeLiveMessage(
      {
        sourceKey: identity.publicKeyRaw,
        selfId,
        records: [Buffer.from("x")],
      },
      { sign: (data) => identity.sign(data) },
    );
    expect(() =>
      decodeLiveMessages(encoded.subarray(0, encoded.length - 1)),
    ).toThrow(/invalid message length/);
  });
});
