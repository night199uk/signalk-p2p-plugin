import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateIdentity, verifyDetached } from "../src/identity.js";

const directories: string[] = [];

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "skp2p-identity-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("identity", () => {
  it("creates, persists and reloads the same key", async () => {
    const directory = await tempDir();
    const first = await loadOrCreateIdentity(directory);
    const second = await loadOrCreateIdentity(directory);

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.publicKeyRaw.equals(first.publicKeyRaw)).toBe(true);
    expect(first.publicKeyRaw).toHaveLength(32);
  });

  it("signs and verifies, and rejects a tampered message", async () => {
    const directory = await tempDir();
    const identity = await loadOrCreateIdentity(directory);
    const message = Buffer.from("hello p2p");
    const signature = identity.sign(message);

    expect(identity.verify(message, signature)).toBe(true);
    expect(verifyDetached(identity.publicKeyRaw, message, signature)).toBe(
      true,
    );
    expect(identity.verify(Buffer.from("tampered"), signature)).toBe(false);
  });
});
