# Changelog

## 0.10.0 — 2026-11-09

- Add a “Join all-vessels public network” toggle. Uncheck it to use Signal K P2P
  for private groups only; the public client is stopped and public sharing
  controls are disabled, while group publishing, group invites, AIS group
  sharing and subscriptions keep working.
- Startup now initializes self/AIS subscriptions and the publish timer even when
  the public network is disabled, and the public network can be enabled or
  disabled live from the webapp.

## 0.9.1 — 2026-11-09

- Serialize plugin start/stop and await client, registry and group cleanup.
  A fast disable/enable could previously clear `identity` while the new start was
  still awaiting setup, causing `publicKeyRaw`/`fingerprint` undefined errors.

## 0.9.0 — 2026-11-06

- Track join approval explicitly. A join request now shows "Pending
  administrator approval" and is not treated as removed when the current signed
  roster does not yet contain the instance. Pending clears when an approved
  roster includes it; an actual removal still shows as removed. Invite expiry is
  surfaced in the pending state.
- Re-joining a removed or pending group with a new invite now rebuilds the local
  state and resends the join request instead of returning the stale state.

## 0.8.0 — 2026-11-06

- Add AIS source selection. The plugin tracks the local source labels that
  contributed to each AIS target and exposes them in the webapp. Checkboxes let
  you share only selected feeds (for example, physical AIS but not
  MarineTraffic). Targets heard only from unchecked sources are not shared.
- The AIS source list refreshes with the status and defaults to all local
  sources, preserving existing behavior until you change it.

## 0.7.1 — 2026-11-06

- Assign `sensors.ais.class` to the identity data set so the own-vessel AIS
  class is actually published and Freeboard-SK can select the vessel icon.

## 0.7.0 — 2026-11-06

- Share AIS targets even when the receiver does not publish
  `sensors.ais.class`. Many AIS feeds omit that field, and the plugin was
  discarding every such target.
- Share the vessel's own `sensors.ais.class` in the values record so receivers
  and Freeboard-SK can choose the correct vessel icon for P2P boats.

## 0.6.1 — 2026-11-06

- Reorder the public-network card to Status, Peers, Sharing, AIS.

## 0.6.0 — 2026-11-06

- Restore AIS sharing controls in the webapp. The sharing matrix now includes an
  **AIS targets** row with public/group audiences, plus an AIS mode selector
  (Off, Receive only, Share and receive, Share only). The setting was hidden
  during the UI cleanup; existing AIS configuration was preserved.
- AIS mode changes apply live: enabling sharing starts the local AIS
  subscription, disabling it stops collecting local AIS targets.

## 0.5.1 — 2026-11-06

- Fix missing vessel names over P2P. Own-vessel static data now refreshes every
  60 seconds and static paths are subscribed, so names set after startup are
  shared. AIS static/name records are re-sent every 5 minutes so peers that join
  later receive target names too.

## 0.5.0 — 2026-11-06

- Replace long, self-contained group invites with 10-character per-invite codes.
  The signed invite is distributed over the group control channel and served by
  any online group member or relay, so the admin need not stay online after the
  code is distributed. Codes expire in 24 hours, are single-use at approval, and
  are revoked from members after use. Long signed tokens remain accepted.
- Add invite record sync/revoke handling and unit coverage for the short-code
  format and normalization.

## 0.4.2 — 2026-11-06

- Reduce main-thread load: subscribe to non-navigation self values with a 5 s
  fixed policy, subscribe to AIS only when publishing AIS and at a 30 s fixed
  policy, and expose event-loop delay in the status.
- Auto-refresh the webapp status every 5 seconds so peer changes are visible.

## 0.4.1 — 2026-11-06

- Move **Invite** next to each group and create a member invite token with no
  role/expiry prompts, defaulting to a 24-hour expiry. Join with token no longer asks for an MMSI; publish and
  receive settings are chosen by the member after joining.

## 0.4.0 — 2026-11-06

- Add a signed, versioned network policy for sharding, election windows, public
  publish-rate caps, AIS caps and protocol compatibility. A signed default ships
  with the package; newer signed policies received over the mesh override it and
  are cached. Clients cannot override topology/rate limits locally.
- Add the network-operator key tooling and a pinned default operator public key;
  the standalone peer can verify and republish a signed policy file.
- Safer defaults: public network is receive-only, AIS is receive-only/private,
  and new installs must opt in before transmitting.
- Add a per-data-set sharing matrix in the webapp: Public plus every active group
  as columns, with checkboxes and no manual group IDs.
- Add group publish-rate caps set by group admins, with per-member rates inside
  the cap (supports 1–2 Hz small groups).
- Move advanced/sharing/security/topology settings into a plugin-owned
  `advanced.json` so the simplified Signal K config form cannot drop them; the
  form now exposes only relay and received-vessel toggles.
- Hide identity, claims and mesh details behind an Advanced disclosure in the
  webapp, and hide empty join-request/proposal sections.

## 0.3.0 — 2026-11-06

- Add a Public network card to the webapp with status, peers/elected relay and
  per-data-set public sharing toggles. Toggles persist to the plugin
  configuration and apply live.

## 0.2.2 — 2026-11-06

- Render the identity/status panel as readable fields instead of a JSON blob.
- Report the package version at runtime; the status was hard-coded to 0.1.0.

## 0.2.1 — 2026-11-06

- Fix the webapp API base to the actual plugin route
  (`/plugins/signalk-p2p-plugin`), which was returning HTTP 404.

## 0.2.0 — 2026-11-02

- The admin interface is now a Signal K webapp, listed under Webapps while the
  plugin is enabled. The admin-gated `/plugins/signalk-p2p-plugin/admin` route remains.

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
