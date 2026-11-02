import { describe, expect, it } from "vitest";
import { generateIdentity } from "../src/identity.js";
import {
  decryptRecord,
  deriveDataKey,
  encryptRecord,
  groupDataTopic,
  groupRosterTopic,
  openEpochKey,
  sealEpochKey,
} from "../src/groups/crypto.js";

describe("group crypto", () => {
  it("seals an epoch key to a member and opens it", () => {
    const identity = generateIdentity();
    const epochKey = Buffer.alloc(32, 3);
    const sealed = sealEpochKey(epochKey, identity.boxPublicKey);

    expect(
      openEpochKey(
        sealed,
        identity.boxPublicKey,
        identity.boxSecretKey,
      )?.equals(epochKey),
    ).toBe(true);

    const stranger = generateIdentity();
    expect(
      openEpochKey(sealed, stranger.boxPublicKey, stranger.boxSecretKey),
    ).toBeUndefined();
  });

  it("encrypts and decrypts a record with the epoch data key", () => {
    const key = deriveDataKey(Buffer.alloc(32, 4));
    const ciphertext = encryptRecord(key, Buffer.from("secret"));

    expect(decryptRecord(key, ciphertext)?.toString()).toBe("secret");
    expect(
      decryptRecord(deriveDataKey(Buffer.alloc(32, 5)), ciphertext),
    ).toBeUndefined();
  });

  it("derives stable data and roster topics", () => {
    const epochKey = Buffer.alloc(32, 7);
    expect(groupDataTopic(epochKey).equals(groupDataTopic(epochKey))).toBe(
      true,
    );
    expect(
      groupRosterTopic(Buffer.alloc(32, 1)).equals(
        groupRosterTopic(Buffer.alloc(32, 2)),
      ),
    ).toBe(false);
  });
});
