import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALL_VESSELS_TOPIC } from "../live/topic.js";

/** Configuration for the standalone Node.js peer (VPS relay / aggregator). */
export interface PeerConfig {
  /** Where the instance Ed25519 key is stored. */
  dataDir: string;
  /** Human-readable network name; hashed into the 32-byte Hyperswarm topic. */
  topic: string;
  /** Coalesce forwarded batches for this long. */
  batchIntervalMs: number;
  /** Flush early when the pending queue reaches this size. */
  maxBatchBytes: number;
  /** Recent batches replayed to peers that join late. */
  historyBatches: number;
  /** Optional DHT port (UDP), useful for VPS firewall rules. */
  port?: number;
  /** Group invite tokens; each group is joined and relayed. */
  groupInvites: string[];
  /** Signed network-policy file to publish periodically. */
  policyFile?: string;
}

export interface PeerConfigOverrides {
  config?: string;
  dataDir?: string;
  topic?: string;
  batchIntervalMs?: number;
  maxBatchBytes?: number;
  historyBatches?: number;
  port?: number;
  groupInvites?: string[];
  policyFile?: string;
}

export const DEFAULT_PEER_CONFIG: PeerConfig = {
  dataDir: process.env.SKP2P_DATA_DIR ?? resolve("data"),
  topic: process.env.SKP2P_TOPIC ?? ALL_VESSELS_TOPIC,
  batchIntervalMs: 2000,
  maxBatchBytes: 64 * 1024,
  historyBatches: 10,
  groupInvites: [],
};

export function loadPeerConfig(
  overrides: PeerConfigOverrides = {},
): PeerConfig {
  const fromFile = overrides.config
    ? parseConfigFile(overrides.config)
    : ({} as Partial<PeerConfig>);

  const fromOverrides: Partial<PeerConfig> = {};
  assign(fromOverrides, "dataDir", overrides.dataDir);
  assign(fromOverrides, "topic", overrides.topic);
  assign(fromOverrides, "batchIntervalMs", overrides.batchIntervalMs);
  assign(fromOverrides, "maxBatchBytes", overrides.maxBatchBytes);
  assign(fromOverrides, "historyBatches", overrides.historyBatches);
  assign(fromOverrides, "port", overrides.port);
  assign(fromOverrides, "groupInvites", overrides.groupInvites);
  assign(fromOverrides, "policyFile", overrides.policyFile);

  const config: PeerConfig = {
    ...DEFAULT_PEER_CONFIG,
    ...fromFile,
    ...fromOverrides,
    dataDir: resolve(
      fromOverrides.dataDir ?? fromFile.dataDir ?? DEFAULT_PEER_CONFIG.dataDir,
    ),
  };
  validate(config);
  return config;
}

function parseConfigFile(path: string): Partial<PeerConfig> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("peer config: expected a JSON object");
  }
  return parsed as Partial<PeerConfig>;
}

function assign<K extends keyof PeerConfig>(
  target: Partial<PeerConfig>,
  key: K,
  value: PeerConfig[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function validate(config: PeerConfig): void {
  if (typeof config.dataDir !== "string" || config.dataDir.length === 0) {
    throw new Error("peer config: dataDir is required");
  }
  if (typeof config.topic !== "string" || config.topic.length === 0) {
    throw new Error("peer config: topic is required");
  }
  if (!Number.isFinite(config.batchIntervalMs) || config.batchIntervalMs < 0) {
    throw new Error("peer config: batchIntervalMs must be >= 0");
  }
  if (!Number.isInteger(config.maxBatchBytes) || config.maxBatchBytes <= 0) {
    throw new Error("peer config: maxBatchBytes must be a positive integer");
  }
  if (!Number.isInteger(config.historyBatches) || config.historyBatches < 0) {
    throw new Error(
      "peer config: historyBatches must be a non-negative integer",
    );
  }
  if (
    config.port !== undefined &&
    (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535)
  ) {
    throw new Error("peer config: port must be between 0 and 65535");
  }
  if (
    !Array.isArray(config.groupInvites) ||
    config.groupInvites.some((invite) => typeof invite !== "string")
  ) {
    throw new Error("peer config: groupInvites must be an array of strings");
  }
  if (
    config.policyFile !== undefined &&
    (typeof config.policyFile !== "string" || config.policyFile.length === 0)
  ) {
    throw new Error("peer config: policyFile must be a non-empty string");
  }
}
