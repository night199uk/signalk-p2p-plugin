import { describe, expect, it } from "vitest";
import type { CapabilityRecord } from "../src/live/capability.js";
import { PeerDirectory } from "../src/live/directory.js";

const topic = Buffer.alloc(32, 1);

interface Peer {
  key: Buffer;
  record: CapabilityRecord;
}

function peer(id: number, overrides: Partial<CapabilityRecord> = {}): Peer {
  const key = Buffer.alloc(32, id);
  return {
    key,
    record: {
      topic,
      selfId: `urn:mrn:signalk:uuid:peer-${id}`,
      updatedAt: 1000,
      uptimeSince: 0,
      relayConsent: true,
      reachable: true,
      unmetered: true,
      capacity: 1,
      load: 0,
      ...overrides,
    },
  };
}

const base = {
  now: 1000,
  epochSeconds: 600,
  minUptimeSeconds: 60,
};

function seed(directory: PeerDirectory, peers: Peer[], now = 1000): void {
  for (const entry of peers) {
    directory.update(entry.record, entry.key, now);
  }
}

describe("PeerDirectory", () => {
  it("elects deterministically from the same view", () => {
    const directory = new PeerDirectory(topic);
    seed(directory, [peer(1), peer(2), peer(3)]);

    const first = directory.elected(base);
    const second = directory.elected(base);
    expect(first?.key).toBe(second?.key);
    expect(first).toBeDefined();
  });

  it("rotates the elected peer across epochs", () => {
    const directory = new PeerDirectory(topic);
    const peers = [peer(1), peer(2), peer(3)];
    const winners = new Set<string>();

    for (let epoch = 0; epoch < 50; epoch += 1) {
      const now = 1000 + epoch * 600;
      seed(directory, peers, now);
      const elected = directory.elected({ ...base, now });
      if (elected) winners.add(elected.key);
    }

    expect(winners.size).toBeGreaterThan(1);
  });

  it("excludes peers that cannot relay or are metered", () => {
    const directory = new PeerDirectory(topic);
    seed(directory, [
      peer(1, { relayConsent: false }),
      peer(2, { reachable: false }),
      peer(3, { unmetered: false }),
      peer(4, { uptimeSince: 990 }),
    ]);

    expect(directory.eligible(base)).toHaveLength(0);
  });

  it("prefers higher-capacity peers over time", () => {
    const directory = new PeerDirectory(topic);
    const small = peer(1, { capacity: 1 });
    const large = peer(2, { capacity: 16 });
    let largeWins = 0;

    for (let epoch = 0; epoch < 100; epoch += 1) {
      const now = 1000 + epoch * 600;
      seed(directory, [small, large], now);
      if (
        directory.elected({ ...base, now })?.key === large.key.toString("hex")
      ) {
        largeWins += 1;
      }
    }

    expect(largeWins).toBeGreaterThan(50);
  });

  it("fails over when the elected peer stops being eligible", () => {
    const directory = new PeerDirectory(topic);
    const first = peer(1);
    const second = peer(2);
    seed(directory, [first, second]);

    const elected = directory.elected(base);
    expect(elected).toBeDefined();

    const winner = elected as { key: string };
    const winnerPeer =
      winner.key === first.key.toString("hex") ? first : second;
    directory.update(
      { ...winnerPeer.record, relayConsent: false },
      winnerPeer.key,
      1000,
    );
    const next = directory.elected(base);
    expect(next).toBeDefined();
    expect(next?.key).not.toBe(winner.key);
  });

  it("drops stale capabilities", () => {
    const directory = new PeerDirectory(topic);
    seed(directory, [peer(1)], 1000);
    expect(directory.eligible({ ...base, now: 2000 })).toHaveLength(0);
  });
});
