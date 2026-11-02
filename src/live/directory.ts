import { createHash } from "node:crypto";
import type { CapabilityRecord } from "./capability.js";

export interface PeerCapability extends CapabilityRecord {
  /** Hex-encoded source key of the advertiser. */
  key: string;
  /** Unix seconds when this record was received. */
  receivedAt: number;
}

export interface ElectionOptions {
  now: number;
  epochSeconds: number;
  minUptimeSeconds: number;
  /** Drop capabilities older than this. Default 120 s. */
  maxAgeSeconds?: number;
}

const DEFAULT_MAX_AGE_SECONDS = 120;
const MAX_WEIGHT = 16;

/**
 * A per-topic view of peer capabilities and a deterministic relay election.
 *
 * Election is weighted rendezvous hashing: every eligible peer gets `capacity`
 * virtual points per epoch, and the highest hash wins. Every peer with the same
 * view computes the same winner; the epoch changes the ranking so the role
 * rotates. No vote or coordinator is involved.
 */
export class PeerDirectory {
  private readonly peers = new Map<string, PeerCapability>();

  constructor(private readonly topic: Buffer) {}

  update(record: CapabilityRecord, sourceKey: Buffer, now: number): void {
    if (!record.topic.equals(this.topic)) return;
    const key = sourceKey.toString("hex");
    this.peers.set(key, {
      ...record,
      key,
      receivedAt: now,
    });
  }

  prune(now: number, maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS): void {
    for (const [key, peer] of this.peers) {
      if (now - peer.receivedAt > maxAgeSeconds) {
        this.peers.delete(key);
      }
    }
  }

  eligible(options: ElectionOptions): PeerCapability[] {
    const maxAge = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
    return [...this.peers.values()].filter((peer) => {
      if (!peer.relayConsent || !peer.reachable || !peer.unmetered) {
        return false;
      }
      if (peer.capacity < 1) return false;
      if (options.now - peer.receivedAt > maxAge) return false;
      if (peer.uptimeSince > options.now) return false;
      return options.now - peer.uptimeSince >= options.minUptimeSeconds;
    });
  }

  /** Eligible peers, best candidate first for the current epoch. */
  rank(options: ElectionOptions): PeerCapability[] {
    const epoch = Math.floor(options.now / Math.max(1, options.epochSeconds));
    const scored = this.eligible(options).map((peer) => ({
      peer,
      score: rendezvousScore(epoch, this.topic, peer.key, peer.capacity),
    }));
    scored.sort((a, b) => {
      if (a.score !== b.score) return a.score > b.score ? -1 : 1;
      return a.peer.key < b.peer.key ? -1 : a.peer.key > b.peer.key ? 1 : 0;
    });
    return scored.map((entry) => entry.peer);
  }

  elected(options: ElectionOptions): PeerCapability | undefined {
    return this.rank(options)[0];
  }

  snapshot(): PeerCapability[] {
    return [...this.peers.values()];
  }
}

function rendezvousScore(
  epoch: number,
  topic: Buffer,
  key: string,
  capacity: number,
): bigint {
  const weight = Math.min(MAX_WEIGHT, Math.max(1, capacity));
  const prefix = `${epoch}:${topic.toString("hex")}:${key}:`;
  let best = 0n;
  for (let index = 0; index < weight; index += 1) {
    const digest = createHash("sha256").update(`${prefix}${index}`).digest();
    const value = digest.readBigUInt64BE(0);
    if (value > best) best = value;
  }
  return best;
}
