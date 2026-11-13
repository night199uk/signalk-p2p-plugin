# signalk-p2p — v1 design

**Status:** draft for build. The concepts are settled in the other documents; this
is the concrete plan — what to build, in what order, and what must be proven before
any format is frozen.

Read [`architecture.md`](architecture.md), [`shared-data.md`](shared-data.md),
[`networks.md`](networks.md) and [`data-and-injection.md`](data-and-injection.md)
first.

**Implementation status (2026-10-19):** the repo scaffold, identity, config,
record codecs, merge, standalone Node.js peer, LiveClient, and plugin
publish/inject path are implemented. The full path was validated over WAN through
a VPS peer. LiveMessages are signed; the public claim registry is implemented
with persisted claims, attestation verification, revocation, a configurable
attestation threshold, and an admin attestor API. Peer election is implemented
with capability advertisements and weighted rendezvous hashing; the relay
advertises itself and is the initial elected peer. Routing is enforced: clients
send to the elected aggregator, only it forwards, with a full-mesh fallback. The
group roster and attestor UI are still pending.

---

## 1. Scope of v1

A Signal K plugin that:

- has a persistent Ed25519 identity, per-data-set sharing toggles, and per-network discovery/consent/rates;
- joins the global `all-vessels` network by default, with the four consent modes;
- discovers peers over Hyperswarm (LAN via mDNS, WAN via the DHT), with a relay
  path for pairs that cannot hole-punch;
- publishes the default path set in a compact snapshot;
- injects other vessels into the Signal K tree, with loop prevention and history
  exclusion;
- supports geographic sharding of the public network, with a shard map published by a bootstrap peer
  map and adaptive split/merge;
- supports an arbitrary number of encrypted groups with roles, invites, and
  re-key/removal;
- enforces **one authorized writer per vessel context**: a group admin approves
  the member's MMSI/selfId, and the public network binds each context to one key
  through a claim registry;
- elects a relay/aggregator per shard from reachable peers (no fixed relays), with
  a standalone Node.js peer that can bootstrap the mesh from a VPS;
- can share locally heard AIS targets in the four modes.

**Definition of done.** Two instances on a LAN see each other's vessels in the
Signal K tree; a third joins a public shard and is capped at the configured
vessel count; a group is created, joined by invite, and survives a member removal
(removed member cannot decrypt new data); a peer holding the wrong key cannot
publish into another vessel's context; the standalone peer relays a batch between
two clients; the spike thresholds are met; the docs match the code.

---

## 2. Components

```
             ┌────────────────────────────────────────────┐
             │                  plugin.ts                 │
             │  lifecycle · config · status · routes      │
             └───┬───────────┬──────────────┬─────────────┘
                 │           │              │
       ┌─────────▼──┐  ┌─────▼──────┐  ┌────▼─────────────┐
       │ identity   │  │ networks/  │  │ sharding/        │
       │ (Ed25519)  │  │ manager    │  │ geohash · map    │
       └────────────┘  │ public     │  │ assign · split   │
                       │ group      │  └────┬─────────────┘
                       └───┬────┬───┘       │
                           │    │           │
                  ┌────────▼─┐ ┌▼───────────▼─────────┐
                  │ data/    │ │ transport/            │
                  │ snapshot │ │ swarm · corestore     │
                  │ static   │ │ control (protomux)    │
                  │ ais      │ │ relay                 │
                  │ merge    │ └───────────┬───────────┘
                  │ publish  │             │
                  │ inject   │       ┌─────▼──────┐
                  └──────────┘       │ Hypercore  │
                                     │ Hyperbee   │
                                     │ Autobase   │
                                     └────────────┘
```

| Area         | Responsibility                                                                  |
| ------------ | ------------------------------------------------------------------------------- |
| `identity`   | Key creation/storage; signing; public-key encoding.                             |
| `networks`   | Network lifecycle, discovery, consent, rates, subscription set.                 |
| `sharding`   | Geohash keys, shard map, split/merge, home-shard and look-ahead assignment.     |
| `data`       | Envelope and record codecs, authorization, merge, publish selection, injection. |
| `security`   | Core certificates, context→key bindings, claim registry, attestations.          |
| `live`       | Topic derivation, the Protomux live channel, relay/aggregation.                 |
| `peer`       | Standalone Node.js peer: config, CLI, VPS bootstrap/relay.                      |
| `membership` | Roster/Autobase, roles, invite tokens, epoch keys, sealed-box wrapping.         |
| `transport`  | Hyperswarm, Corestore, Protomux control protocol, relay/aggregator behaviour.   |

### Suggested repo layout

```
signalk-p2p-plugin/
  src/
    index.ts
    plugin.ts
    config.ts
    identity.ts
    api.ts
    networks/{manager,public,group}.ts
    sharding/{geohash,map,assign}.ts
    data/{envelope,snapshot,static,ais,merge,publish,inject}.ts
    security/{certificate,authorize,claims,attest}.ts
    live/{topic,protocol,relay}.ts
    peer/{config,cli}.ts
    membership/{roster,invite,epoch,approval}.ts
    transport/{swarm,corestore,control,relay}.ts
    types/external.d.ts
  test/
  docs/plans/
  package.json · tsconfig.json · vitest.config.ts
```

Tooling follows `signalk-livedepth-plugin`: TypeScript ESM, `tsc` to `dist`,
`@signalk/server-api`, vitest, oxlint, prettier, the SignalK shared CI workflow,
Node `>=22.5`. Dependencies: `hyperswarm`, `corestore`, `hypercore`, `hyperbee`,
`autobase`, `@hyperswarm/secret-stream`, `protomux`, `b4a`, `compact-encoding`,
and a sodium implementation for sealed boxes.

---

## 3. Phases

| Phase | Scope                                                                                                                                                       | Ships                                        |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **0** | Repo, tooling, identity, config, envelope/record codecs, core certificates, merge, local loopback publish → inject                                          | Tested codecs and merge; no network          |
| **1** | Hyperswarm on one topic, Corestore, control protocol, generation cores, self-record authorization, snapshot exchange, injection                             | Two instances on a LAN see each other        |
| **2** | Public `all-vessels`: shard map, bootstrap peer, peer-elected aggregator, claim registry + attestors, look-ahead, caps, adaptive split/merge, consent modes | Global network usable with bounded load      |
| **3** | Groups: roster/Autobase, roles, admin-approved identity/MMSI + uniqueness, invites, epoch encryption, rekey/removal                                         | Private groups with secure removal           |
| **4** | WAN hardening: standalone peer on a VPS, hole-punch fallback, election failover, reconnection/backoff                                                       | Works behind CGNAT/Starlink, no fixed relays |
| **5** | AIS sharing modes, caps, dedup; measured load                                                                                                               | The global AIS map, opt-in and bounded       |
| **6** | Optimisation: duplicate suppression, relayer election, history hooks, polish                                                                                | Efficiency and operability                   |

Phase 0 is where the record formats must be right; after the spike they are a
breaking change across peers. Phases 2 and 4 both depend on a bootstrap peer, so stand one
up early with the standalone Node.js peer.

---

## 4. The spike (must pass before freezing formats)

The three stack assumptions in the other documents are unvalidated. Prove them with
a throwaway harness before Phase 0 hardens anything.

### 4.1 What to measure

1. **Wire volume.** Per-process byte counters over a sustained run:
   - idle: DHT + keepalive with one network and 3–10 peers;
   - payload: 100 / 500 / 1000 synthetic vessels at 0.05 Hz and 0.1 Hz;
   - the difference between a hand-rolled fixed layout and CBOR.
2. **Distribution.** Connect peers in a partial graph and confirm that a peer which
   holds a generation core serves it to others, including when it only has part of
   it. If partial readers do not re-serve well, a bootstrap peer is mandatory; measure that.
3. **NAT.** Two containers on different bridge networks: confirm hole-punching,
   then force symmetric NAT and confirm relay fallback. Record how often the relay
   is needed.
4. **Latency.** p50/p95 tail-follow latency on LAN and over WAN.
5. **Authorization.** In a two-peer group and in a public claim, a peer holding
   the wrong key cannot write another vessel's context, and a duplicate group MMSI
   is rejected.
6. **Crypto (phase 3).** A removed member cannot decrypt a new-epoch core, and an
   offline member can unwrap its key on return.

### 4.2 Pass/fail thresholds (starting points)

| Check                  | Target                                         |
| ---------------------- | ---------------------------------------------- |
| Idle                   | < 10 MB/month per node with a handful of peers |
| 500 vessels @ 0.05 Hz  | < 120 MB/day inbound                           |
| 1000 vessels @ 0.05 Hz | < 250 MB/day inbound                           |
| Tail latency, LAN      | p95 < 5 s                                      |
| Tail latency, WAN      | p95 < 15 s                                     |
| Wrong-key write        | rejected at the receiver                       |
| Duplicate group MMSI   | rejected by the roster                         |
| Removed member         | cannot read new-epoch data                     |

If a threshold fails, adjust the defaults (rate, cap, encoding) or make a bootstrap peer
mandatory — do not hand-wave it.

### 4.3 First results

The first run is in [`spike-findings.md`](spike-findings.md). The headline
finding: one Hypercore block per snapshot costs **172.8 B** on the wire for a
31 B record, but batching 50–100 snapshots per block brings it down to **~33–35 B**.
The live plane therefore must write batched blocks, which needs a batching and
attribution decision before formats are frozen.

---

## 5. Configuration

The config schema combines the sketches in [`shared-data.md`](shared-data.md) §9
and [`networks.md`](networks.md) §6: `identity`, `sharding`, `bootstrapPeers`,
`election`, `inject`, the shared `sharing`/`ais` policy, and the `networks`
array. The schema is a JSON Schema served by the plugin so the Signal K admin UI
can render it. Required choices:

- for each data set, its audience: public, selected groups, or none;
- consent mode and the four alternatives per network;
- AIS audience, mode and caps;
- per-path additions/removals inside a data set;
- rate per network;
- share history (default off);
- optional bootstrap peers and election settings;
- public attestors and whether attestation is required;
- group invite entry and member approval.

---

## 6. Status and routes

`app.setPluginStatus` should summarise, at a glance:

- networks joined, peers connected, shard and look-ahead;
- injected vessel count and outbound/inbound bytes;
- AIS mode and target count;
- group roles and epoch;
- public claim status (unverified/attested) and the attestor set;
- any identity/MMSI conflict or rejected write.

Admin/plugin routes (under `/plugins/signalk-p2p-plugin/`):

| Route          | Purpose                                |
| -------------- | -------------------------------------- |
| `GET /status`  | The status summary                     |
| `GET /peers`   | Connected peers and their transport    |
| `GET /shards`  | Current shard map and assignment       |
| `GET /groups`  | Groups, roles, epochs                  |
| `POST /groups` | Create/join/leave a group              |
| `POST /invite` | Create an invite (admin)               |
| `POST /rekey`  | Rotate a group epoch (admin)           |
| `GET /claims`  | Public claim registry status           |
| `POST /attest` | Issue an attestation (public attestor) |
| `GET /metrics` | Counters for the spike and operation   |

---

## 7. Non-goals for v1

- Reputation, trust, or Sybil resistance on the public network.
- Authoritative MMSI ownership verification (no source exists); admin/attestor
  assertion only.
- Browser peers.
- Cross-network bridging.
- Historical vessel-track backfill.
- LiveDepth tile transfer (the channel is exposed; the tile plugin is separate).
- Fixed central relays (optional bootstrap peers only; the mesh is peer-elected).
- Decentralised shard-map consensus in v1.
- Guaranteed delivery or ordering (the live plane is best-effort and convergent).

---

## 8. Risks

| Risk                                              | Mitigation                                                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Stack assumptions wrong (sparse, re-serving, NAT) | The spike, before formats are frozen.                                                                     |
| Starlink/metered bandwidth                        | Packed records, low rates, caps, peer relays, no durable telemetry.                                       |
| Default-on sharing / AIS redistribution           | Explicit consent modes, easy opt-out, clear notice, no bridging.                                          |
| Sybil and MMSI spoofing                           | One writer per context; group admin approval; public TOFU + attestors. No authoritative ownership source. |
| Autobase roster complexity                        | Keep it to membership events; deterministic `apply()`; tests.                                             |
| Bootstrap peer outage / election split-brain      | Elected failover, gossip fallback, multiple optional bootstrap peers.                                     |
| DHT exposes IP addresses                          | Document it; groups avoid the public DHT via known peers where possible.                                  |
| Dependency weight / maintenance                   | Confine to `transport/`; the rest is plain TypeScript.                                                    |
| History amplification                             | Exclude injected P2P vessels from history by default.                                                     |
| Shard-map divergence                              | Bootstrap peer publishes it in v1; deterministic split as fallback.                                       |

---

## 9. Deferred calibration

Not design gaps; they need real data:

- the exact snapshot and AIS rates;
- `maxVesselsPerShard` / `maxVesselsPerInstance` after the spike;
- split/merge settle windows and the merge ratio;
- AIS target caps and the dedup/relayer strategy;
- generation length and relay history retention;
- group re-key cadence.

---

## 10. Decisions log

| #   | Decision                                                                                                                                                          | Date       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | Holepunch stack; live/durable split; generation-rotated live cores.                                                                                               | 2026-10-19 |
| 2   | Public `all-vessels` joined/transmitting by default; four consent modes.                                                                                          | 2026-10-19 |
| 3   | Adaptive geographic sharding; a bootstrap peer publishes the map, election refines relays.                                                                        | 2026-10-19 |
| 4   | Inject remote vessels into the Signal K tree; local wins; no bridging.                                                                                            | 2026-10-19 |
| 5   | Groups by identity with signed roster, roles, invites, re-key/removal.                                                                                            | 2026-10-19 |
| 6   | Per-data-set sharing toggles (public / selected groups / none); curated defaults (electrical off by default).                                                     | 2026-10-19 |
| 7   | One authorized writer per context; groups approve MMSI/selfId; public claim registry with TOFU + attestors.                                                       | 2026-10-19 |
| 8   | No fixed relays: peer-elected aggregator per shard, gossip fallback, standalone Node.js bootstrap peer.                                                           | 2026-10-19 |
| 9   | LiveMessages are Ed25519-signed; receivers verify and bind selfId→key (TOFU until the claim registry).                                                            | 2026-10-19 |
| 10  | Public claim registry implemented: persisted claims, attestation/revocation verification, receiver authorization.                                                 | 2026-10-19 |
| 11  | Extended shared data: extra navigation/GNSS in the snapshot; environment, tanks, destination, anchor, propulsion and systems in a change-triggered Values record. | 2026-10-19 |
| 12  | The admin interface is a Signal K webapp (listed while the plugin is enabled) and remains available on the admin-gated plugin route.                              | 2026-11-02 |
