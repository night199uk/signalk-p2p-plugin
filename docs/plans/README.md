# signalk-p2p — design plans

**Status:** design plus a working live path. The scaffold, codecs, standalone
peer, LiveClient, and plugin publish/inject path are implemented and validated
over WAN. LiveMessages are signed and the public claim registry (claims,
attestations, revocations, an admin attestor API) is implemented. Peer election
and routing enforcement are implemented (capability advertisements, weighted
rendezvous, elected-aggregator routing). Private groups are implemented with
signed roster snapshots with multi-admin quorum and catch-up, invites, join
approval and removal rekey; the standalone peer can relay a group with
`--group-invite`. A minimal admin webapp (listed under Webapps) and the full group/claim API are
in place. AIS sharing is implemented with
local-only collection and observation precedence.

## Goal

Connect Signal K instances in peer-to-peer meshes so boats share their own vessel
data in real time: one global public network, joined by default, plus any number
of private groups.

## Documents, in reading order

| Doc                                              | What it settles                                                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| [`architecture.md`](architecture.md)             | The stack, the live/durable split, identity, and the invariants every component must obey.                     |
| [`shared-data.md`](shared-data.md)               | **What we actually share**: the per-data-set toggles, default key set, privacy, rates, and AIS sharing modes.  |
| [`networks.md`](networks.md)                     | The public `all-vessels` network, adaptive geographic sharding, and closed groups (invites, roles, re-keying). |
| [`security.md`](security.md)                     | Write authorization, group member approval, the public claim registry, and the MMSI ownership gap.             |
| [`data-and-injection.md`](data-and-injection.md) | Wire formats, merge semantics, injection into the Signal K tree, loop prevention, and versioning.              |
| [`v1-design.md`](v1-design.md)                   | What to build first, the validating spike, repo layout, risks, and deferred calibration.                       |
| [`spike-findings.md`](spike-findings.md)         | **Measured** payload and replication costs, and the batching decision they force.                              |
| [`peer-node.md`](peer-node.md)                   | The standalone Node.js peer: bootstrap, relay/aggregation, deployment and election.                            |

## Decisions already taken

| Decision       | Choice                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Stack          | Holepunch: Hyperswarm + `@hyperswarm/secret-stream` + Protomux + Hypercore/Hyperbee + Autobase.                                          |
| Transport      | Live plane = generation-rotated Hypercore channels; durable plane = Hypercore/Hyperbee/Autobase.                                         |
| Public network | `all-vessels`, joined by default; transmission is opt-in (`receive-only` default), with four consent modes.                              |
| Sharding       | Global by default; adaptive geographic shards that subdivide to keep a configured vessel count.                                          |
| Relays         | No fixed relays; a peer-elected aggregator per shard, gossip fallback, optional standalone bootstrap peer.                               |
| Identity       | Persistent Ed25519 keypair per instance; groups keyed by identity, not by a shared secret.                                               |
| Groups         | Arbitrary number; roles, signed roster, simple invite links, re-key and member removal.                                                  |
| Injection      | Received vessels become real Signal K contexts; local data wins; no bridging between networks.                                           |
| Shared data    | Per-data-set matrix in the webapp (Public + active groups); curated defaults (no `electrical.*`).                                        |
| Security       | One authorized writer per context; groups approve the member's MMSI; public uses a claim registry + attestors (MMSI ownership unproven). |

## Still open

- Anti-gaming and attestation of capability claims (the election and routing are in
  place).
- Shard-map authority when there is no long-lived bootstrap peer.
- A fully ordered Autobase roster log (v1 uses approved snapshots + catch-up).
- Reputation / Sybil resistance for the public network.
- How history plugins should exclude injected P2P sources.
- Group key rotation when the only admins are offline.
- Authoritative MMSI ownership verification; only group admins or public attestors
  can assert it today.
- Governance of the public attestor set.
- The live-plane batching/attribution model: batched blocks are required, but who
  writes the batch and who attests to it is not yet decided
  ([`spike-findings.md`](spike-findings.md) §4).

## Reviewing this?

Read [`architecture.md`](architecture.md) first for the mental model, then
[`shared-data.md`](shared-data.md) — it is the product-facing spec and the one
most likely to need your judgement. Then [`networks.md`](networks.md) for the two
network classes and [`security.md`](security.md) for who may write what, then
[`data-and-injection.md`](data-and-injection.md) for the formats.
[`v1-design.md`](v1-design.md) is the build plan and the spike that must pass
before any format is frozen.
