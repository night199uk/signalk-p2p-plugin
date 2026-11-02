# signalk-p2p — spike findings

**Status:** measured. These are the first numbers from the v1 spike, and one of
them changes the live-plane design.

Date: 2026-10-19. Node 22.18.0. Measured with `npm run spike` on a local machine.

---

## 1. What was measured

- **Payload sizes** from the real codecs (`src/data/`).
- **Hypercore replication wire cost** over an encrypted `NoiseSecretStream` to a
  separate Corestore on localhost. This includes Noise + Hypercore framing, so it
  is the realistic per-block cost (minus DHT/keepalive).
- **Batching**: the same 1,000 snapshots written as blocks containing 1, 5, 10,
  50 or 100 concatenated snapshots.

**Not yet measured:** DHT discovery and idle keepalive, hole-punching, relay
fallback. The local HyperDHT testnet did not complete announce/lookup in this
sandbox, so those remain a manual test on a host with UDP/DHT access.

---

## 2. Payload sizes

| Record                           | Wire bytes | JSON for comparison |
| -------------------------------- | ---------- | ------------------- |
| Snapshot (position + navigation) | **31 B**   | ~236 B              |
| Static (identity/dimensions)     | **103 B**  | —                   |
| Values (environment/tanks, CBOR) | **194 B**  | ~181 B              |

Findings:

- The fixed-layout snapshot is ~7.6× smaller than the equivalent JSON. Good.
- **CBOR was larger than JSON** for a small values map, because the long Signal K
  path keys dominate. A protocol path-id dictionary is the right next step for the
  `Values` record; CBOR alone does not buy compactness here.

---

## 3. Hypercore replication and batching

1,000 snapshots (31 B each), replicated over an encrypted stream:

| Snapshots per block | Blocks | Wire bytes | Wire bytes / snapshot | Overhead vs payload |
| ------------------- | ------ | ---------- | --------------------- | ------------------- |
| **1**               | 1000   | 172,750    | **172.8 B**           | **557%**            |
| 5                   | 200    | 65,787     | 65.8 B                | 212%                |
| 10                  | 100    | 51,293     | 51.3 B                | 165%                |
| 50                  | 20     | 34,962     | **35.0 B**            | 113%                |
| 100                 | 10     | 33,218     | **33.2 B**            | 107%                |

**The main finding:** one Hypercore block per snapshot is far too expensive. The
per-block Merkle/signature/framing cost dominates a 31 B record. Batching 50–100
snapshots per block amortises it down to ~33–35 B per snapshot.

This invalidates the implicit "one snapshot per block" reading of the live plane.
The live plane must **write batched blocks**.

### Realistic daily cost with batching

Using 35 B/snapshot (batch 50):

| Vessels | @ 0.05 Hz   | @ 0.1 Hz    |
| ------- | ----------- | ----------- |
| 100     | ~15 MB/day  | ~30 MB/day  |
| 500     | ~76 MB/day  | ~151 MB/day |
| 1,000   | ~151 MB/day | ~303 MB/day |
| 5,000   | ~756 MB/day | ~1.5 GB/day |

The payload-only table in the spike understates the real wire cost by roughly 5×
at batch 1. With batching it is close to the payload estimate, as intended.

---

## 4. The design decision this creates

Batching needs a writer that collects multiple snapshots before appending a block.
Three shapes are possible:

### A. Per-vessel time-batched blocks

Each vessel appends one block every `batchInterval` containing its snapshots since
the last block.

- **Pro:** no new trust model; the vessel still signs its own blocks.
- **Con:** latency = batch interval. At 0.05 Hz, a 20 s block is one snapshot
  (172 B), and a 100 s block is five snapshots (66 B) with 100 s of latency.
  Unacceptable for live collision awareness.

### B. Peer-elected aggregator (bootstrap peer initially)

A shard elects an aggregator from its reachable peers. It collects snapshots for
2–5 s and appends one batch block.

- **Pro:** amortises the overhead over many vessels; short latency; no fixed
  infrastructure. A VPS bootstrap peer can hold the role initially while most
  boats are behind CGNAT.
- **Con:** election convergence and churn. The aggregator can drop or delay but,
  packaging opaque authenticated records, cannot forge them. Attribution still
  needs per-record signatures or signed batches.

### C. Protomux live messages + periodic Hypercore checkpoints

Send snapshots as Protomux messages over a relay connection for low latency,
and append a slower Hypercore block for catch-up/audit.

- **Pro:** no per-block Merkle cost on the hot path; a relay can batch messages;
  simpler than an aggregator with a durable batch log.
- **Con:** one-hop (the relay), and the same attribution/trust question for the
  relay's batches. It is not the swarm-distribution model.

### Recommendation

**B (peer-elected aggregator), with gossip as the no-aggregator fallback.** No
fixed relays are required. A VPS bootstrap peer is likely the first elected
aggregator, and rotates out as more reachable peers appear. The open question is
attribution: either

- accept that the elected peer attests to the sender (and say so in
  `security.md`), or
- add a per-vessel signed batch/Merkle root at a slower cadence and verify it
  asynchronously (more work, stronger guarantees).

This needs a decision before the live-plane format is frozen.

---

## 5. Other outcomes

- `npm run spike` is repeatable and is the gate for format changes.
- The local testnet did not find peers; the replication measurement uses a direct
  encrypted stream, which is the same framing Hyperswarm provides. DHT/NAT
  behaviour still needs a real-network run.
- The next cheap win is a **path-id dictionary** for `Values`, not CBOR.

---

## 6. Next steps

1. Decide end-to-end authentication for batched records (per-record signatures
   versus a slower signed batch root).
2. Add a **Batch** record/envelope and an elected-aggregator abstraction.
3. Re-run the spike with the batch record to confirm ~33 B/snapshot end to end.
4. Run the DHT/NAT/idle measurement on a host with UDP access.
5. Implement peer election; the standalone relay/aggregator skeleton is already
   in `src/live/relay.ts` and `src/peer/`.
