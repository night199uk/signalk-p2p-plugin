#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { GroupManager } from "../groups/manager.js";
import { loadOrCreateIdentity } from "../identity.js";
import { RelayHub } from "../live/relay.js";
import { networkTopic } from "../live/topic.js";
import { loadPeerConfig } from "./config.js";

const USAGE = `
signalk-p2p-peer — standalone Signal K P2P peer / relay

Usage:
  signalk-p2p-peer [options]

Options:
  -c, --config <file>        JSON config file
      --data-dir <dir>       identity data directory (default: ./data)
      --topic <name>         network name (default: signalk-p2p/all-vessels/v1)
      --batch-interval <ms>  coalesce batches for this long (default: 2000)
      --history <n>          recent batches replayed to new peers (default: 10)
      --port <n>             DHT UDP port (useful for firewall rules)
      --group-invite <token> join and relay a private group (repeatable)
  -v, --version              show the version
  -h, --help                 show this help

The peer is an ordinary Hyperswarm peer. It joins the public network as a
server and relays opaque batches between boats. It is intended to be run on an
always-on host (a VPS, a marina server, or a well-connected boat) so clients
behind CGNAT can reach the mesh. It is not a central authority: it cannot forge
signed records and can be replaced by an elected peer.
`.trim();

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: "string", short: "c" },
      "data-dir": { type: "string" },
      topic: { type: "string" },
      "batch-interval": { type: "string" },
      history: { type: "string" },
      port: { type: "string" },
      "group-invite": { type: "string", multiple: true },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.version) {
    console.log(`signalk-p2p-peer ${packageVersion()}`);
    return;
  }

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const config = loadPeerConfig({
    config: asString(values.config),
    dataDir: asString(values["data-dir"]),
    topic: asString(values.topic),
    batchIntervalMs: asNumber(values["batch-interval"]),
    historyBatches: asNumber(values.history),
    port: asNumber(values.port),
    groupInvites: Array.isArray(values["group-invite"])
      ? (values["group-invite"] as string[])
      : undefined,
  });

  const identity = await loadOrCreateIdentity(config.dataDir);
  const hub = new RelayHub({
    identity,
    topic: networkTopic(config.topic),
    batchIntervalMs: config.batchIntervalMs,
    maxBatchBytes: config.maxBatchBytes,
    historyBatches: config.historyBatches,
    port: config.port,
    log: {
      info: (message) => console.log(`[signalk-p2p] ${message}`),
      error: (message) => console.error(`[signalk-p2p] ${message}`),
      debug:
        process.env.DEBUG !== undefined
          ? (message) => console.log(`[signalk-p2p] ${message}`)
          : undefined,
    },
  });

  await hub.start();
  console.log(
    `[signalk-p2p] peer ${identity.fingerprint.slice(0, 12)} ` +
      `relaying "${config.topic}" ` +
      `(batch ${config.batchIntervalMs} ms, history ${config.historyBatches})`,
  );

  const groups = new GroupManager({
    dataDir: config.dataDir,
    identity,
    selfId: `urn:mrn:signalk:p2p:peer:${identity.fingerprint}`,
    onData: () => {},
    log: {
      info: (message) => console.log(`[signalk-p2p] ${message}`),
      error: (message) => console.error(`[signalk-p2p] ${message}`),
    },
  });
  await groups.load();
  await groups.start();
  for (const token of config.groupInvites) {
    try {
      const group = await groups.join(token);
      await groups.setRelay(group.id, true);
      console.log(
        `[signalk-p2p] relaying group "${group.name}" ` +
          `(${group.id.slice(0, 8)}…)`,
      );
    } catch (error) {
      console.error(`[signalk-p2p] group invite failed: ${String(error)}`);
    }
  }

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    console.log(
      `[signalk-p2p] stopping on ${signal} ` +
        `(${hub.peerCount} peers, ${hub.forwardedBatches} batches)`,
    );
    await groups.stop();
    await hub.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

function packageVersion(): string {
  const path = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../package.json",
  );
  return (JSON.parse(readFileSync(path, "utf8")) as { version: string })
    .version;
}

function asString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: string | boolean | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
