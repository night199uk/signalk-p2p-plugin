import { describe, expect, it } from "vitest";
import { generateIdentity } from "../src/identity.js";
import {
  signInvite,
  signJoinRequest,
  signRoster,
  verifyInvite,
  verifyJoinRequest,
  verifyRoster,
  type GroupInvite,
  type GroupMember,
  type GroupRoster,
} from "../src/groups/types.js";

const now = 1000;

function roster(identity = generateIdentity()): GroupRoster {
  const member: GroupMember = {
    selfId: "urn:mrn:signalk:uuid:owner",
    ed25519Key: identity.publicKeyRaw.toString("hex"),
    boxPublicKey: identity.boxPublicKey.toString("hex"),
    role: "owner",
    addedAt: now,
  };
  return {
    groupId: "11".repeat(32),
    name: "Test Group",
    version: 1,
    epoch: 1,
    adminThreshold: 1,
    members: [member],
    wrappedKeys: [],
    adminKeys: [identity.publicKeyRaw.toString("hex")],
    updatedAt: now,
  };
}

describe("group records", () => {
  it("signs and verifies a roster", () => {
    const identity = generateIdentity();
    const signed = signRoster(roster(identity), identity);

    expect(verifyRoster(signed, [identity.publicKeyRaw.toString("hex")])).toBe(
      true,
    );
    expect(
      verifyRoster(signed, [generateIdentity().publicKeyRaw.toString("hex")]),
    ).toBe(false);
  });

  it("signs and verifies an invite, and detects tampering", () => {
    const identity = generateIdentity();
    const signedRoster = signRoster(roster(identity), identity);
    const invite = signInvite(
      {
        v: 1,
        groupId: signedRoster.roster.groupId,
        name: signedRoster.roster.name,
        epoch: 1,
        epochKey: Buffer.alloc(32, 2).toString("base64"),
        rosterTopic: "22".repeat(32),
        adminKey: identity.publicKeyRaw.toString("hex"),
        role: "member",
        expiresAt: now + 100,
        nonce: "abc",
        roster: signedRoster,
      },
      identity,
    );

    expect(verifyInvite(invite)).toBe(true);
    const tampered: GroupInvite = { ...invite, role: "owner" };
    expect(verifyInvite(tampered)).toBe(false);
  });

  it("signs and verifies a join request", () => {
    const admin = generateIdentity();
    const joiner = generateIdentity();
    const signedRoster = signRoster(roster(admin), admin);
    const invite = signInvite(
      {
        v: 1,
        groupId: signedRoster.roster.groupId,
        name: signedRoster.roster.name,
        epoch: 1,
        epochKey: Buffer.alloc(32, 2).toString("base64"),
        rosterTopic: "22".repeat(32),
        adminKey: admin.publicKeyRaw.toString("hex"),
        role: "member",
        expiresAt: now + 100,
        nonce: "abc",
        roster: signedRoster,
      },
      admin,
    );
    const member: GroupMember = {
      selfId: "urn:mrn:signalk:uuid:joiner",
      ed25519Key: joiner.publicKeyRaw.toString("hex"),
      boxPublicKey: joiner.boxPublicKey.toString("hex"),
      role: "member",
      addedAt: now,
    };
    const request = signJoinRequest(
      {
        groupId: signedRoster.roster.groupId,
        invite,
        inviteNonce: invite.nonce,
        member,
        requestedAt: now,
      },
      joiner,
    );

    expect(verifyJoinRequest(request)).toBe(true);
    expect(verifyJoinRequest({ ...request, requestedAt: now + 1 })).toBe(false);
  });
});
