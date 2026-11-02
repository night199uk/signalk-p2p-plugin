# Changelog

## 0.1.1 — 2026-11-02

Fix the Windows path assertion in the peer config test; no runtime changes.

## 0.1.0 — 2026-11-02

First public release. Validated over WAN through a VPS peer; not yet validated
on real boats or Starlink links.

- Design plans under `docs/plans/`.
- Repository scaffold: TypeScript ESM plugin, identity, configuration schema,
  snapshot/static codecs, and merge rules.
- Spike harness for payload size and Hypercore replication measurements.
- Standalone Node.js peer (`signalk-p2p-peer`) with Hyperswarm discovery,
  Protomux live channel, batching, history replay and a systemd deployment.
- Live path in the plugin: self snapshots/static/depth publishing, LiveMessage
  batching, and injection of remote vessels with loop prevention.
- Ed25519-signed LiveMessages with receiver verification; unsigned and tampered
  messages are rejected.
- Public claim registry: persisted `selfId → key` claims, attestor-signed
  attestations/revocations, TOFU fallback, and receiver authorization.
- Admin attestor API (`/identity`, `/claims`, `/claims/attest`,
  `/claims/revoke`) and a configurable attestation threshold.
- Peer election: signed capability advertisements, weighted rendezvous epochs,
  relay advertisement, status reporting and a WAN smoke test.
- Routing enforcement: clients target the elected aggregator, only it forwards,
  with deduplication and a full-mesh fallback.
- Private groups: X25519 box keys, signed roster snapshots, invite tokens, join
  requests and admin approval with selfId/MMSI uniqueness, AES-256-GCM group data,
  and removal with epoch rekey. Admin group API and a network smoke test.
- Standalone peer group relay via `--group-invite`: joins the roster, forwards
  encrypted group data and follows rekeys.
- AIS sharing: collects locally heard targets only, supports the four modes,
  caps to the nearest targets, publishes observation records, and drops AIS
  observations in favour of fresh self records.
- Roster/attestor hardening: attestation signatures are persisted and revalidated,
  expired or retired attestors no longer count, group invites are single-use, and
  viewers cannot publish.
- Multi-admin quorum: multi-signature roster proposals, approval and threshold
  APIs, and serialized group persistence.
- Roster catch-up requests and a minimal admin page for claims, groups,
  join requests and proposals.
- Extended shared data: magnetic course/heading, variation, attitude, rate of
  turn, speed through water and GNSS DOP/satellites in the snapshot; environment,
  tanks, destination, anchor, propulsion and systems in a change-triggered Values
  record.
- WAN validation through a VPS peer, plus `smoke:client` and `smoke:plugin`
  scripts.
