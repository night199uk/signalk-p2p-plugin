# Signal K P2P

**Peer-to-peer vessel data between Signal K instances.** One global public mesh,
joined by default, plus any number of private, encrypted groups.

> **Status: v0.4.0.** The core path
> (publish → relay → inject) and the security, election, group and AIS features
> are implemented and validated over WAN through a VPS peer. It has not yet been
> validated on real boats or Starlink links; treat this release as a field-test
> candidate.

## Features

- Share position, navigation (including magnetic course/heading, attitude, rate of
  turn, speed through water and GNSS DOP/satellites), depth, environment, tanks,
  destination, anchor, propulsion and systems, per network.
- Join the global `all-vessels` network automatically, but transmit only after
  opting in (receive-only by default; four consent modes).
- Create private groups with encrypted data, short per-invite codes, roles,
  admin-approved MMSIs, member removal and key rotation. Codes are served by any
  online group member or relay; the admin only needs to approve the join.
- Carry other vessels you hear over AIS into a shared map, with four AIS modes and
  nearest-target caps; AIS observations are never re-published.
- Signed messages, claim/attestation authorization, and one authorized writer per
  vessel context, so a peer can never overwrite another vessel's data.
- Central, signed **network policy** for sharding, election windows, publish
  rate caps and AIS caps. Individual clients cannot override topology tuning.
- Relay through elected peers with no fixed relays, plus an optional standalone
  Node.js peer for a VPS bootstrap when most boats are behind CGNAT.
- An admin webapp with a per-data-set sharing matrix: Public and each active
  group are columns, so there is no typing of group IDs. Group admins set a
  publish-rate cap; members choose their own rate within it.
- The webapp appears under **Webapps** while the plugin is enabled, and is also
  served at `/plugins/signalk-p2p-plugin/admin` (admin login required).

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

Default sharing is conservative: the public network is **receive-only**, so no
vessel data is transmitted until you choose a sharing mode in the webapp. AIS is
receive-only/private by default. Identity, position, navigation and depth are
pre-selected when you opt in; environment, tanks, destination, anchor,
propulsion and systems stay off until enabled. See
[`shared-data.md`](docs/plans/shared-data.md).

### Group invites

The group **Invite** button creates a 10-character code such as `ABCDE-FGHJK`.
The full signed invite is distributed to the group and served by any online
member or relay, so the admin does not need to stay online after creating the
code. At least one group member or relay must be online to serve it, and an
admin must still approve the join. Until that happens the group shows **Pending
administrator approval**; it only appears as a sharing column once the signed
roster includes the instance. The code expires in 24 hours and is consumed when
a join is approved. Long signed invite tokens from earlier versions remain
accepted.

### Private groups only

To use Signal K P2P without the public mesh, uncheck **Join all-vessels public
network** in the webapp. The public client stops and public sharing controls are
disabled; private group invites, data sharing and AIS group sharing continue to
work. You can rejoin the public network at any time by checking it again.

## Standalone peer

Run a relay on a VPS or always-on host when most boats are behind CGNAT:

```bash
npm install -g signalk-p2p-plugin
signalk-p2p-peer --help
```

See [`deploy/README.md`](deploy/README.md) for the systemd unit, an example
configuration, and how to publish a signed network policy.

## Admin and network policy

The Signal K plugin config form intentionally exposes only two safe toggles:
**Help relay nearby vessels** and **Show vessels received from the network**.
Everything else lives in the plugin-owned `advanced.json` (in the plugin data
directory), including sharing, consent, AIS, security and topology settings.
This keeps the form simple and prevents a form save from dropping advanced
settings.

Network-wide settings are not user-editable. A **network policy** is signed by
the network operator and distributed as:

- a signed default policy shipped in the package, and
- newer signed policies received over the mesh (live wins).

The operator key public key is
`b393c24608f23cdb389cfb0cbc8c9de619345fa110cdddcb14ab6afdb494db09`
(fingerprint `254375e336e45f93bb5691e49fdb4e758fefed7981940d98dc9773b8b23390bf`).
The private key is stored outside the repository at
`~/.config/signalk-p2p/operator/operator.json` (mode 0600); distribute the public
key and signed policy files, never the private key. Use
`scripts/sign-policy.ts` to sign a new policy.

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

## Releasing

The repository publishes from git tags. The `Publish to npm` workflow:

1. verifies the tag (`vX.Y.Z`) matches `package.json`,
2. runs format, build, tests and lint,
3. publishes to npm with provenance, and
4. creates the matching GitHub release.

```bash
# bump package.json + CHANGELOG first
git add package.json CHANGELOG.md
git commit -m "Release X.Y.Z"
git push
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

Publishing uses npm **Trusted Publishing** through GitHub OIDC; there is no
long-lived npm token in the repository. Configure the trusted publisher on npm
for this repository and `.github/workflows/publish.yml` (and the `npm`
environment if you use one). For the first publish you can run the workflow
manually from **Actions → Publish to npm → Run workflow** with the existing tag
(`v0.4.0`).

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
