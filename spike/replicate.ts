import NoiseSecretStream from "@hyperswarm/secret-stream";
import Corestore from "corestore";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { encodeEnvelope } from "../src/data/envelope.js";
import { encodeSnapshot } from "../src/data/snapshot.js";

export interface ReplicationResult {
  batchSize: number;
  snapshots: number;
  blocks: number;
  payloadBytes: number;
  wireBytes: number;
  overheadBytes: number;
  overheadRatio: number;
  perBlockWireBytes: number;
  perSnapshotWireBytes: number;
}

export interface ReplicationOptions {
  snapshots?: number;
  batchSize?: number;
}

const baseTimestamp = 1_765_000_000;

function sampleSnapshot(index: number): Buffer {
  return encodeEnvelope(
    "snapshot",
    encodeSnapshot({
      timestamp: baseTimestamp + index,
      latitude: 50.7123456,
      longitude: -1.9876543,
      courseOverGround: 2.154,
      speedOverGround: 5.12,
      heading: 2.094,
      navState: "under way using engine",
      gnssQuality: "RTK fixed integer",
      mmsi: 232001234,
      underway: true,
    }),
  );
}

function sampleBatch(start: number, count: number): Buffer {
  const snapshots: Buffer[] = [];
  for (let index = 0; index < count; index += 1) {
    snapshots.push(sampleSnapshot(start + index));
  }
  return Buffer.concat(snapshots);
}

/**
 * Replicate batched generation blocks between two Corestores over a direct,
 * encrypted TCP connection (a Noise SecretStream, the framing Hyperswarm uses).
 *
 * A batch is simply concatenated envelopes; a real implementation would use a
 * batch record, but the size is the same. This measures the amortisation of
 * Hypercore's per-block Merkle/signature overhead.
 */
export async function replicationSpike(
  options: ReplicationOptions = {},
): Promise<ReplicationResult> {
  const snapshots = options.snapshots ?? 1000;
  const batchSize = Math.max(1, options.batchSize ?? 1);
  const blocks = Math.ceil(snapshots / batchSize);

  const dirA = await mkdtemp(join(tmpdir(), "skp2p-replicate-a-"));
  const dirB = await mkdtemp(join(tmpdir(), "skp2p-replicate-b-"));
  const storeA = new Corestore(dirA);
  const storeB = new Corestore(dirB);
  let server: net.Server | undefined;
  let socket: net.Socket | undefined;

  try {
    const coreA = storeA.get({ name: "vessel" });
    await coreA.ready();
    const coreB = storeB.get({ key: coreA.key });
    await coreB.ready();

    server = net.createServer((incoming) => {
      const noise = new NoiseSecretStream(false, incoming);
      storeB.replicate(noise);
    });
    await new Promise<void>((resolve, reject) => {
      server!.listen(0, "127.0.0.1", () => resolve());
      server!.once("error", reject);
    });
    const address = server.address() as net.AddressInfo;
    socket = net.connect(address.port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket!.once("connect", () => resolve());
      socket!.once("error", reject);
    });

    const noise = new NoiseSecretStream(true, socket);
    storeA.replicate(noise);
    await noise.opened;

    let payloadBytes = 0;
    for (let block = 0; block < blocks; block += 1) {
      const start = block * batchSize;
      const count = Math.min(batchSize, snapshots - start);
      const payload = sampleBatch(start, count);
      payloadBytes += payload.length;
      await coreA.append(payload);
    }

    const deadline = Date.now() + 60_000;
    while (coreB.length < blocks) {
      if (Date.now() > deadline) {
        throw new Error(
          `replication stalled at ${coreB.length}/${blocks} blocks`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const range = coreB.download({ start: 0, end: blocks });
    await Promise.race([
      range.done(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("range download did not complete")),
          60_000,
        ),
      ),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 250));

    const wireBytes = noise.rawBytesRead + noise.rawBytesWritten;
    const overheadBytes = wireBytes - payloadBytes;

    return {
      batchSize,
      snapshots,
      blocks,
      payloadBytes,
      wireBytes,
      overheadBytes,
      overheadRatio: wireBytes / payloadBytes,
      perBlockWireBytes: wireBytes / blocks,
      perSnapshotWireBytes: wireBytes / snapshots,
    };
  } finally {
    socket?.destroy();
    server?.close();
    await storeA.close();
    await storeB.close();
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
}

export function formatReplicationTable(results: ReplicationResult[]): string {
  const lines = [
    "Hypercore replication over an encrypted stream (Noise + TCP)",
    "------------------------------------------------------------",
    "snapshots  batch  blocks  payload   wire      wire/snapshot  overhead",
  ];
  for (const result of results) {
    lines.push(
      [
        String(result.snapshots).padEnd(10),
        String(result.batchSize).padEnd(6),
        String(result.blocks).padEnd(7),
        `${result.payloadBytes}`.padEnd(9),
        `${result.wireBytes}`.padEnd(9),
        `${result.perSnapshotWireBytes.toFixed(1)} B`.padEnd(14),
        `${(result.overheadRatio * 100).toFixed(0)}%`,
      ].join(" "),
    );
  }
  lines.push(
    "",
    "Note: includes Noise and Hypercore framing. Excludes DHT announcements and",
    "transport keepalive. Batching is essential: per-block overhead dominates",
    "for one-snapshot blocks.",
  );
  return lines.join("\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const results: ReplicationResult[] = [];
  for (const batchSize of [1, 5, 10, 50, 100]) {
    results.push(await replicationSpike({ snapshots: 1000, batchSize }));
  }
  console.log(formatReplicationTable(results));
}
