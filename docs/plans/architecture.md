# signalk-p2p — architecture

**Status:** design. No code, no frozen wire format.

This is the mental model every other document assumes. It settles the stack, the
split between live and durable data, identity, and the invariants that the rest
of the design must not violate.

---

## 1. Goal and non-goals

**Goal.** Let Signal K instances form peer-to-peer meshes and share vessel data in
real time:

- one **global public network** (`all-vessels`), joined and transmitting by
  default, opt-out;
- any number of **private groups**, invite-only and encrypted.

A vessel may participate in both at once, with a different view of its data in
each.

**Non-goals for v1.**

- A central server that brokers vessel data. Bootstrap peers and relays exist for discovery,
  NAT traversal and availability, not authority over the data.
- Global reputation, Sybil resistance, or identity attestation. Pseudonymous
  Ed25519 identities only.
- High-fidelity recording. This is situational awareness, not a survey feed;
  LiveDepth's durable dataset is a separate consumer of the same channel.
- A browser peer. Instances are servers; a browser is a viewport.

---

## 2. The stack

**Holepunch**, JS-only, running inside the Signal K Node server (Node `>=22.5`).

| Need                                            | Primitive                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| Discovery, LAN + WAN, NAT traversal             | **Hyperswarm** on **HyperDHT** (mDNS locally, Kademlia DHT, UDP hole-punching) |
| Encrypted, framed peer connection               | **`@hyperswarm/secret-stream`** (Noise)                                        |
| Multiplexed message channels                    | **Protomux** (named protocols over one encrypted stream)                       |
| Broadcast of live snapshots                     | **Hypercore** (signed Merkle log, sparse replication, realtime tail)           |
| Low-rate keyed state (indexes, static)          | **Hyperbee** (B-tree on a Hypercore)                                           |
| Ordered multi-writer state (rosters, shard map) | **Autobase** (deterministic `apply()`, Autobee view)                           |
| Many cores per process                          | **Corestore**                                                                  |

**Why this stack.** It is the only one that provides discovery, NAT traversal,
integrity, a queryable store and multi-writer merge in a single JS stack. It is
also the stack the LiveDepth plans already assume for the shared channel
(`signalk-livedepth-plugin/docs/plans/data-quality-and-p2p.md` §3.5).

**Known costs.** JS-only; a real dependency tree inside a plugin; Autobase's
determinism is a permanent constraint on the durable write path; DHT/NAT
debugging is hard; some peer pairs (CGNAT, Starlink) will never hole-punch and
need a relay.

---

## 3. Two planes

The single most important structural decision: **separate real-time telemetry
from convergent state.**

```
                         ┌──────────────────────────────┐
  own vessel sensors ───►│  publish policy (per network) │
  local AIS receiver ───►└──────────────┬───────────────┘
                                        │
                    ┌───────────────────┴───────────────────┐
                    ▼                                       ▼
        ┌───────────────────────┐               ┌───────────────────────┐
        │      LIVE PLANE       │               │     DURABLE PLANE     │
        │ generation Hypercore  │               │ Hypercore/Hyperbee/   │
        │ packed snapshots      │               │ Autobase              │
        │ sparse tail, realtime │               │ rosters, shard map,   │
        │ per vessel / per net  │               │ static info, tiles    │
        └───────────┬───────────┘               └───────────┬───────────┘
                    └───────────────────┬───────────────────┘
                                        ▼
                    ┌───────────────────────────────────┐
                    │      Hyperswarm + Corestore       │
                    │    (one connection per peer)      │
                    └───────────────────────────────────┘
```

### 3.1 Live plane

High-rate, low-latency vessel state. Snapshots are written as **batched blocks**
into generation cores per network/shard: bounded by rotating to a new generation,
replicated sparsely from the tail. Readers follow the head ("realtime"); they do
not download history.

- **Batched, not one snapshot per block.** The spike measured ~173 B of wire cost
  for a 31 B snapshot when each snapshot is its own block; batching 50–100
  snapshots per block brings it to ~33–35 B. See
  [`spike-findings.md`](spike-findings.md).
- **Relay-free by default.** There are no required fixed relays. The batch
  writer is an **elected aggregator** per shard, chosen deterministically from a
  replicated capability view, with failover and rotation. A bootstrap peer (a
  VPS, a marina box) can take the role initially while most boats are behind
  CGNAT. If no aggregator is reachable, peers fall back to a gossip mesh.
- **Opaque batches.** The aggregator packages individually authenticated records
  without being able to forge them. It can drop or delay; it cannot silently
  alter a vessel's data.
- The broadcast medium is a **Hypercore**, not a Protomux message. Peers that hold
  a core serve it to other peers, and Hyperswarm connects you to several peers per
  topic. There is no spanning tree to maintain.
- Generation rotation is what keeps this Starlink-sane: each generation is a
  bounded ring buffer, not an unbounded log. Hypercore is append-only, so
  retention is bounded by opening a new generation, never by deleting the head.
- Protomux is used for **control and the live relay channel**: membership, peer
  exchange, shard membership, key discovery, presence, and the opaque batch
  protocol. The standalone peer is documented in [`peer-node.md`](peer-node.md).

### 3.2 Durable plane

Small, low-rate state that must converge and persist:

- the group **roster** and membership events;
- the public network's **shard map**;
- per-vessel **static information** (name, type, dimensions);
- later, LiveDepth's bathymetry tiles (sparse, Merkle-compared).

This plane tolerates seconds-to-minutes of latency and is replicated sparsely.
Nothing at sensor rate ever enters it.

---

## 4. Networks

A **network** is the unit of membership, encryption, policy and discovery:

```
Network {
  id, kind: public | group, enabled
  discoveryTopic            // H(well-known name) or H(group epoch key)
  sharePolicy               // derived from the per-data-set audiences (see shared-data.md)
  subscribePolicy           // what to ingest (all / own / AIS-only / …)
  encryption                // none (public) or epoch key (group)
}
```

- **Public `all-vessels`** — one logical network, well-known topic, open join,
  no encryption, pseudonymous identity. Implemented as **adaptive geographic
  shards** under the hood so a single instance never replicates the whole world.
- **Group** — topic and data key derived from a rotating group epoch key; roster
  and roles on a stable topic. Undiscoverable and undecryptable without an invite.

Details in [`networks.md`](networks.md).

---

## 5. Identity

- Every instance has a persistent **Ed25519 keypair** created on first start and
  stored under the plugin data directory. It is the instance's network identity.
- Hypercore block authorship is signed by this key; blocks are attributable
  without trusting the payload.
- **Vessel identity** is the Signal K `selfId` — `urn:mrn:imo:mmsi:<mmsi>` or the
  server-generated `urn:mrn:signalk:uuid:<uuid>` — advertised by the sender and
  bound to the instance key. Only that key may write the context. Name, callsign,
  type and MMSI are self-declared metadata. Collisions are resolved
  deterministically (see [`data-and-injection.md`](data-and-injection.md)). Remote
  vessels are injected under their own `vessels.<selfId>` context.
- **MMSI ownership is not provable by the network alone.** Write authorization is;
  claim legitimacy is mitigated by group admin approval and public attestors, not
  solved. See [`security.md`](security.md) §5.3.
- Group membership is by **identity**, not by possession of a shared secret. An
  invite is a capability that admits an identity; removing it is possible because
  the roster is authoritative.

---

## 6. Invariants

These hold everywhere. Code that violates them is a bug, not a trade-off.

1. **Local-only publish.** Only data originating from _this_ vessel (self context,
   and locally-heard AIS if enabled) is ever published. Data received over any
   network is never re-published.
2. **No bridging.** A network's inbound data never becomes another network's
   outbound data. There is no transitive sharing between groups, or from a group
   to the public network, unless a future explicit bridge feature says otherwise.
3. **Live stays bounded.** No sensor-rate data enters a durable log. Live cores
   are capped and rotated by generation.
4. **Local beats remote.** Self and locally-received data take precedence over
   network data; last-writer-wins by timestamp applies only among remote sources.
   Remote vessels are injected under their own contexts, never under self.
5. **Audience is per data set; consent is per network.** Each data set selects
   public, selected groups, or nobody. Each network supplies its own consent mode
   and rates. Enabling a set publicly never silently widens a group's policy, or
   vice versa.
6. **Nothing unnamed.** Every shared path is on an explicit allowlist; unknown
   paths are dropped rather than guessed.
7. **One writer per context.** A self context is bound to exactly one instance
   key. A signed write from any other key is rejected, in groups by the roster and
   publicly by the claim registry. A vessel can only ever write its approved
   context. See [`security.md`](security.md).

---

## 7. Signal K integration

- **Read:** subscribe through `app.subscriptionmanager` to the self context, and
  (optionally) to local AIS contexts. Never subscribe to the whole `vessels.*`
  tree — that would make injected remote data look like local data.
- **Write:** inject remote snapshots with `app.handleMessage(pluginId, delta)`
  under real vessel contexts, tagged with a `signalk-p2p` source.
- **Filter:** ignore any delta whose source is `signalk-p2p` on the publish path
  (belt and braces with invariant 1).
- **Config:** a JSON schema with the per-data-set sharing policy, the networks
  array (consent and rates), sharding limits, bootstrap peers, election, and
  injection/history options.
- **Status:** `app.setPluginStatus` / `app.setPluginError` plus a small plugin
  router (`/plugins/signalk-p2p-plugin/...`) for peers, shards, groups and diagnostics.

---

## 8. Relationship to LiveDepth

`signalk-p2p` is the **channel**; LiveDepth owns its data model, merge and trust.
The durable plane is the substrate its tiles need (signed, sparse, convergent,
provenance-carrying). The live plane is not sufficient for tiles. This keeps the
scope boundary the LiveDepth docs already draw: LiveDepth describes the
requirements on a channel, and this plugin implements the channel and the
general-purpose live mesh.

---

## 9. Open questions

- How a plugin-to-plugin API is exposed (in-process import vs an app service
  registry) so LiveDepth can consume the channel without duplicating it.
- Peer-election convergence and anti-gaming. Bootstrap peers are optional, so the
  network must work when no long-lived peer is elected.
- Whether Autobase is warranted for the shard map, or a signed single-writer map
  replicated by bootstrap peers is enough for v1.
- Battery/power behaviour on small boats: how aggressively to idle the DHT and
  physical links when there is nothing to send.
- Authoritative MMSI ownership verification; today only admins/attestors can assert
  it (see [`security.md`](security.md) §5.3).
