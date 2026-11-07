# signalk-p2p — security and write authorization

**Status:** design. This document defines who may write which context, how groups
approve members, and the honest limits of MMSI verification on the public network.

It separates two questions that are easy to conflate:

1. **Write authorization** — may this key update this context? This is solvable,
   and v1 enforces it everywhere.
2. **Claim legitimacy** — is this key the rightful owner of the MMSI it claims?
   This is _not_ solvable from the network alone today, because there is no
   authoritative MMSI-ownership source. v1 mitigates it; it does not solve it.

---

## 1. Threat model

| Threat                                     | Mitigation                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| A peer overwrites another vessel's data    | One authorized key per context; reject signed writes from any other key.                                              |
| A peer impersonates an MMSI                | Binding + admin approval (groups) or claim registry + attestation (public).                                           |
| Two vessels claim the same MMSI in a group | Roster rejects a duplicate active MMSI/selfId.                                                                        |
| A member publishes false data for a peer   | Only the authorized key may write a self context; AIS observations are lower priority and cannot overwrite self data. |
| Replaying old records                      | Last-writer-wins by timestamp, generation rotation, idempotent merge.                                                 |
| A rogue admin                              | Multiple admins/owner oversight; roster is signed and auditable.                                                      |
| A relay tampering with data                | It can withhold or reorder delivery, but cannot forge a signed block or certificate.                                  |
| Cross-network leakage                      | No bridging; only local data is ever published (architecture invariant 2).                                            |
| Sybil fleet                                | Not solved in v1; attestation and reputation are the future levers.                                                   |
| Key compromise                             | Group re-key / roster re-add; public claim revocation and re-attestation.                                             |

DHT privacy (IP addresses visible to DHT peers) is out of scope here; it is a
property of the transport, documented in [`architecture.md`](architecture.md).

---

## 2. Identity and bindings

- **Instance key** — a persistent Ed25519 keypair. It is the durable cryptographic
  identity of a Signal K instance.
- **Vessel selfId** — the Signal K `selfId`, either
  `urn:mrn:imo:mmsi:<mmsi>` or the server-generated
  `urn:mrn:signalk:uuid:<uuid>`. It determines the context
  (`vessels.<selfId>`).
- **Binding** — `contextId -> instanceKey`. Only the bound instance key may write
  records of kind `self` for that context.
- **Feed keys** — each live generation core has its own feed keypair. The first
  block of a generation carries a **core certificate**: the instance key signs
  `{ feedKey, networkId, generation }`. Receivers verify the certificate and then
  attribute every block in the core to the instance key. This lets generation
  cores rotate without rotating the durable identity.

```
CoreCertificate {
  instanceKey, feedKey, networkId, generation,
  issuedAt, signature(instanceKey)
}
```

A receiver that cannot verify the certificate ignores the core.

---

## 3. Write authorization (all networks)

Every record is typed as one of:

- **self** — the sender's own vessel (`Snapshot`, `Static`).
- **observation** — another vessel heard by the sender (`AIS_SNAPSHOT`,
  `AIS_STATIC`).

The receiver validates:

```
1. Verify the core certificate -> instanceKey.
2. For a self record:
     let C = the sender's selfId (from the verified Static record).
     require authorization(network, C) == instanceKey.
3. For an observation record:
     accept from any authorized participant of the network.
     tag it as an observation; never treat it as self data.
4. Merge by the rules in data-and-injection.md.
```

`authorization(network, context)` is:

- **group**: the group roster's `contextId -> instanceKey` for an active member;
- **public**: the public claim registry's `contextId -> instanceKey` (§5).

**Consequences.**

- A vessel can only ever write its approved context. Writing anything else is
  rejected at the receiver, regardless of what the sender claims.
- A self record outranks an AIS observation for the same context. A malicious
  member cannot overwrite another member's own data by publishing a fake AIS
  target for its MMSI.
- Local data outranks both (the local self context is never touched by remote
  data).

---

## 4. Closed groups

**Implemented v1.** Roster entries carry the approved selfId/MMSI and the
member's X25519 key. Roster changes are multi-signature proposals: a versioned
candidate is adopted only when `adminThreshold` distinct current admins have
signed it; below the threshold it is stored and broadcast for other admins to
approve. Removal rotates the epoch key and data topic, and the new key is sealed
per remaining member. Group data is
end-to-end encrypted, so a group relay must be a member.

### 4.1 Approved identity

A group roster entry stores the member's **approved identity**, not just its key:

```
Member {
  instanceKey,
  approvedSelfId,      // urn:mrn:imo:mmsi:<mmsi> or urn:mrn:signalk:uuid:<uuid>
  approvedMmsi?,       // present when the selfId is an MMSI
  role,
  approvedAt,
  approvedBy
}
```

The admin explicitly approves the MMSI (or the UUID selfId for a vessel without
one). A group may require an MMSI by policy; otherwise UUID-only members are
allowed and approved by selfId.

### 4.2 Join and approval

1. The invitee opens the group invite and sends a **join request** containing its
   instance key, claimed selfId/MMSI, and a signature over the request proving
   possession of the instance key.
2. An admin reviews the claim and issues `add(instanceKey, approvedSelfId,
approvedMmsi, role)` into the roster.
3. `apply()` rejects the event if:
   - the actor is not an owner/admin;
   - the instance key does not match the join request's proof;
   - another **active** member already has the same `approvedMmsi` or
     `approvedSelfId` (uniqueness within the group).
4. The member can now publish self records only under `approvedSelfId`.

An invite can optionally be pre-bound to an MMSI by the admin; in that case the
join succeeds only if the claim matches.

### 4.3 Identity changes

If a member's vessel gains an MMSI (or otherwise changes selfId), the change is a
new admin-approved roster event (`updateIdentity`). `apply()` re-checks uniqueness.
Until approval, the member keeps writing under its old approved selfId (or cannot
write, depending on group policy).

### 4.4 Removal

Removal is the existing roster `remove` plus `rekey` flow in
[`networks.md`](networks.md) §4.5: rotate the epoch key, change the data topic, and
give each remaining member its wrapped new key. Removed data is forward-secret;
history they already hold is not retractable.

### 4.5 Admins

Owner and admins can add, approve, remove and re-key. A rogue admin is a real
trust risk: mitigate with multiple admins, an auditable roster, and the owner's
ability to demote. Quorum or approval thresholds are deferred.

### 4.6 AIS observations inside a group

Members may publish AIS observations for arbitrary MMSIs. That is reporting what
they heard, not claiming an identity. Observations:

- never count as a member's self record;
- never outrank the target's self record if the target is also a member;
- are deduplicated by MMSI and timestamp.

---

## 5. Public network: the claim registry

There is no roster and no admin per member. The public network needs a replicated
authorization mapping and a way to establish it.

### 5.1 Registry

A durable, replicated **claim log** (Autobase with public attestors as writers, or
a signed event log with a Hyperbee view) maps:

```
contextId -> {
  instanceKey,
  status: unverified | attested | revoked,
  claimedAt,
  attestations: [ { attestor, evidenceHash, issuedAt, expiresAt, signature } ],
  revokedAt?, reason?
}
```

The registry enforces **one bound key per context at a time**.

**Implemented (v1).** It persists to `<dataDir>/claims.json`, accepts claim
records in LiveMessages, verifies attestor signatures against
`security.publicAttestors`, and resolves conflicts. With `requireAttestation`
false, an unclaimed selfId is bound on first claim (TOFU); with it true, only
attested claims authorize. `attestationThreshold` sets how many distinct
attestors are required (default 1).

Attestation signatures are persisted and **revalidated on every authorization**:
expired attestations, attestations issued more than five minutes in the future,
and attestations from keys no longer in `publicAttestors` stop counting. A web UI
and attestor governance are still pending, but the operator API is available:

| Route (admin-only)                               | Purpose                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `GET /plugins/signalk-p2p-plugin/identity`       | This instance's public key and whether it is a configured attestor |
| `GET /plugins/signalk-p2p-plugin/claims`         | Current claim registry                                             |
| `POST /plugins/signalk-p2p-plugin/claims/attest` | Issue an attestation: `{ selfId, key?, expiresAt? }`               |
| `POST /plugins/signalk-p2p-plugin/claims/revoke` | Revoke a claim: `{ selfId, key? }`                                 |

To act as an attestor, add this instance's public key (from `GET /identity`) to
`security.publicAttestors` on the receivers, then call the attest/revoke route.
The attestation is signed by the attestor and broadcast on the live network. A
minimal admin page at `/plugins/signalk-p2p-plugin/admin` drives the same routes.

### 5.2 Establishing a claim

- **First claim (TOFU).** A vessel publishes `claim(contextId, instanceKey,
keyProof, t)`. If the context is unbound, the claim is accepted and marked
  `unverified`.
- **Attested claim.** A public attestor signs
  `attest(contextId, instanceKey, evidenceHash, issuedAt, expiresAt)`. One or more
  attestations (policy: any trusted attestor, or M-of-N) mark the claim `attested`.
- **Dispute / reassignment.** An attestation for a different key can reassign a
  context under the attestation policy. Revocation marks it `revoked`.

### 5.3 The MMSI verification gap

There is currently **no authoritative source** the plugin can consult to prove
that an MMSI belongs to a given vessel. MMSI allocation is public in principle but
there is no open, machine-readable ownership API, and AIS itself only carries the
claimed number. Therefore:

- v1 can guarantee that, **once bound, only one key can write a context**. It
  cannot guarantee that the first claimant is the true owner.
- An unverified claim is shown as unverified. It still participates, so the
  network works without a gatekeeper.
- An attestor can verify a claim out of band (registration documents, AIS history,
  direct contact) and sign an attestation. The evidence format is deliberately
  opaque in v1: `evidenceHash` is a hash of whatever the attestor checked.
- **Public administrators** are the attestor role the design already has. A
  deployment can require attestation for every member (`requireAttestation`), which
  implements the "admins approve every public member" model. That does not scale
  to the whole fleet by hand, so the default is TOFU and attestation is used for
  disputes and for a verified status.
- This limitation is stated to users; "verified MMSI" is a badge with a named
  attestor, not a property the network can prove on its own.

### 5.4 Tokens without an MMSI

A vessel with no MMSI uses its UUID selfId. There is no external owner to verify;
the claim establishes key control. Squatting is low-risk because the UUID is
generated locally and only becomes known when the vessel advertises it. The same
registry rules apply.

### 5.5 Precedence

`attested` outranks `unverified` when two claims or conflicting records exist.
Injected data from an unverified claim is still displayed but marked. Reputation is
deferred.

---

## 6. AIS observations and overwrite protection

**Implemented v1.** AIS targets are collected only from local, non-P2P sources.
A received AIS record is an observation: it is never re-published, and a fresh
self record for the same context (within 300 s) causes observations for that
context to be dropped. Observations dedupe by MMSI and timestamp.

- Observations are accepted from authorized participants of a network.
- They are always lower priority than a self record for the same context.
- They merge with other observations by last-writer-wins on the observation
  timestamp, deduplicated by MMSI.
- A sender cannot use an observation to alter its own or another member's self
  context; the record type and the authorization check prevent it.
- A member could still inject false observations for a target that has no
  self-participant; dedup and (future) reputation are the only defences. This is
  the same trust level as receiving AIS over the air.

### 6.1 Relays and elected aggregators

- A relay/aggregator forwards **opaque, individually authenticated records**. It
  does not hold a vessel's key and cannot forge its data.
- It can drop, delay or reorder batches. Receivers apply timestamps, merge rules
  and authorization checks; independent relays reduce the impact.
- A public bootstrap peer (a VPS, a marina box) is an ordinary peer with no
  authority. It can be replaced by an elected peer; losing it must not stop the
  mesh.
- A group's relay must be a member, because it needs the epoch key to read the
  data it forwards. Group invites are single-use per admin, and a `viewer` cannot
  publish group data.
- Election eligibility excludes metered links and peers without owner consent.
  Capacity claims are not trusted on their own; reachability and
  tenure/attestation are the checks. Sybil resistance is deferred.
- **LiveMessages are signed.** The sender signs the message with its instance key;
  the receiver verifies it against `sourceKey` and rejects unsigned or tampered
  messages.
- **Binding.** The claim registry (§5) is the authority. With
  `requireAttestation` false, the first verified claim binds the selfId (TOFU) and
  is persisted; a key change is rejected unless an attestation overrides it. With
  `requireAttestation` true, only attested claims authorize. Group rosters (§4)
  provide the same binding for a private group.

---

## 7. Replay, staleness and key compromise

- **Replay:** last-writer-wins by timestamp makes an old replay harmless for
  state; generation rotation bounds the window; merge is idempotent.
- **Staleness:** records older than the current path value are dropped; vessels
  with no update for `maxAgeSeconds` are allowed to age out.
- **Key compromise:** the attacker can write as the vessel until the binding
  changes. In a group, an admin removes and re-adds the vessel with a new key and
  rotates the epoch. Publicly, an attestor revokes the claim and attests the new
  key. There is no automatic recovery.

---

## 8. Invite security

- An invite is a **bearer token** (`skp2p://join/...`): whoever holds it can
  request to join until it expires. It is not a proof of MMSI ownership.
- Default expiry: 7 days. Optional single-use via a nonce recorded by the roster.
- The admin's approval of the join request is the actual admission; the invite
  only gets the request in the door.
- Treat invites as secrets; the UI says so and offers revoke/expire controls.

---

## 9. Trust summary

| Question                                | Group                           | Public                                    |
| --------------------------------------- | ------------------------------- | ----------------------------------------- |
| Who may write a self context?           | The member approved by an admin | The key bound in the claim registry       |
| How is the binding established?         | Signed roster event             | TOFU claim, optionally attested           |
| Is MMSI ownership proven?               | Admin asserts it                | Attestor asserts it; otherwise unverified |
| Duplicate MMSI in the network?          | Rejected by the roster          | One bound key per context                 |
| Can another vessel overwrite self data? | No                              | No, once the claim is bound               |
| Can a relay forge or alter data?        | No; it forwards opaque records  | No; it forwards opaque records            |
| Can a squatter claim an unclaimed MMSI? | No (admin must approve)         | Yes, until disputed/attested              |

---

## 10. Open questions

- **The MMSI verification source** — the big one. Is there a registry, a broker, or
  a national authority we can integrate with later?
- Public attestor governance: how many, chosen how, what quorum, how to revoke a
  rogue attestor. The operator API exists; the governance and UI do not.
- Attestation evidence format (opaque hash in v1; could become structured).
- Whether `requireAttestation` should be the public default for safety, at the cost
  of onboarding friction.
- Sybil resistance and reputation.
- Group admin quorum and key-compromise recovery.
- Whether groups should require an MMSI or allow UUID-only members by default.
