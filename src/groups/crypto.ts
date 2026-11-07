import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import sodium from "sodium-universal";

function digest(...parts: string[]): Buffer {
  return createHash("sha256").update(parts.join("\u0000")).digest();
}

export function groupInviteTopic(code: string): Buffer {
  return digest("signalk-p2p/group/invite", code);
}

export function groupRosterTopic(groupId: Buffer): Buffer {
  return digest("signalk-p2p/group/roster", groupId.toString("hex"));
}

export function groupDataTopic(epochKey: Buffer): Buffer {
  return digest("signalk-p2p/group/data", epochKey.toString("hex"));
}

export function deriveDataKey(epochKey: Buffer): Buffer {
  return digest("signalk-p2p/group/key", epochKey.toString("hex"));
}

export function sealEpochKey(epochKey: Buffer, boxPublicKey: Buffer): Buffer {
  if (boxPublicKey.length !== sodium.crypto_box_PUBLICKEYBYTES) {
    throw new Error("group: boxPublicKey must be 32 bytes");
  }
  const out = Buffer.alloc(sodium.crypto_box_SEALBYTES + epochKey.length);
  sodium.crypto_box_seal(out, epochKey, boxPublicKey);
  return out;
}

export function openEpochKey(
  sealed: Buffer,
  boxPublicKey: Buffer,
  boxSecretKey: Buffer,
): Buffer | undefined {
  if (sealed.length <= sodium.crypto_box_SEALBYTES) return undefined;
  const out = Buffer.alloc(sealed.length - sodium.crypto_box_SEALBYTES);
  return sodium.crypto_box_seal_open(out, sealed, boxPublicKey, boxSecretKey)
    ? out
    : undefined;
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM: nonce || tag || ciphertext. */
export function encryptRecord(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

export function decryptRecord(key: Buffer, data: Buffer): Buffer | undefined {
  if (data.length < NONCE_BYTES + TAG_BYTES) return undefined;
  const nonce = data.subarray(0, NONCE_BYTES);
  const tag = data.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const ciphertext = data.subarray(NONCE_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return undefined;
  }
}
