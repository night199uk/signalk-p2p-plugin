# Deploying a standalone peer

A peer is an ordinary Hyperswarm peer. It is useful on an always-on, reachable
host (a VPS, a marina server, a club box) so boats behind CGNAT can reach the
mesh. It is not a central authority and can be replaced by an elected peer.

Tested on Fedora 44 with Node 22.23.1.

## 1. Install Node

Node `>=22.5` is required. On Fedora:

```bash
dnf -y install nodejs npm
node --version
```

## 2. Install the package

On the host, install the published package from npm:

```bash
id -u signalk-p2p >/dev/null 2>&1 || \
  useradd --system --home-dir /var/lib/signalk-p2p --shell /sbin/nologin signalk-p2p
install -d -o signalk-p2p -g signalk-p2p /opt/signalk-p2p /var/lib/signalk-p2p
install -d /etc/signalk-p2p
cd /opt/signalk-p2p
npm init -y
npm install --omit=dev --save-exact signalk-p2p-plugin@latest
chown -R signalk-p2p:signalk-p2p /opt/signalk-p2p /var/lib/signalk-p2p
```

Pin a specific version instead of `@latest` if you want reproducible upgrades.

## 3. Configure and run

```bash
cp deploy/peer.example.json /etc/signalk-p2p/peer.json
cp deploy/signalk-p2p-peer.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now signalk-p2p-peer
journalctl -u signalk-p2p-peer -f
```

The peer prints its identity fingerprint and the topic it joined. The Ed25519
identity is created in `/var/lib/signalk-p2p/identity/ed25519.pem` (mode 0600).

## 4. Publish the network policy (optional)

A peer can distribute the signed public-network policy. It verifies the
signature with the pinned operator key and republishes it every five minutes; it
never needs the operator private key.

```bash
cp deploy/policy.json /etc/signalk-p2p/policy.json
# add this key to /etc/signalk-p2p/peer.json:
#   "policyFile": "/etc/signalk-p2p/policy.json"
systemctl restart signalk-p2p-peer
journalctl -u signalk-p2p-peer -n 20 | grep policy
```

Sign a new policy with `scripts/sign-policy.ts` from a checkout, then copy the
signed file and restart the peer. Clients keep the newest valid policy they have
seen, so they continue to use it if the publisher is offline.

## 5. Firewall

Hyperswarm uses UDP. If you set `"port": 49737`, allow UDP 49737 inbound so other
peers can dial it:

```bash
firewall-cmd --permanent --add-port=49737/udp
firewall-cmd --reload
```

Without a fixed port the DHT uses an ephemeral UDP port; outbound UDP must still
be allowed. No TCP is required.

## 6. Private group relay

Add `"groupInvites": ["<token>"]` to the config (or pass `--group-invite <token>`)
to join and relay a private group. The peer sends a join request from its
synthetic selfId; an admin must approve it (a `viewer` role is enough, because a
relay does not publish vessel data).

## 7. Verify

From another machine on a different network:

```bash
npm run smoke:client -- --listen   # in one terminal
npm run smoke:client               # in another
```

The listener should print the sender's `smoke-…` batch. This exercises public DHT
discovery, NAT traversal, the Protomux live channel, and relay forwarding.
