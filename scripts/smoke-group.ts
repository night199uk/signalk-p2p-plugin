/**
 * End-to-end private group smoke test over the public DHT.
 *
 * A creates a group, invites B, approves B's join request, sends an encrypted
 * data record, then removes B and rekeys. Run with: npm run smoke:group
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeEnvelope, encodeEnvelope } from "../src/data/envelope.js";
import { decodeValues, encodeValues } from "../src/data/values.js";
import { GroupManager } from "../src/groups/manager.js";
import { generateIdentity } from "../src/identity.js";
import type { LiveMessage } from "../src/live/message.js";

const A_ID = "urn:mrn:signalk:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B_ID = "urn:mrn:signalk:uuid:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const log = {
  info: (message: string) => console.log(`[group] ${message}`),
  error: (message: string) => console.error(`[group] ${message}`),
  debug: () => {},
};

async function waitFor<T>(
  predicate: () => T | undefined,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${label}`);
}

const dirA = await mkdtemp(join(tmpdir(), "skp2p-group-a-"));
const dirB = await mkdtemp(join(tmpdir(), "skp2p-group-b-"));
const received: LiveMessage[] = [];

const owner = new GroupManager({
  dataDir: dirA,
  identity: generateIdentity(),
  selfId: A_ID,
  log,
  onData: (groupId, message) =>
    console.log(
      `[A] data on group ${groupId.slice(0, 8)}: ${message.records.length} record(s)`,
    ),
});
const joiner = new GroupManager({
  dataDir: dirB,
  identity: generateIdentity(),
  selfId: B_ID,
  log,
  onData: (groupId, message) => {
    console.log(
      `[B] data on group ${groupId.slice(0, 8)}: ${message.records.length} record(s)`,
    );
    received.push(message);
  },
});

try {
  await owner.load();
  await joiner.load();
  await owner.start();
  await joiner.start();

  const group = await owner.createGroup("Smoke Group");
  const token = owner.createInvite(group.id, "member");
  await joiner.join(token, "123456789");
  console.log("B joined locally; waiting for its join request at the owner");

  const pending = await waitFor(
    () => owner.requests().find((entry) => entry.groupId === group.id),
    45_000,
    "join request",
  );
  await owner.approveJoin(
    group.id,
    pending.request.inviteNonce,
    "member",
    "123456789",
  );
  console.log("owner approved B");

  await waitFor(
    () =>
      joiner
        .list()
        .find(
          (entry) =>
            entry.id === group.id && entry.members === 2 && !entry.removed,
        ),
    30_000,
    "B to receive the roster",
  );
  console.log("B is a member with a decrypted epoch key");

  owner.enqueueData(
    group.id,
    encodeEnvelope(
      "values",
      encodeValues({ "environment.depth.belowSurface": 12.3 }),
    ),
  );
  const message = await waitFor(
    () => received.find((entry) => entry.selfId === A_ID),
    30_000,
    "encrypted group data",
  );
  const values = message.records
    .map((record) => {
      const envelope = decodeEnvelope(record);
      return envelope.type === "values"
        ? decodeValues(envelope.payload)
        : undefined;
    })
    .filter((value): value is Record<string, unknown> => Boolean(value));
  console.log("B decrypted:", JSON.stringify(values));

  await owner.removeMember(group.id, B_ID);
  await waitFor(
    () => joiner.list().find((entry) => entry.id === group.id && entry.removed),
    30_000,
    "B to be removed",
  );
  console.log("B was removed and its clients stopped");
  console.log("GROUP SMOKE OK");
} finally {
  await owner.stop();
  await joiner.stop();
  await rm(dirA, { recursive: true, force: true });
  await rm(dirB, { recursive: true, force: true });
}

process.exit(0);
