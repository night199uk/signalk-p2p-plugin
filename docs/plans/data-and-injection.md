# signalk-p2p — data, wire format and injection

**Status:** provisional. The field sets are settled; the exact byte packing is
frozen only after the spike in [`v1-design.md`](v1-design.md).

This document covers how shared values are encoded, merged, and injected into the
local Signal K tree, and how loops and cross-network leaks are prevented. The
_which paths_ question is in [`shared-data.md`](shared-data.md).

---

## 1. Records

Every Hypercore block is one envelope:

```
Envelope {
  u8   version        // protocol major version (1)
  u8   type           // 1 SNAPSHOT, 2 STATIC, 3 AIS_SNAPSHOT, 4 AIS_STATIC, 5 CONTROL
  u16  length         // payload bytes
  payload
}
```

Values are Signal K native SI units. Times are Unix seconds (`u32`, valid to
2106); sub-second precision is not needed for situational awareness. Ties are
broken by writer identity, not by finer clocks.

### 1.1 Snapshot (own vessel)

```
Snapshot {
  u8   version      // 2
  u16  flags        // position, mmsi, cog, sog, heading, state, gnss, coarse, underway
  u16  flags2       // cogMagnetic, headingMagnetic, variation, attitude,
                    // rateOfTurn, speedThroughWater, hdop, vdop, satellites
  u32  t
  i32  lat?         // 1e-7 degrees; present iff hasPosition
  i32  lon?         // 1e-7 degrees; present iff hasPosition
  u16  cog
  u16  sog
  u16  hdg
  u8   navState
  u8   gnssQuality
  u32  mmsi?
  // extended navigation, all conditional:
  u16  cogMagnetic; u16 headingMagnetic; i16 variation
  i16  roll, pitch, yaw
  i16  rateOfTurn
  u16  speedThroughWater
  u16  hdop, vdop
  u8   satellites
}
```

≈ 31 bytes with position and the core fields; up to ≈ 60 with every extended
field. The bandwidth tables assume position plus the core fields.

The non-navigation sets (environment, tanks, destination, anchor, propulsion and
systems) travel in the generic `Values` record, not here.

Position is optional because it is its own data set: a user may share
navigation (course, speed, heading) without sharing where they are. The
`underway` and `coarse` flags are meaningful only when `hasPosition` is set; they
let receivers apply eviction and staleness correctly and know a position is
grid-rounded.

### 1.2 Static (own vessel)

```
Static {
  u8    version
  u8    flags      // hasMMSI, hasIMO, hasCallsign, hasShipType, hasDims, hasAisOffsets
  u32   mmsi?
  u32   imo?
  u16   shipType            // design.aisShipType.id
  u16   loaCm, beamCm, draftCm
  i16   fromBowCm, fromCenterCm
  u8    selfIdLen;   u8[] selfId    // sender's Signal K selfId:
                                    // urn:mrn:imo:mmsi:<mmsi> or
                                    // urn:mrn:signalk:uuid:<uuid>
  u8    nameLen;     u8[] name
  u8    callsignLen; u8[] callsign
}
```

Sent on start, on change, daily, and to each newly connected peer, so a receiver
can map the sender's core to its vessel context. It is never repeated per
snapshot.

### 1.3 Values (non-navigation data sets)

The lower-rate data sets — environment, tanks, propulsion, systems, destination
and anchor — use a generic record instead of a bespoke layout per set:

```
Values {
  u8   version
  u8   flags
  u32  t
  u16  count
  cbor map<string, value>   // canonical Signal K path -> value in SI units
}
```

- Only enabled data sets appear; values are coalesced per snapshot.
- CBOR keeps this extensible as new data sets are added, while the hot navigation
  path stays fixed-layout.
- Only canonical Signal K paths are accepted on receive; unknown paths are ignored
  (the allowlist still applies).
- Compound values are atomic, as in the snapshot.

### 1.4 AIS records (other vessels, when enabled)

```
AisSnapshot {
  u8   version
  u8   flags
  u32  mmsi
  u32  t
  i32  lat, lon
  u16  cog, sog, hdg
  u8   navState
}

AisStatic {
  u8   version
  u8   flags
  u32  mmsi
  u16  shipType
  u8   nameLen;     u8[] name
  u8   callsignLen; u8[] callsign
}
```

AIS records are **observations**: the LiveMessage source is the observer and the
target MMSI is in the record. A self record for the same context outranks an
observation; the receiver drops AIS observations while a self record is fresh
(300 s) and dedupes observations by MMSI/timestamp.

An observer sends `AisStatic` on first observation or change, and `AisSnapshot`
for kinematics at the AIS rate. **Only locally heard targets are ever written**;
received AIS is never re-published.

### 1.5 Core generations (bounded live retention)

Hypercore is append-only: you cannot drop blocks from the head. Bounded live
retention is therefore implemented by **generation rotation**, not truncation:

- Each generation core begins with a **core certificate** signed by the instance
  key, binding the generation's feed key to the instance (see
  [`security.md`](security.md) §2). Receivers reject blocks from an uncertified or
  mis-bound core.
- A writer keeps a **current generation** core with a cap
  (`generationMinutes`, default 60, and/or `generationBlocks`).
- When the cap is reached, the writer opens a **new generation**, announces its
  key over the network's control channel, and starts writing there.
- Readers follow the newest generation and ignore older ones unless they are
  catching up.
- Old generations are deleted locally after a retention window; they are not part
  of the live plane. (A relay may keep a longer window for availability.)

This is what keeps a live channel a bounded ring buffer rather than an ever-growing
log. The static record is re-sent at the start of each generation so a reader
joining mid-stream still has identity.

### 1.6 Live message (transport)

The live relay forwards **length-prefixed LiveMessages**, each containing one
source and a batch of envelopes:

```
LiveMessage {
  u32  length        // total, including header and signature
  u8   version       // 2
  u8   kind          // 1 = batch
  u8   flags         // bit 0: signed
  u8[32] sourceKey    // instance Ed25519 public key
  u8   selfIdLen
  u8[] selfId        // e.g. urn:mrn:imo:mmsi:… or urn:mrn:signalk:uuid:…
  u16  recordCount
  repeated:
    u16 recordLen
    record          // a self-contained envelope (snapshot/static/values/AIS)
  u8[64] signature?  // over every preceding byte, including `length`
}
```

- A relay concatenates opaque LiveMessages from several sources. The outer length
  is what lets a receiver split them again.
- The relay never needs the keys or the record contents. It can drop or delay, but
  it cannot forge a record.
- **Messages are signed.** The sender signs with its instance key; the receiver
  verifies the signature against `sourceKey` and rejects unsigned or tampered
  messages.
- **Claim records.** A `claim` envelope carries a `ClaimRecord`: a vessel's claim
  of its `selfId`, or an attestor's signed attestation/revocation. A claim is
  authenticated by the LiveMessage signature; attestations and revocations carry
  their own Ed25519 signature over canonical claim bytes.
- **Authorization.** The receiver stores these in the claim registry
  ([`security.md`](security.md) §5) and uses it to authorize data records. The
  registry binds a `selfId` to one key; an attested claim overrides an unverified
  one, and a revocation disables it.
- **Capabilities.** A `capability` envelope carries a control advertisement
  (`relayConsent`, `reachable`, `unmetered`, `capacity`, uptime, load) used by the
  relay election. It is not vessel data.
- **Groups.** Group data (`snapshot`/`static`/`values`) is AES-256-GCM encrypted
  with a key derived from the epoch key before the LiveMessage is signed, so a
  relay forwards ciphertext. Group control uses plaintext, signed
  `group-roster` and `group-join` records on the stable roster topic.

---

## 2. Merge semantics

Before merging, the receiver **authorizes** the record (see
[`security.md`](security.md) §3):

1. Verify the core certificate and attribute the block to an instance key.
2. For a **self** record (`Snapshot`, `Static`), the sender's selfId must be bound
   to that instance key — by the group roster, or by the public claim registry.
   Otherwise the record is rejected.
3. For an **observation** (`AIS_SNAPSHOT`, `AIS_STATIC`), accept it from any
   authorized participant of the network and tag it as an observation. It can never
   outrank a self record for the same context.

Only then:

- **Per `(context, path)` last-writer-wins**, ordered by the record timestamp.
  Equal timestamps are broken deterministically by writer public key, then by
  block sequence.
- **Compound values are atomic.** `navigation.position`, `design.length` and
  `navigation.attitude` are replaced whole; their children are never merged
  independently.
- **Precedence.**
  - The self context is never modified by remote data.
  - A self record outranks an AIS observation for the same context.
  - For another vessel, local AIS and remote data share the same context; the
    newest timestamp wins. On an exact tie, local wins.
  - A remote snapshot older than what the local tree already holds is dropped.
- **Staleness.** A vessel with no update for `maxAgeSeconds` (default 900) is no
  longer refreshed; the server's normal context pruning removes it.

---

## 3. Injection into Signal K

### 3.1 Context naming

| Case          | Context                                                             |
| ------------- | ------------------------------------------------------------------- |
| Remote vessel | `vessels.<selfId>` — exactly the sender's own Signal K self context |
| AIS target    | `vessels.urn:mrn:imo:mmsi:<mmsi>`                                   |

`selfId` is whatever the sender's Signal K server uses:

- `urn:mrn:imo:mmsi:<mmsi>` when the vessel has an MMSI;
- `urn:mrn:signalk:uuid:<uuid>` (the server-generated UUID) when it does not.

We do **not** invent a P2P-specific context. The sender advertises its `selfId` in
the static record, and the receiver binds it to the sending instance key. A vessel
therefore keeps the same context across every instance that sees it, and the MMSI
namespace still collapses a local AIS target and its P2P report into one vessel.

Every remote vessel is a **top-level vessel context**. Nothing is nested under the
self context (`vessels.self` / `vessels.<selfId>`); that tree is written only by
local sensors. A remote claim on the self vessel's selfId or MMSI is ignored for
self and can never alter it.

### 3.2 Delta shape

```jsonc
{
  "context": "vessels.urn:mrn:imo:mmsi:123456789",
  "updates": [
    {
      "timestamp": "2026-10-19T09:14:00.000Z",
      "source": {
        "label": "signalk-p2p",
        "type": "p2p",
        "network": "all-vessels",
      },
      "values": [
        {
          "path": "navigation.position",
          "value": { "latitude": 50.1, "longitude": -1.2 },
        },
        { "path": "navigation.speedOverGround", "value": 5.1 },
      ],
    },
  ],
}
```

Only changed paths are emitted, and they are coalesced into one update per
snapshot. The `network` field is an extension; the stable contract is the
`label`/`type` pair, which is also the filter hook for history.

### 3.3 Limits and eviction

- At most `maxVesselsPerInstance` injected vessels, nearest-first.
- Evict by distance, then staleness.
- Vessels whose last update is older than `maxAgeSeconds` stop being refreshed;
  pruning is left to the server so we do not fight its `pruneContextsMinutes`.

### 3.4 History

**Injected P2P vessels are excluded from history by default.** At 500 vessels and
0.05 Hz that is 25 writes/s; at 0.1 Hz it is 50 writes/s, which is a heavier load
than the network itself on a small server. History plugins can filter on
`source.label === "signalk-p2p"`; the plugin exposes the setting and documents the
hook. Enabling history for P2P vessels is opt-in.

---

## 4. Loop prevention and no bridging

The publish path and the inject path are deliberately asymmetric:

```
local self ─┐
            ├─► publish policy ─► network A, B, …      (OUT)
local AIS ──┘

network A ──► merge/evict ─► inject ─► local tree      (IN)
                                   └─► NOT publishable
```

- The publisher subscribes **only** to the self context and to locally-sourced
  AIS contexts. It never subscribes to `vessels.*`.
- Any delta whose `source.label` is `signalk-p2p` is ignored by the publisher.
- Each ingested record carries an internal `origin` tag; only `origin === local`
  is publish-eligible. This is asserted before every write to a network.
- AIS publishing reads only targets heard by the local receiver, never targets
  that arrived over P2P.
- There is no configuration that bridges a network into another in v1. If one is
  ever added, it must be explicit, per-path, and loudly flagged.

---

## 5. Identity and MMSI conflicts

- The instance key is the cryptographic identity; the Signal K `selfId` (MMSI or
  UUID), name and callsign are claims. See [`security.md`](security.md) for the
  authorization model.
- The sender advertises its `selfId` in the static record; the receiver binds it
  to the sending instance key and checks that binding against the roster or claim
  registry. A member can only write its approved context.
- If two instance keys claim the same `selfId`, the receiver picks a winner by:
  1. local data, if present;
  2. newest static record timestamp;
  3. lowest public key, deterministically.
     The conflict is surfaced in plugin status rather than silently resolved.
- A remote claim on the self vessel's `selfId` or MMSI is ignored for self.
- A vessel that later gains an MMSI changes its `selfId`; the stable instance key
  lets us treat that as a rename of the same boat rather than a new one.
- v1 does not attempt to prove that a claim is true. The source identity is
  displayed, and reputation/attestation is deferred. A malicious peer can claim a
  selfId; that is a known limitation of a pseudonymous open network, not a bug.

---

## 6. Versioning

- `version` is the protocol major version, present in the envelope and each core's
  first block.
- Unknown major versions are not decoded; the peer/core is skipped and the
  condition is reported in status.
- New optional fields are added under new flag bits, never by changing the meaning
  of an existing field.
- Discovery topics carry the version (`…/v1`) so incompatible generations do not
  connect and confuse each other.
- Group rosters carry their own format version and are validated on join.

---

## 7. Open questions

- Exact packing for `Values`: CBOR versus a protocol path-id dictionary. The
  snapshot is fixed-layout already; the spike should measure CBOR overhead at
  realistic record sizes.
- Generation length and retention: time-based (60 min) versus block-based, and how
  much a relay should keep.
- Static is re-sent on connect and at generation start; is an additional periodic
  refresh needed, and at what interval?
- How should a `selfId` change be handled when a vessel gains (or loses) an MMSI:
  rename the context, keep the UUID context, or alias both under the stable
  instance key?
- Whether to carry any Signal K metadata (units are SI by definition; zones and
  display metadata are probably out of scope).
- How to express a vessel that is heard by AIS and also runs Signal K P2P without
  double-counting it in the public map.
