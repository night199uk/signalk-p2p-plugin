# signalk-p2p — what we share

**Status:** proposed spec. This is the product-facing definition of the data that
leaves a boat. It should be settled before any wire format is frozen.

The unit of control is the **data set**, not the network. Each data set is a named
group of Signal K paths with its own audience:

- **Share publicly** — publish it on the global `all-vessels` network;
- **Share with groups** — publish it on the selected groups (all, or a chosen few);
- **Don't share** — publish it nowhere.

The categories below are the first set. New categories are additive: a new data
set is a name, a path matcher and a default audience, so they can be added as users
ask without changing the transport.

See [`architecture.md`](architecture.md) for the invariants this must obey and
[`data-and-injection.md`](data-and-injection.md) for how values are encoded.

---

## 1. Principles

- **Own vessel only, by default.** The plugin publishes the self vessel. Locally
  heard AIS targets are a separate data set (§6).
- **Allowlist, never blocklist.** A path is shared only if it belongs to an enabled
  data set. Unmatched paths are dropped, including anything new the server adds.
- **Per data set, per audience.** Enabling a set for one group does not enable it
  publicly, and vice versa.
- **Bounded.** Every data set has a rate and a coalescing rule. Nothing streams at
  raw sensor rate.
- **Sensitive classes stay off.** Electrical, credentials, plugin internals and
  unfiltered sensors are not in the default set.

---

## 2. Data sets and defaults

| Data set                             | Contains                                     | Public default   | Groups default    |
| ------------------------------------ | -------------------------------------------- | ---------------- | ----------------- |
| **Identity & static**                | Name, MMSI, IMO, callsign, type, dimensions  | **share**        | all               |
| **Position**                         | `navigation.position`                        | **share**        | all               |
| **Navigation & safety**              | COG/SOG, heading, attitude, ROT, state, GNSS | **share**        | all               |
| **Depth**                            | `environment.depth.*`                        | **share**        | all               |
| **Environment: Temperature**         | Air, water and inside temperatures           | don't share      | all               |
| **Environment: Wind**                | True and apparent wind                       | don't share      | all               |
| **Environment: Pressure & humidity** | Pressure, humidity, dew point, air density   | don't share      | all               |
| **Tanks: Fuel**                      | `tanks.fuel.*`                               | don't share      | don't share       |
| **Tanks: Fresh water**               | `tanks.freshWater.*`                         | don't share      | don't share       |
| **Tanks: Holding**                   | `tanks.blackWater.*`, `tanks.wasteWater.*`   | don't share      | don't share       |
| **Destination**                      | `navigation.destination.*`                   | don't share      | don't share       |
| **Anchor**                           | `navigation.anchor.*`                        | don't share      | all               |
| **Propulsion**                       | `propulsion.*`, legacy `engine.*`            | don't share      | don't share       |
| **Systems**                          | Steering, sensors, lights                    | don't share      | don't share       |
| **AIS (other vessels)**              | Locally heard AIS targets                    | **share** (both) | don't share (off) |

The group default "all" means "every group currently configured, and any group
added later." The user can narrow any data set to specific groups. "Don't share"
in both columns means the set is off until the user opts in.

Signal K uses the plural **`tanks.*`**. There is no single
`environment.temperature.*`; the Temperature set groups the canonical paths below.

### 2.1 Identity & static

| Path                     | Notes                                     |
| ------------------------ | ----------------------------------------- |
| `name`                   | Vessel name                               |
| `mmsi`                   | If known                                  |
| `imo`                    | If known                                  |
| `callsign`               | If known                                  |
| `design.aisShipType`     | `{ id, name }`                            |
| `design.length`          | `{ overall, hull, waterline }`            |
| `design.beam`            |                                           |
| `design.draft`           | `{ maximum, minimum, current }`           |
| `sensors.ais.fromBow`    | Optional; helps draw the vessel correctly |
| `sensors.ais.fromCenter` | Optional                                  |

### 2.2 Position

| Path                  | Notes                                                                      |
| --------------------- | -------------------------------------------------------------------------- |
| `navigation.position` | Compound: latitude, longitude, altitude. Subject to the consent mode (§4). |

Position is its own set so a user can share where they are without sharing how
they are moving (or vice versa).

### 2.3 Navigation & safety

| Path                                  | Notes                              |
| ------------------------------------- | ---------------------------------- |
| `navigation.courseOverGroundTrue`     | Radians                            |
| `navigation.courseOverGroundMagnetic` | If available                       |
| `navigation.speedOverGround`          | m/s                                |
| `navigation.speedThroughWater`        | If available                       |
| `navigation.headingTrue`              | Radians                            |
| `navigation.headingMagnetic`          | If available                       |
| `navigation.magneticVariation`        | If available                       |
| `navigation.attitude`                 | `{ roll, pitch, yaw }`             |
| `navigation.rateOfTurn`               | rad/s                              |
| `navigation.state`                    | `anchored`, `sailing`, `moored`, … |
| `navigation.gnss.methodQuality`       | Data-quality signal                |
| `navigation.gnss.horizontalDilution`  |                                    |
| `navigation.gnss.verticalDilution`    |                                    |
| `navigation.gnss.satellites`          |                                    |

### 2.4 Depth

| Path                                    | Notes                                        |
| --------------------------------------- | -------------------------------------------- |
| `environment.depth.belowSurface`        | Preferred canonical datum                    |
| `environment.depth.belowTransducer`     | If that is what the vessel publishes         |
| `environment.depth.belowKeel`           | If that is what the vessel publishes         |
| `environment.depth.transducerToKeel`    | Optional offset, useful for datum conversion |
| `environment.depth.surfaceToTransducer` | Optional offset                              |

Share the paths that exist, each with its own datum. A depth reading is sensitive;
see §7.

### 2.5 Environment: Temperature

| Path                                                  | Notes                       |
| ----------------------------------------------------- | --------------------------- |
| `environment.outside.temperature`                     | Air temperature             |
| `environment.inside.*.temperature`                    | Per-zone inside temperature |
| `environment.water.temperature`                       | Water temperature           |
| `environment.outside.apparentWindChillTemperature`    | Derived, if available       |
| `environment.outside.theoreticalWindChillTemperature` | Derived, if available       |
| `environment.outside.heatIndexTemperature`            | Derived, if available       |

### 2.6 Environment: Wind

| Path                                 | Notes |
| ------------------------------------ | ----- |
| `environment.wind.angleApparent`     |       |
| `environment.wind.angleTrueGround`   |       |
| `environment.wind.angleTrueWater`    |       |
| `environment.wind.directionTrue`     |       |
| `environment.wind.directionMagnetic` |       |
| `environment.wind.directionApparent` |       |
| `environment.wind.speedTrue`         |       |
| `environment.wind.speedApparent`     |       |

### 2.7 Environment: Pressure & humidity

| Path                                      | Notes                           |
| ----------------------------------------- | ------------------------------- |
| `environment.outside.pressure`            |                                 |
| `environment.outside.relativeHumidity`    |                                 |
| `environment.outside.dewPointTemperature` |                                 |
| `environment.outside.airDensity`          |                                 |
| `environment.outside.illuminance`         |                                 |
| `environment.inside.*`                    | Per-zone pressure/humidity/etc. |

### 2.8 Tanks

| Data set               | Paths                                      |
| ---------------------- | ------------------------------------------ |
| **Tanks: Fuel**        | `tanks.fuel.*`                             |
| **Tanks: Fresh water** | `tanks.freshWater.*`                       |
| **Tanks: Holding**     | `tanks.blackWater.*`, `tanks.wasteWater.*` |

The other tank collections (`tanks.lubrication.*`, `tanks.liveWell.*`,
`tanks.baitWell.*`, `tanks.gas.*`, `tanks.ballast.*`) are deliberately not
categories yet. They can be added as separate data sets if users ask; until then
they are not shared.

### 2.9 Destination and anchor

| Path                       | Notes                               |
| -------------------------- | ----------------------------------- |
| `navigation.destination.*` | Reveals intentions; off by default  |
| `navigation.anchor.*`      | Reveals that and where you anchored |

### 2.10 Propulsion

| Path           | Notes                                       |
| -------------- | ------------------------------------------- |
| `propulsion.*` | Engines, RPM, temperature, run state        |
| `engine.*`     | Legacy engine paths, kept for older sources |

Engine status is usually only wanted inside a trusted group, so it is off by
default and normally enabled with **Share with groups**. It can be made public,
but that is an explicit choice.

### 2.11 Systems

| Path                  | Notes           |
| --------------------- | --------------- |
| `steering.*`          | Rudder angle    |
| `sensors.*`           | Non-AIS sensors |
| `navigation.lights.*` |                 |

Tanks are their own sets (§2.8), propulsion is its own set (§2.10), and neither is
part of Systems.

### 2.12 Excluded (never in the public set; not offered as public toggles)

| Path                      | Reason                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `electrical.*`            | Batteries, chargers, AC/DC. Private and high-volume. Group-only, advanced override. |
| `communication.*`         | Credentials, SIM, provider data. Never.                                             |
| `plugins.*`               | Plugin internals. Never.                                                            |
| `resources.*`             | Server resources. Never.                                                            |
| `sensors.ais.boundingBox` | Plugin-internal artifact. Never.                                                    |
| `notifications.*`         | Noisy, unclear value; not in v1.                                                    |

---

## 3. The sharing control

Each data set stores two audiences:

```jsonc
{
  "public": true, // publish on all-vessels
  "groups": "all", // "all" | [] | ["grp_7f3c", "grp_91ad"]
}
```

The UI presents three choices per data set:

| Choice                | Stored as                        |
| --------------------- | -------------------------------- |
| **Share publicly**    | `public: true`                   |
| **Share with groups** | `public: false`, `groups: [...]` |
| **Don't share**       | `public: false`, `groups: []`    |

Because the two audiences are independent, "public **and** a selected group" is
representable; the simple UI can show it as a public toggle plus a group picker,
and the three labels above as the common presets. When **Share with groups** is
chosen, the user picks which groups from the configured list (or "all").

A group that is removed or left is dropped from every data set's group list.

---

## 4. Consent modes (public audience)

The public network is joined by default but **receive-only** until the owner opts
in; "transmitting" is
configurable. The mode applies to position-bearing data sets (Position and Depth)
when they are shared publicly.

| Mode                | Behaviour                                                                                                                       | Trade-off                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `opt-out` (default) | Publish everything the enabled data sets allow.                                                                                 | Best data; a moored boat reveals its berth. |
| `underway-gated`    | Publish only while underway: SOG above a threshold (default 0.5 m/s ≈ 1 kn) sustained for 60 s; stop after 5 min below 0.3 m/s. | Still automatic; hides marina berths.       |
| `receive-only`      | Join and ingest, but publish nothing of your own.                                                                               | Maximum privacy; no contribution.           |
| `coarse-position`   | Publish position rounded to a grid (default 5 km) instead of the exact fix.                                                     | Approximate only; not anonymity.            |

The mode is per network. Groups use the same modes and default to `receive-only` (a
group is already a trusted audience). A boat can be `opt-out` to its club and
`underway-gated` to the world.

---

## 5. Rates and coalescing

Rates are set per network (public and each group), and a data set may cap itself
below the network rate:

| Data set                         | Default rate                                     | Trigger                           |
| -------------------------------- | ------------------------------------------------ | --------------------------------- |
| Identity & static                | on change + 24 h                                 | Any static change                 |
| Position                         | network rate (0.05 Hz underway / 0.01 Hz moored) | Heartbeat or a significant change |
| Navigation & safety              | network rate                                     | Heartbeat or a significant change |
| Depth                            | min(network rate, 0.01 Hz)                       | Depth change > 0.5 m              |
| Environment: Temperature         | 0.01 Hz                                          | Heartbeat or a significant change |
| Environment: Wind                | 0.01 Hz                                          | Heartbeat or a significant change |
| Environment: Pressure & humidity | 0.01 Hz                                          | Heartbeat or a significant change |
| Tanks                            | on change + 0.01 Hz                              | Level change                      |
| Destination                      | on change + network rate                         | Change of destination             |
| Anchor                           | on change + 0.01 Hz                              | Anchor state change               |
| Propulsion                       | 0.02 Hz                                          | Heartbeat or a significant change |
| Systems                          | 0.02 Hz                                          | Heartbeat or a significant change |
| AIS                              | per-network AIS rate (§6)                        | Change or sample                  |

**Implemented v1.** The extra navigation/GNSS fields travel in the compact
snapshot at the network rate. The non-navigation sets (depth, environment, tanks,
destination, anchor, propulsion and systems) are coalesced into one generic
`Values` record, published every 60 s **and immediately when a value changes**.
Per-set rates remain a future refinement.

A "significant change" publishes immediately and resets the heartbeat: position
moved more than 50 m, COG changed more than 5°, SOG changed more than 0.5 m/s,
heading changed more than 5°, or depth changed more than 0.5 m. A moving boat
updates on the heartbeat; a moored boat is nearly silent.

The snapshot is coalesced: one record carries every allowed path that changed, not
one message per path. A data set that is off contributes nothing to the record.

---

## 6. AIS: other vessels

Sharing AIS targets is how the public network becomes a **global map of vessels**,
not just boats running Signal K. It is useful and it is the largest variable cost,
so both its audience and its send/receive direction are configurable.

### 6.1 Audience

**Implemented v1.** The plugin collects AIS targets heard by the local receiver
(a target must have `sensors.ais.class` and a non-P2P source), caps them to the
nearest `maxTargets`, samples at `aisRateHz`, and publishes AIS observation
records. Received AIS is never re-published.

The AIS data set uses the same three-way control as the others:

- **Share publicly** — publish locally heard targets on `all-vessels` (and ingest
  targets from it, subject to the mode);
- **Share with groups** — publish into the selected groups;
- **Don't share** — no AIS over P2P.

Defaults: public **off**, groups **off**; AIS is receive-only/private by default.

### 6.2 Direction

| Mode (UI label)            | Publishes locally heard AIS | Ingests AIS from the network |
| -------------------------- | --------------------------- | ---------------------------- |
| `both` — Send and receive  | yes                         | yes                          |
| `publish` — Send ours only | yes                         | no                           |
| `subscribe` — Receive only | no                          | yes                          |
| `off` — No AIS over P2P    | no                          | no                           |

**Critical rule:** only AIS targets heard by _this_ vessel's own receiver are ever
published. AIS targets received over P2P are never re-published (no bridging).
This keeps one observation from multiplying through the mesh.

### 6.3 What an AIS snapshot contains

Identity and kinematics only: MMSI, name, callsign, ship type, position, COG, SOG,
heading, nav state, and the observation timestamp. No voyage, destination or cargo
data.

An AIS record is an **observation**, not a claim: it can never outrank the target
vessel's own self records. See [`security.md`](security.md) §6.

### 6.4 Cost and dedup

AIS targets update independently of our snapshot rate, so they are sampled, capped
and coalesced:

| Targets shared | Rate    | Per-observer contribution |
| -------------- | ------- | ------------------------- |
| 100 (default)  | 0.02 Hz | ~6.9 MB/day               |
| 200            | 0.02 Hz | ~13.8 MB/day              |
| 100 (default)  | 0.01 Hz | ~3.5 MB/day               |

Defaults: `maxAisTargets = 100` (nearest to own vessel) and `aisRateHz = 0.02`
(50 s). Only targets whose position/kinematics changed are re-sent.

**Duplication is the real cost.** If ten boats in the same area all hear the same
100 targets and share them, the wire carries roughly ten copies. Receivers dedup by
MMSI (last-writer-wins on observation time), so the injected tree stays clean, but
the network still pays. This is acceptable at small observer counts and is the
first thing to optimise if it is not:

- prefer `subscribe` in dense areas, or
- elect a single relayer per MMSI among nearby observers (deferred; needs
  coordination), or
- publish only targets not already present in the shard index (deferred).

**Privacy and legal note.** AIS is broadcast over public radio, but re-publishing
it over the internet is a choice, not an obligation. Some jurisdictions and some
vessel operators treat aggregation as sensitive. The audience and mode are
explicit, defaults can be reviewed, and `off` is always available.

---

## 7. Depth: a deliberate, sensitive default

Depth is on publicly by default because a live depth mesh is one of the most useful
things a boat can contribute. It is also sensitive: a track of depth soundings
reveals fishing grounds, uncharted shoals and where you have been.

Therefore:

- It is its own data set, so it is easy to turn off or scope to groups.
- It follows the public consent mode: `receive-only` withholds it,
  `underway-gated` withholds it while moored, and `coarse-position` coarsens the
  position it is paired with.
- It is not LiveDepth's aggregated bathymetry dataset, which is a separate, more
  carefully governed durable artifact. This is a live reading.

---

## 8. Policy resolution

For a network `N` and a data set `D`:

```
publish D on N  if  N.enabled
                and N.consent allows D
                and (
                      (N is public and D.public)
                   or (N is a group and (D.groups == "all" or N.id in D.groups))
                )
```

Per-path additions/removals inside a data set are applied last. Excluded paths
(§2.12) cannot be enabled on the public network; in a group they require an
explicit advanced override.

---

## 9. Configuration sketch

```jsonc
{
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
      "consent": "opt-out",
      "rateHzUnderway": 0.1,
      "rateHzMoored": 0.02,
    },
  ],
}
```

The `networks` array carries only membership, discovery, consent and rates; _what_
is shared lives in `sharing`, once, and applies to whichever audiences the user
selects.

---

## 10. Open questions

- Should the UI offer "public **and** groups" directly, or only the three presets
  with an advanced checkbox? The data model supports both.
- Default audience for tanks and propulsion: currently off for both public and
  groups; should a newly created group automatically receive levels and engine
  status, or stay opt-in?
- Revisit the public defaults for Environment (temperature/wind/pressure) — they
  make a valuable weather mesh but widen the default footprint.
- Should "Other tanks" (lubrication, live well, bait, gas, ballast) become their
  own sets now, or wait for demand?
- Should AIS targets be sampled by proximity, by change, or both? Proximity is
  simpler and bounds cost; change-only is cheaper but can miss distant traffic.
- Where does the boundary sit between "live depth" (this plugin) and "aggregated
  bathymetry" (LiveDepth), so users understand what they are contributing?
