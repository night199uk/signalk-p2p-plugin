# Signal K P2P

**Peer-to-peer vessel data between Signal K instances.** One global public mesh,
joined by default, plus any number of private, encrypted groups.

> **Status: v0.1.0 — first public release.** The core path
> (publish → relay → inject) and the security, election, group and AIS features
> are implemented and validated over WAN through a VPS peer. It has not yet been
> validated on real boats or Starlink links; treat this release as a field-test
> candidate.

## Features

- Share position, navigation (including magnetic course/heading, attitude, rate of
  turn, speed through water and GNSS DOP/satellites), depth, environment, tanks,
  destination, anchor, propulsion and systems, per network.
- Join the global `all-vessels` network automatically (opt-out, with four consent
  modes), or only share with selected groups.
- Create private groups with encrypted data, invite links, roles, admin-approved
  MMSIs, member removal and key rotation.
- Carry other vessels you hear over AIS into a shared map, with four AIS modes and
  nearest-target caps; AIS observations are never re-published.
- Signed messages, claim/attestation authorization, and one authorized writer per
  vessel context, so a peer can never overwrite another vessel's data.
- Relay through elected peers with no fixed relays, plus an optional standalone
  Node.js peer for a VPS bootstrap when most boats are behind CGNAT.
- An admin webapp for claims, groups, join requests and proposals. The Groups
  view includes a Public network card with status, peers/elected relay and
  per-data-set public sharing toggles. It appears under **Webapps** while the
  plugin is enabled, and is also served at
  `/plugins/signalk-p2p-plugin/admin` (admin login required).

## Install

From the Signal K App Store: search for **Signal K P2P**, install, restart the
server, then enable the plugin. Or install into the server's configuration
directory:

```bash
cd ~/.signalk
npm install signalk-p2p-plugin
```

Requires Node `>=22.5` (a Signal K server on Node 22.5 or newer).

After enabling the plugin, open **Signal K P2P** from the Webapps menu. The UI
calls the admin-gated API, so you must be signed in as an administrator.

Default sharing is conservative: position, navigation, depth and AIS are on for
the public mesh; environment, tanks, destination, anchor, propulsion and systems
are off publicly until you enable them. See
[`shared-data.md`](docs/plans/shared-data.md) for the data sets and defaults.

## Standalone peer

Run a relay on a VPS or always-on host when most boats are behind CGNAT:

```bash
npm install -g signalk-p2p-plugin
signalk-p2p-peer --help
```

See [`deploy/README.md`](deploy/README.md) for the systemd unit and an example
configuration.

## Design

| Document                                                    | Contents                                        |
| ----------------------------------------------------------- | ----------------------------------------------- |
| [`architecture.md`](docs/plans/architecture.md)             | Stack, live/durable split, identity, invariants |
| [`shared-data.md`](docs/plans/shared-data.md)               | Data sets, defaults, rates, AIS modes           |
| [`networks.md`](docs/plans/networks.md)                     | Public mesh, adaptive sharding, groups          |
| [`security.md`](docs/plans/security.md)                     | Write authorization, claims, MMSI verification  |
| [`data-and-injection.md`](docs/plans/data-and-injection.md) | Wire records, merge, injection                  |
| [`v1-design.md`](docs/plans/v1-design.md)                   | Build order, spike, risks                       |
| [`spike-findings.md`](docs/plans/spike-findings.md)         | Measured payload and replication costs          |
| [`peer-node.md`](docs/plans/peer-node.md)                   | Standalone Node.js peer / VPS relay             |

## Development

```bash
npm install
npm run build        # TypeScript -> dist/
npm test             # vitest
npm run peer         # standalone peer/relay (dev)
npm run peer:start   # compiled standalone peer
npm run smoke:client # connect to a running peer (-- --listen to observe)
npm run smoke:plugin # two mock Signal K instances through the live path
npm run smoke:election # collect capabilities and print the elected relay
npm run smoke:group    # full group lifecycle over the network
npm run spike        # payload + replication measurements
npm run spike:swarm  # Hyperswarm idle/payload measurement
npm run format
npm run lint
```

To deploy the standalone peer on a VPS, see
[`deploy/README.md`](deploy/README.md).

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
