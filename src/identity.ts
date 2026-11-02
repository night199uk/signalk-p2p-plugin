import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sodium from "sodium-universal";

/** The durable cryptographic identity of a Signal K instance. */
export interface Identity {
  /** SPKI PEM, for display/export only. */
  readonly publicKeyPem: string;
  /** Raw 32-byte Ed25519 public key. */
  readonly publicKeyRaw: Buffer;
  /** SHA-256 of the raw public key, hex. */
  readonly fingerprint: string;
  /** X25519 public key (32 bytes), used to seal group epoch keys. */
  readonly boxPublicKey: Buffer;
  /** X25519 secret key (32 bytes). */
  readonly boxSecretKey: Buffer;
  sign(message: Buffer): Buffer;
  verify(message: Buffer, signature: Buffer): boolean;
}

const KEY_FILE = "ed25519.pem";

/**
 * Load the instance identity from `<dataDir>/identity/ed25519.pem`, creating it
 * on first use. The private key is written with mode 0600.
 */
export async function loadOrCreateIdentity(dataDir: string): Promise<Identity> {
  const directory = join(dataDir, "identity");
  const keyPath = join(directory, KEY_FILE);
  const boxSeedPath = join(directory, "x25519.seed");
  await mkdir(directory, { recursive: true, mode: 0o700 });

  let privatePem: string;
  try {
    privatePem = await readFile(keyPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    const { privateKey } = generateKeyPairSync("ed25519");
    privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await writeFile(keyPath, privatePem, { mode: 0o600 });
    await chmod(keyPath, 0o600);
  }

  let boxSeed: Buffer;
  try {
    boxSeed = await readFile(boxSeedPath);
    if (boxSeed.length !== 32) {
      throw new Error("identity: x25519 seed must be 32 bytes");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    boxSeed = randomBytes(32);
    await writeFile(boxSeedPath, boxSeed, { mode: 0o600 });
    await chmod(boxSeedPath, 0o600);
  }

  return identityFromPrivatePem(privatePem, boxSeed);
}

/** Generate a fresh in-memory identity (tests, smoke clients). */
export function generateIdentity(): Identity {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return identityFromPrivatePem(pem);
}

export function identityFromPrivatePem(
  privatePem: string,
  boxSeed?: Buffer,
): Identity {
  const privateKey = createPrivateKey(privatePem);
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const der = publicKey.export({ type: "spki", format: "der" });
  // Ed25519 SPKI is a fixed 12-byte header followed by the 32-byte key.
  const publicKeyRaw = Buffer.from(der.subarray(der.length - 32));
  const fingerprint = createHash("sha256").update(publicKeyRaw).digest("hex");

  const boxPublicKey = Buffer.alloc(sodium.crypto_box_PUBLICKEYBYTES);
  const boxSecretKey = Buffer.alloc(sodium.crypto_box_SECRETKEYBYTES);
  if (boxSeed) {
    sodium.crypto_box_seed_keypair(boxPublicKey, boxSecretKey, boxSeed);
  } else {
    sodium.crypto_box_keypair(boxPublicKey, boxSecretKey);
  }

  return {
    publicKeyPem,
    publicKeyRaw,
    fingerprint,
    boxPublicKey,
    boxSecretKey,
    sign: (message) => sign(null, message, privateKey),
    verify: (message, signature) => verify(null, message, publicKey, signature),
  };
}

/** Verify a detached Ed25519 signature with a raw 32-byte public key. */
export function verifyDetached(
  publicKeyRaw: Buffer,
  message: Buffer,
  signature: Buffer,
): boolean {
  const publicKey = createPublicKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: publicKeyRaw.toString("base64url"),
    },
    format: "jwk",
  });
  return verify(null, message, publicKey, signature);
}
