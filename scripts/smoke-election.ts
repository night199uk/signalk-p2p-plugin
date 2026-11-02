/**
 * Connect to the mesh, collect capability advertisements, and print the
 * deterministic elected relay for the current epoch.
 *
 * Run against the deployed VPS relay with: npm run smoke:election
 */
import { randomUUID } from "node:crypto";
import { decodeEnvelope } from "../src/data/envelope.js";
import { generateIdentity } from "../src/identity.js";
import { decodeCapability } from "../src/live/capability.js";
import { LiveClient } from "../src/live/client.js";
import { PeerDirectory } from "../src/live/directory.js";
import { ALL_VESSELS_TOPIC, networkTopic } from "../src/live/topic.js";

const topic = networkTopic(ALL_VESSELS_TOPIC);
const directory = new PeerDirectory(topic);
const identity = generateIdentity();

let resolveEligible: (() => void) | undefined;
const gotEligible = new Promise<void>((resolve) => {
  resolveEligible = resolve;
});

const client = new LiveClient({
  identity,
  selfId: `urn:mrn:signalk:uuid:${randomUUID()}`,
  topic,
  batchIntervalMs: 2000,
  log: {
    info: (message) => console.log(`[election] ${message}`),
    error: (message) => console.error(`[election] ${message}`),
    debug: () => {},
  },
});

client.onMessage((message) => {
  for (const record of message.records) {
    try {
      const envelope = decodeEnvelope(record);
      if (envelope.type !== "capability") continue;
      const capability = decodeCapability(envelope.payload);
      const now = Math.floor(Date.now() / 1000);
      directory.update(capability, message.sourceKey, now);
      if (
        directory.eligible({
          now,
          epochSeconds: 600,
          minUptimeSeconds: 0,
        }).length > 0
      ) {
        resolveEligible?.();
      }
      console.log(
        `capability ${capability.selfId.slice(0, 30)}… ` +
          `relay=${capability.relayConsent} ` +
          `reachable=${capability.reachable} ` +
          `unmetered=${capability.unmetered} ` +
          `capacity=${capability.capacity}`,
      );
    } catch {
      // ignore malformed records
    }
  }
});

await client.start();
await Promise.race([
  gotEligible,
  new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error("no eligible capability within 30s")),
      30_000,
    ),
  ),
]);
await new Promise((resolve) => setTimeout(resolve, 500));

const now = Math.floor(Date.now() / 1000);
const options = { now, epochSeconds: 600, minUptimeSeconds: 0 };
const eligible = directory.eligible(options);
const elected = directory.elected(options);

console.log(`eligible peers: ${eligible.length}`);
if (elected) {
  console.log(
    `elected peer: ${elected.selfId} (${elected.key.slice(0, 8)}…) ` +
      `capacity=${elected.capacity}`,
  );
}

await client.stop();
process.exit(elected ? 0 : 1);
