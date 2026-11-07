# signalk-p2p — the standalone peer node

**Status:** implemented skeleton. The relay/aggregator works; peer election and
end-to-end record signatures are the next steps.

The plugin is not the only kind of participant. A **peer node** is a small
Node.js process that runs outside Signal K, on an always-on host: a VPS, a marina
server, a club box, or a well-connected boat. It speaks the same protocol as the
plugin and helps the mesh when boats cannot reach each other directly.

It is an ordinary peer, not a central authority.

---

## 1. Why it exists

Almost every boat is behind CGNAT (Starlink, LTE, marina WiFi). Those boats can
make outbound connections but often cannot accept incoming ones. A peer node is
reachable, so it can:

- **bootstrap** the first few clients when there is no one else to connect to;
- **relay** encrypted batches between boats that cannot connect directly;
- **aggregate** snapshots for a few seconds into one batch, so the per-block
  overhead is amortised (see [`spike-findings.md`](spike-findings.md));
- **seed** recent history for peers that join late.

The first public peer will probably be a VPS, because it is the only always-on,
publicly reachable participant at the start. That does **not** make it a server:
it cannot forge records, it holds no authority, and an elected peer can replace
it once enough reachable boats exist.

---

## 2. What it can and cannot do

| Can                                  | Cannot                                          |
| ------------------------------------ | ----------------------------------------------- |
| Join a topic and accept connections  | Forge a vessel record                           |
| Forward opaque batches between peers | Read encrypted group data it is not a member of |
| Coalesce batches to reduce overhead  | Change a signed record without detection        |
| Replay recent batches to new peers   | Decide who owns an MMSI                         |
| Serve as the initial bootstrap peer  | Require special trust to keep the network alive |

A relay sees the metadata it forwards (and the public network's content). It can
withhold or reorder; it cannot silently alter a signed record. That is why
running more than one peer is useful, and why end-to-end signatures and
authorization remain the receivers' job.

---

## 3. Running it

After `npm install && npm run build`:

```bash
# defaults: ./data, the public all-vessels topic, 2 s batching
npx signalk-p2p-peer

# explicit settings
npx signalk-p2p-peer \
  --data-dir /var/lib/signalk-p2p \
  --topic signalk-p2p/all-vessels/v1 \
  --batch-interval 2000 \
  --history 10 \
  --port 49737 \
  --policy /etc/signalk-p2p/policy.json
```

During development:

```bash
npm run peer           # tsx, no build step
npm run peer:start     # compiled dist/peer/cli.js
```

### Config file

```json
{
  "dataDir": "/var/lib/signalk-p2p",
  "topic": "signalk-p2p/all-vessels/v1",
  "batchIntervalMs": 2000,
  "maxBatchBytes": 65536,
  "historyBatches": 10,
  "port": 49737,
  "policyFile": "/etc/signalk-p2p/policy.json"
}
```

`policyFile` is optional. When set, the peer verifies and republishes the signed
network policy every five minutes; it never needs the operator private key.

```bash
npx signalk-p2p-peer --config /etc/signalk-p2p/peer.json
```

CLI options override the file. The peer stores a persistent Ed25519 identity in
`<dataDir>/identity/ed25519.pem` (mode 0600) on first start.

### Relaying a private group

Create an invite from a group admin, then start the peer with it:

```bash
npx signalk-p2p-peer --group-invite '<token>'
```

The peer joins the group's roster topic, sends a join request from its synthetic
selfId (`urn:mrn:signalk:p2p:peer:<fingerprint>`), and waits for an admin to
approve it. Approve it as a `viewer` (it does not publish vessel data) or
`member`. Once admitted it relays the encrypted group data and follows epoch
rekeys automatically. Removing it from the group rekeys the group, and the peer
stops relaying the new epoch.

Several group invites can be listed in the config:

```json
{ "groupInvites": ["<token>", "..."] }
```

The invite is a bearer secret. The peer stores the resulting group state,
including the epoch key, in `<dataDir>/groups.json` (mode 0600).

### systemd

```ini
[Unit]
Description=Signal K P2P peer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=signalk-p2p
ExecStart=/usr/bin/npx signalk-p2p-peer --config /etc/signalk-p2p/peer.json
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/signalk-p2p

[Install]
WantedBy=multi-user.target
```

### Firewall

Hyperswarm uses UDP. Allow the configured DHT port (`49737` above) if you want a
stable firewall rule; otherwise it uses an ephemeral UDP port. Outbound UDP must
be allowed regardless. TCP is not required for the peer.

---

## 4. Peer election

The peer is designed to be replaceable. The target model is:

1. Peers in a shard advertise a **capability record**: reachable, uptime,
   capacity, unmetered link, owner consent (and, later, an attestation).
2. The shard converges on a membership view.
3. A deterministic score chooses the top **aggregator** for an epoch, with a
   tie-break by key. No vote and no central coordinator.
4. If it disappears, the next in rank takes over. Rotation spreads the cost.
5. A VPS peer wins initially because it is reachable and always on; as more
   reachable peers join, the role can move.

Eligibility must exclude metered/roaming links, low-power hosts and peers that
have not consented to relay. Anti-Sybil weighting and attestation are future
work; capacity claims are not trustworthy on their own.

The election mechanism is implemented: peers advertise capabilities and elect a
relay with weighted rendezvous hashing. The peer advertises
`relayConsent/reachable/unmetered` with capacity 10, so it is the initial elected
peer. Routing is enforced: clients send to the elected aggregator, only it
forwards, and the relay forwards as a fallback while no peer is eligible.

---

## 5. Security model

- The peer has its own Ed25519 **identity**, used for the connection and for
  logging/attestation. It does **not** hold the vessel keys of the boats it
  relays for.
- It forwards **opaque envelopes**. It can read the public network's content and
  encrypted groups it belongs to, but it cannot forge a vessel's record.
- It can drop, delay or reorder. Receivers must verify signatures/authorization
  and use timestamps/merge rules; multiple independent peers reduce the impact.
- A group's relay must be a group member (it needs the epoch key). A public relay
  needs no membership.
- The peer does not decide MMSI ownership. That is the claim registry's job
  (see [`security.md`](security.md)).

---

## 6. Validation

On 2026-10-19 a peer was deployed on a Fedora 44 VPS (Node 22.23.1):

- It joined the public `all-vessels` topic and accepted a second peer.
- Two clients on a different network, behind NAT, found it over the public DHT.
- One client's batch was forwarded to the other through the peer, proving the
  full WAN path: client → relay → client.
- Two mock Signal K instances then ran the real plugin path: Vessel A published a
  snapshot, the VPS relay forwarded it, and Vessel B injected it with
  `source: signalk-p2p` and the correct position, course, speed and heading.
- A capability smoke test connected to the relay, received its advertisement and
  elected it: `relay=true reachable=true unmetered=true capacity=10`.
- With routing enforced, the relay's log showed the data path:
  `forwarded 517 B to 2 peer(s)`, while the two mock Signal K instances still
  injected each other's data and completed the attestation.
- The service used ~41 MB RSS; the identity file was created mode `0600`.
- The service is enabled at boot and restarts on failure.

The unit and config used are in [`deploy/`](../../deploy/).

---

## 7. Limitations and next steps

- The v1 peer forwards opaque batches; end-to-end record signatures and
  authorization checks are still to be layered on.
- Election is specified but not implemented.
- No `/metrics` endpoint yet; use logs and process counters.
- A peer with a fixed public IP is the initial bootstrap. Multiple peers should be
  run for resilience; they do not need to agree on anything to relay.
