import createTestnet from "@hyperswarm/testnet";
import Hyperswarm from "hyperswarm";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { encodeEnvelope } from "../src/data/envelope.js";
import { encodeSnapshot } from "../src/data/snapshot.js";

interface SwarmConnection {
  write(chunk: Buffer): boolean;
  on(event: "data", listener: (chunk: Buffer) => void): void;
  off(event: "data", listener: (chunk: Buffer) => void): void;
}

export interface SwarmResult {
  connectionMs: number;
  messages: number;
  appBytesSent: number;
  appBytesReceived: number;
  idleMs: number;
  idleAppBytes: number;
}

const message = encodeEnvelope(
  "snapshot",
  encodeSnapshot({
    timestamp: 1_765_000_000,
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

/**
 * Connect two peers over a local HyperDHT testnet and exchange snapshots.
 *
 * This measures application bytes and connection setup. It cannot see the raw
 * DHT/keepalive bytes from inside the process; measure those at the OS level if
 * an exact idle figure is required.
 */
export async function swarmSpike(
  options: { messages?: number; idleMs?: number } = {},
): Promise<SwarmResult> {
  const messages = options.messages ?? 100;
  const idleMs = options.idleMs ?? 5000;
  const testnet = await createTestnet(3);
  const swarmA = new Hyperswarm({ bootstrap: testnet.bootstrap });
  const swarmB = new Hyperswarm({ bootstrap: testnet.bootstrap });

  try {
    const topic = createHash("sha256").update("signalk-p2p-spike").digest();

    swarmA.join(topic, { server: true, client: true });
    swarmB.join(topic, { server: true, client: true });

    const started = Date.now();
    const connection = await new Promise<SwarmConnection>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              "no peer connection within 15s (DHT discovery is unavailable " +
                "in this environment; run this on a host with UDP/DHT access)",
            ),
          ),
        15_000,
      );
      swarmB.once("connection", (conn: SwarmConnection) => {
        clearTimeout(timer);
        resolve(conn);
      });
    });
    const connectionMs = Date.now() - started;

    let received = 0;
    const receivedAll = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("messages did not arrive")),
        15_000,
      );
      const onData = (chunk: Buffer) => {
        received += chunk.length;
        if (received >= message.length * messages) {
          clearTimeout(timer);
          connection.off("data", onData);
          resolve();
        }
      };
      connection.on("data", onData);
    });

    for (let index = 0; index < messages; index += 1) {
      connection.write(message);
    }
    await receivedAll;

    let idleAppBytes = 0;
    const onIdleData = (chunk: Buffer) => {
      idleAppBytes += chunk.length;
    };
    connection.on("data", onIdleData);
    await new Promise((resolve) => setTimeout(resolve, idleMs));
    connection.off("data", onIdleData);

    return {
      connectionMs,
      messages,
      appBytesSent: message.length * messages,
      appBytesReceived: received,
      idleMs,
      idleAppBytes,
    };
  } finally {
    await swarmA.destroy();
    await swarmB.destroy();
    await testnet.destroy();
  }
}

export function formatSwarmReport(result: SwarmResult): string {
  return [
    "Hyperswarm testnet (two peers)",
    "------------------------------",
    `connection setup:       ${result.connectionMs} ms`,
    `messages:               ${result.messages}`,
    `application bytes out:  ${result.appBytesSent}`,
    `application bytes in:   ${result.appBytesReceived}`,
    `idle window:            ${result.idleMs} ms`,
    `idle application bytes: ${result.idleAppBytes}`,
    "",
    "Note: raw DHT and Noise/UDX keepalive bytes are not visible from inside",
    "the process. The idle figure is an application-level floor; measure the",
    "transport at the OS level for an exact per-month number.",
  ].join("\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  swarmSpike()
    .then((result) => console.log(formatSwarmReport(result)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
