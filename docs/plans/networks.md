# signalk-p2p — networks

**Status:** design. Ordering, names and numeric defaults are proposals.

Two classes of network, both live at once:

- **`all-vessels`** — one global public network, joined with a receive-only
  default; transmission is opt-in; implemented as adaptive geographic shards.
- **Groups** — any number of private, encrypted, invite-only networks with roles,
  a signed roster, and key rotation.

This document defines both, plus the rules that keep them separate.

---

## 1. The network abstraction

Every network is the same object:

```
Network {
  id, kind: public | group, name, enabled
  discoveryTopic
  sharePolicy        // derived from the per-data-set audiences (see shared-data.md)
  subscribePolicy    // all / own / AIS-only / off
  encryption         // none (public) or epoch key (group)
  membership         // open (public) or roster (group)
}
```

An instance joins a set of networks. A vessel publishes its own data into each
according to that network's policy, and ingests what each network carries.

---

## 2. The public network: `all-vessels`

- **Discovery topic** is derived from a fixed string,
  `H("signalk-p2p/all-vessels/v1")`, so every instance agrees without coordination.
- **Open join.** No membership, no invite, no encryption. Identity is a
  pseudonymous Ed25519 key.
- **Default on, receive-only.** The plugin joins immediately but publishes
  nothing until the owner chooses a consent mode. `receive-only`,
  `underway-gated`, `coarse-position` and `opt-out` are available.
- **Audiences** follow [`shared-data.md`](shared-data.md): each data set is shared
  publicly, with selected groups, or not at all, using the webapp matrix.
- **AIS** defaults to receive-only/private, capped and sampled by policy.
- **Topology and rates are centrally controlled.** Shard sizes, look-ahead,
  split/merge thresholds, election epoch/min-uptime, public snapshot rate caps
  and AIS caps come from a signed, versioned `NetworkPolicy`; clients cannot
  override them. See §2.1.
- **No fixed relays.** The mesh elects a relay/aggregator per shard from
  reachable peers; bootstrap peers are optional and replaceable.
- **Write authorization** is enforced by a replicated claim registry: each context
  is bound to one instance key, and only that key may publish it. MMSI ownership
  cannot be proven from the network alone; attested claims are marked verified, and
  an unverified claim is allowed but flagged. See [`security.md`](security.md) §5.

The user-visible model is one network. Under the hood it is a set of geographic
shards (§3), so no instance replicates the whole world.

### 2.1 Network policy

A small signed policy carries the network-wide settings:

```
NetworkPolicy {
  version, issuedAt, notBefore?, notAfter?
  topic, protocol
  sharding { maxVesselsPerShard, maxVesselsPerInstance, lookAheadKm,
             splitSettleMinutes, mergeSettleMinutes, mergeBelowRatio,
             boundaryHysteresisMeters }
  election { epochMinutes, minUptimeMinutes }
  rates    { maxSnapshotHzUnderway, maxSnapshotHzMoored }
  ais      { maxTargets, maxRateHz }
}
```

It is signed by the network operator. A signed default ships with the plugin; a
newer signed policy received over the mesh overrides it and is cached. Clients
verify the signature against pinned operator keys, reject rollback and invalid
values, and fall back to the shipped default if no live policy is available.
The operator's private key never goes to a relay; the standalone peer can
republish a signed policy file.

Write authorization, group approval and the public claim registry are specified in
[`security.md`](security.md).

---

## 3. Adaptive geographic sharding

### 3.1 Why

A single global firehose would mean every boat replicates every boat: O(N) inbound
per instance and O(N²) network-wide. On a metered link that is untenable, and most
of it is boats you will never see. Sharding bounds an instance's load by **local
density** rather than global fleet size.

### 3.2 The shard

A **shard** is a geographic bucket of vessel state:

```
Shard {
  key            // a bit-prefix of an interleaved lat/lon (geohash) key
  count          // live vessels placed in this shard
  members        // instance -> { coreKey, lastSeen }
  relays         // elected/bootstrap peers that serve this shard
}
```

- **Shard key** is a bit prefix of a geohash. Geohash interleaves latitude and
  longitude; one more bit halves the area. The default encoding is geohash; H3 is
  an alternative if its cell properties are preferred (it splits 7-way, so coarser
  transitions).
- A vessel's **home shard** is the shard containing its position, with boundary
  hysteresis: it switches only once it is a margin (default 1 km) inside the new
  shard, so a boat on a boundary does not flap between shards.
- Each vessel writes a **generation Hypercore per network** (see
  [`architecture.md`](architecture.md) §3.1). Shard membership is the set of
  vessels whose home shard is this shard; their cores are what peers in the shard
  replicate.

### 3.3 Sizing

Defaults, based on the bandwidth and load analysis in [`shared-data.md`](shared-data.md):

| Setting                 | Default | Meaning                                                           |
| ----------------------- | ------- | ----------------------------------------------------------------- |
| `maxVesselsPerShard`    | 500     | Split when a shard's live count exceeds this.                     |
| `maxVesselsPerInstance` | 1000    | Hard cap on total vessels ingested; evict farthest/stalest.       |
| `lookAheadKm`           | 50      | Join neighbouring shards within this radius, in addition to home. |
| `rateHzUnderway`        | 0.05    | Snapshot rate (shared-data §4).                                   |
| `rateHzMoored`          | 0.01    |                                                                   |

Inbound cost at the default rate, ~40 B per framed snapshot:

| Vessels in shard | Inbound/day | @ 0.1 Hz | Share of a 50 GB/mo plan |
| ---------------- | ----------- | -------- | ------------------------ |
| 100              | ~21 MB      | ~41 MB   | ~1.2%                    |
| **500**          | **~104 MB** | ~207 MB  | **~6%**                  |
| 1000             | ~207 MB     | ~415 MB  | ~12%                     |
| 5000             | ~1.0 GB     | ~2.1 GB  | ~60%                     |

These are engineering estimates. The spike in [`v1-design.md`](v1-design.md) is
where they get measured and the defaults adjusted.

### 3.4 Splitting and merging

- **Split** a shard when its live count exceeds `maxVesselsPerShard` for
  `splitSettleMinutes` (default 10). The split adds one bit to the key, producing
  two children. Splitting one bit at a time keeps transitions small; a denser
  area will split repeatedly over time.
- **Merge** a complete set of siblings when their combined count is below
  `maxVesselsPerShard / 4` for `mergeSettleMinutes` (default 60). The hysteresis
  ratio and the settle windows prevent oscillation.
- **No data migration.** Shard state is derived from each vessel's position, so
  after a split each member re-announces into its new home cell and subscribers
  follow the map. A brief overlap where parent and children are both served is
  acceptable.

### 3.5 The shard map

A small, signed, versioned document describing the current partition and each
shard's relays:

```
ShardMap {
  version, createdAt
  shards: [ { key, parent?, count, relays: [pubkey] } ]
  maxVesselsPerShard
}
```

- **A bootstrap peer publishes it initially.** A reachable, always-on peer (a
  VPS, a marina box) observes counts and writes the map. It is an ordinary peer,
  not an authority; the map is signed and verified. As a shard gains reachable
  peers, election can take over the relay list.
- The map is replicated as a durable artifact (a single-writer signed Hypercore in
  v1; Autobase if/when there are multiple writers).
- **Nodes follow** the newest map version they can verify. If no fresh map is
  reachable, a node keeps the last known map and may split its own over-full shard
  deterministically as a local fallback. Convergence resumes when a bootstrap peer
  or elected relay is reachable.

### 3.6 What an instance subscribes to

- Its **home shard** (always).
- Neighbouring shards within `lookAheadKm`, nearest first, up to
  `maxVesselsPerInstance`.
- Eviction is by distance from the vessel, then by staleness.

This is why the design is "global by default" without a global firehose: the
logical network is worldwide, the transport is local.

### 3.7 Bootstrap peers, relays and election

There are **no required fixed relays**. Any reachable peer can relay or aggregate,
and the mesh elects one aggregator per shard.

- **Bootstrap peers** are optional always-on peers — a VPS, a marina server, a
  club box, or a well-connected boat — used to reach the mesh initially and to
  bridge pairs that cannot hole-punch. They are ordinary peers, not authorities,
  and can be replaced at any time. The repository ships a standalone Node.js peer
  for this ([`peer-node.md`](peer-node.md)).
- **Election.** Peers advertise a capability record over the live channel:

  ```
  Capability {
    topic, selfId, updatedAt, uptimeSince,
    relayConsent, reachable, unmetered,
    capacity, load
  }
  ```

  Eligible peers are ranked by **weighted rendezvous hashing** over
  `(epoch, topic, key)` with `capacity` virtual points. The highest wins; ties
  break by key. Every peer with the same view computes the same winner, the epoch
  rotates the role, and the next in rank is the failover. No vote and no central
  coordinator.

- **Who is eligible.** `relayConsent`, `reachable` and `unmetered` must all be
  true, the record must be fresh (120 s), and uptime must exceed the configured
  minimum. Clients default to `relayConsent: false`; the standalone peer
  advertises `relayConsent/reachable/unmetered` with capacity 10, so it is the
  initial elected peer. As clients opt in, the role rotates.
- **Routing.** Clients send their batches to the elected aggregator when it is
  connected, and fall back to all connected peers when no eligible aggregator is
  known. Only the elected aggregator forwards; non-elected relays drop data.
  Every peer deduplicates by message signature, so a brief election overlap cannot
  loop data. The standalone relay forwards as a fallback while no peer is
  eligible (for example, immediately after a restart).
- **Eligibility** excludes metered/roaming links and peers that have not
  consented to relay. Capacity claims are not trustworthy on their own; verify
  reachability and weight by tenure/attestation. Sybil resistance remains future
  work.
- **Gossip fallback.** If no aggregator is reachable, peers fall back to a
  bounded-degree gossip mesh: each peer forwards to a few neighbours. That costs
  duplicate traffic but keeps the network alive with no hub at all.
- **CGNAT tail.** A peer that cannot be dialled can still dial out. If it cannot
  hole-punch at all, a reachable volunteer peer (or a bootstrap peer) relays for
  it. That is a connectivity fallback, not a data authority.
- **Group relays.** A group admin may designate a member or a group-run peer as
  its relay; a group's relay must be a member because it needs the epoch key.
  The standalone peer supports this with `--group-invite` (see
  [`peer-node.md`](peer-node.md)).

Relays cannot forge a signed record; they can only serve, delay or withhold it.

---

## 4. Closed groups

A group is a private, encrypted network with an explicit membership.

**Implemented v1.** The roster is a **multi-signature, versioned proposal**
rather than an Autobase; members apply the highest version with enough approvals
from the roster topic. A change is adopted when `adminThreshold` distinct
current admins have signed the same candidate; below the threshold it is stored
and broadcast as a proposal and other admins approve it through the API. An
invite contains the approved roster and the epoch key. A joiner sends a signed
join request; an admin approves it, checks selfId/MMSI uniqueness, wraps the
epoch key to the new member's X25519 key, and the approved roster is broadcast.
Removal rotates the epoch key and data topic. Group data records are AES-256-GCM
encrypted with a key derived from the epoch key, so a relay must be a member.
Members request the latest approved roster and pending proposals on start and
every minute, so an instance that was offline catches up when it reconnects. The
Autobase event log below is the intended scale-out; v1 uses approved snapshots
plus catch-up.

### 4.1 Roles

| Role     | Can do                                                                       |
| -------- | ---------------------------------------------------------------------------- |
| `owner`  | Everything an admin can; cannot be removed except by transferring ownership. |
| `admin`  | Invite, remove, promote/demote, re-key, rename.                              |
| `member` | Publish and subscribe with the group's policy.                               |
| `viewer` | Subscribe only; cannot publish.                                              |

### 4.2 Roster

Membership is an ordered, signed log — an **Autobase** whose writers are the
owner and admins. Events:

```
genesis(owner, groupId, groupPublicKey)
invite(actor, role, expiresAt, nonce?)
joinRequest(instanceKey, claimedSelfId, claimedMmsi?, keyProof, nonce)
add(actor, instanceKey, approvedSelfId, approvedMmsi?, role)
updateIdentity(actor, instanceKey, approvedSelfId, approvedMmsi?)
promote(actor, member, role)
demote(actor, member, role)
remove(actor, member)
rekey(actor, epoch, wrappedKeys{ member -> sealed(epochKey) })
rename(actor, name)
dissolve(actor)
```

`apply()` validates the signer's role at that point in the linearization and
rejects events from non-admins. It also enforces that **no two active members share
an approved MMSI or selfId**, and that an `approvedSelfId` is an MMSI URN or a
Signal K UUID URN. The resulting view is the current roster and the current epoch.
Every member replicates the roster; removed members can still read it (they are
told they were removed) but cannot unwrap the new epoch key.

A member may only publish self records whose context equals its
`approvedSelfId`; receivers enforce this against the roster. See
[`security.md`](security.md) §3–§4.

### 4.3 Keys and topics

- `groupId` — a random 32-byte identifier.
- **Roster topic** — `H(groupId)`, stable, so membership changes are always
  discoverable by anyone who knows the group.
- **Epoch key** — a 32-byte symmetric key that rotates on removal (and optionally
  on a schedule). The data topic is `H(epochKey || "data")`; data cores are
  encrypted with a key derived from the epoch key.
- Rotating the topic is what makes removal effective: without the new epoch key a
  removed member can neither discover nor decrypt the new data channel.

### 4.4 Invites

A shareable link, simple to start with:

```
signalk-p2p://join/<base64url>{
  v, groupId, groupPublicKey, epoch, epochKey,
  role, expiresAt, nonce, inviterPublicKey, signature
}>
```

- Anyone holding it can join until `expiresAt` (default 24 hours).
- Optionally single-use: the admin records the nonce; a second `join` with the
  same nonce is rejected.
- It is a bearer token: treat it as a secret. The UI should say so.
- Opening the invite sends a **join request** with the vessel's instance key and
  claimed selfId/MMSI. An admin approves it explicitly (`add`), which is when the
  MMSI is bound. The invite alone does not grant write access, and each invite is
  single-use per admin.
- An invite may be pre-bound to an expected MMSI; in that case the join succeeds
  only if the claim matches.

### 4.5 Removal and re-keying

1. An admin writes `remove(member)` and `rekey(epoch+1)`.
2. A new epoch key is generated and **wrapped individually** for each remaining
   member (sealed box to their key). The wrapped keys travel in the rekey event on
   the stable roster topic.
3. The data topic changes to the new epoch. Members start a fresh core generation
   and re-announce; the removed member cannot follow.
4. Offline members unwrap the new key when they next fetch the roster.

**Forward secrecy only.** The removed member retains the old epoch key and can
still read data they already had, plus any old cores they kept. Rotation protects
new data, not history. This is stated in the UI.

### 4.6 Group data plane

Small membership, so the simple model works:

- Each member has **one generation Hypercore per group**, encrypted with the
  epoch key.
- The roster maps instance → core key; on connect, peers exchange the current core
  list over a Protomux control channel.
- Members replicate each other's tails. With a handful to a few tens of boats this
  is cheap; beyond that, apply the same sharding or add a group relay.

### 4.7 Admin availability

If every admin is offline, the group keeps running on the current epoch but no
membership changes or re-keys can happen. Options (open): allow the owner to
delegate a "steward" key, or let a designated always-on member hold a re-key capability.
v1 accepts the limitation and documents it.

---

## 5. Keeping networks separate

- **No bridging.** Data received on one network is never published to another.
  Only the local vessel (and locally heard AIS) is publish-eligible.
- **Independent policy.** Each network has its own consent mode and rates, and each
  data set chooses its audiences independently. Enabling systems data for a group
  does not touch the public network.
- **Independent cryptography.** A group's epoch key has nothing to do with the
  public identity. A public observer learns only the instance's public key and
  whatever the public policy shares.
- **A group cannot be discovered from the public network.** Its topic is derived
  from the epoch key, which only members hold.

---

## 6. Configuration sketch

```jsonc
{
  "identity": { "keyFile": "auto" },
  "sharding": {
    "maxVesselsPerShard": 500,
    "maxVesselsPerInstance": 1000,
    "lookAheadKm": 50,
    "splitSettleMinutes": 10,
    "mergeSettleMinutes": 60,
    "mergeBelowRatio": 0.25,
    "boundaryHysteresisMeters": 1000,
  },
  "bootstrapPeers": [],
  "election": {
    "enabled": true,
    "epochMinutes": 10,
    "minUptimeMinutes": 10,
  },
  "security": {
    "publicAttestors": ["<attestor pubkey>", "..."],
    "requireAttestation": false,
    "attestationThreshold": 1,
  },
  "sharing": {
    "identity": { "public": true, "groups": "all" },
    "position": { "public": true, "groups": "all" },
    "navigation": { "public": true, "groups": "all" },
    "depth": { "public": true, "groups": "all" },
    "temperature": { "public": false, "groups": "all" },
    "wind": { "public": false, "groups": "all" },
    "pressureHumidity": { "public": false, "groups": "all" },
    "tanksFuel": { "public": false, "groups": [] },
    "tanksFreshWater": { "public": false, "groups": [] },
    "tanksHolding": { "public": false, "groups": [] },
    "destination": { "public": false, "groups": ["grp_7f3c"] },
    "anchor": { "public": false, "groups": "all" },
    "propulsion": { "public": false, "groups": ["grp_7f3c"] },
    "systems": { "public": false, "groups": [] },
  },
  "ais": {
    "public": true,
    "groups": [],
    "mode": "both",
    "maxTargets": 100,
    "rateHz": 0.02,
  },
  "networks": [
    {
      "id": "all-vessels",
      "kind": "public",
      "enabled": true,
      "consent": "opt-out",
      "rateHzUnderway": 0.05,
      "rateHzMoored": 0.01,
    },
    {
      "id": "grp_7f3c",
      "kind": "group",
      "name": "Yacht Club",
      "enabled": true,
      "invite": "<token, only while joining>",
      "consent": "opt-out",
      "rateHzUnderway": 0.1,
      "rateHzMoored": 0.02,
    },
  ],
}
```

---

## 7. Open questions

- Election convergence and anti-gaming: how do peers agree on a shard's
  capability view, and how do we stop a peer claiming capacity it does not have?
- Shard-map authority when there are no long-lived bootstrap peers: who publishes
  the map, and how does it converge?
- Should `lookAheadKm` be a radius or a ring count (e.g. home + 8 neighbours)?
- Group scale: at what membership does per-member core replication need a relay or
  sharding?
- Key rotation cadence for groups that never remove anyone (time-based rotation is
  optional; it costs a re-key each time).
- Whether a group can be exported/backed up as a roster snapshot for disaster
  recovery.
- MMSI ownership verification: there is no authoritative source today. Attestor
  verification is the v1 mitigation; how should attestors verify, and who governs
  the attestor set?
- Should the public network require attestation for every member
  (`requireAttestation`) by default, at the cost of onboarding friction?
