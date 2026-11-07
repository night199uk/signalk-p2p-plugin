import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateIdentity } from "../src/identity.js";
import { GroupManager } from "../src/groups/manager.js";
import {
  signJoinRequest,
  type GroupInvite,
  type GroupMember,
} from "../src/groups/types.js";

const ownerSelfId = "urn:mrn:signalk:uuid:owner";
const joinerSelfId = "urn:mrn:signalk:uuid:joiner";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function manager(selfId: string): Promise<{
  manager: GroupManager;
  identity: ReturnType<typeof generateIdentity>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "skp2p-group-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const identity = generateIdentity();
  const instance = new GroupManager({
    dataDir: directory,
    identity,
    selfId,
    onData: () => {},
    autoStart: false,
    now: () => 1000,
  });
  await instance.load();
  return { manager: instance, identity };
}

function joinRequest(
  token: string,
  identity: ReturnType<typeof generateIdentity>,
  mmsi: string,
  selfId = joinerSelfId,
) {
  const invite = JSON.parse(
    Buffer.from(token, "base64url").toString("utf8"),
  ) as GroupInvite;
  const member: GroupMember = {
    selfId,
    ed25519Key: identity.publicKeyRaw.toString("hex"),
    boxPublicKey: identity.boxPublicKey.toString("hex"),
    mmsi,
    role: "member",
    addedAt: 1000,
  };
  return {
    invite,
    request: signJoinRequest(
      {
        groupId: invite.groupId,
        invite,
        inviteNonce: invite.nonce,
        member,
        requestedAt: 1000,
      },
      identity,
    ),
  };
}

describe("GroupManager", () => {
  it("caps member publish rates and clamps local rates", async () => {
    const owner = await manager(ownerSelfId);
    const group = await owner.manager.createGroup("Rate Group");
    expect(group.rateCapHz).toBe(0.05);
    expect(group.publishRateHz).toBe(0.05);

    const capped = await owner.manager.setRateCap(group.id, 2);
    expect(capped.rateCapHz).toBe(2);
    const clamped = await owner.manager.setPublishRate(group.id, 5);
    expect(clamped.publishRateHz).toBe(2);
    const local = await owner.manager.setPublishRate(group.id, 1.5);
    expect(local.publishRateHz).toBe(1.5);
  });

  it("creates a group, admits a member, and rekeys on removal", async () => {
    const owner = await manager(ownerSelfId);
    const joiner = await manager(joinerSelfId);

    const group = await owner.manager.createGroup("Test Group");
    const token = owner.manager.createInvite(group.id, "member");
    const joined = await joiner.manager.join(token, "123456789");
    expect(joined.role).toBe("member");

    const { invite, request } = joinRequest(
      token,
      joiner.identity,
      "123456789",
    );
    await owner.manager.receiveJoinRequest(request);
    expect(owner.manager.requests()).toHaveLength(1);

    await owner.manager.approveJoin(
      group.id,
      invite.nonce,
      "member",
      "123456789",
    );
    const roster = owner.manager.exportRoster(group.id);
    await joiner.manager.receiveRoster(roster);

    expect(joiner.manager.list()[0]).toMatchObject({
      id: group.id,
      role: "member",
      members: 2,
      removed: false,
    });
    expect(
      joiner.manager.authorize(
        group.id,
        ownerSelfId,
        owner.identity.publicKeyRaw,
      ),
    ).toBe(true);
    expect(
      owner.manager.authorize(
        group.id,
        joinerSelfId,
        joiner.identity.publicKeyRaw,
        true,
      ),
    ).toBe(true);

    await owner.manager.removeMember(group.id, joinerSelfId);
    const removedRoster = owner.manager.exportRoster(group.id);
    await joiner.manager.receiveRoster(removedRoster);

    expect(joiner.manager.list()[0].removed).toBe(true);
    expect(
      joiner.manager.authorize(
        group.id,
        ownerSelfId,
        owner.identity.publicKeyRaw,
      ),
    ).toBe(false);
    expect(owner.manager.list()[0].members).toBe(1);
  });

  it("requires a quorum for roster changes", async () => {
    const owner = await manager(ownerSelfId);
    const admin = await manager(joinerSelfId);

    const group = await owner.manager.createGroup("Quorum Group");
    const token = owner.manager.createInvite(group.id, "member");
    await admin.manager.join(token, "123456789");
    const { invite, request } = joinRequest(token, admin.identity, "123456789");
    await owner.manager.receiveJoinRequest(request);
    await owner.manager.approveJoin(
      group.id,
      invite.nonce,
      "admin",
      "123456789",
    );
    await admin.manager.receiveRoster(owner.manager.exportRoster(group.id));

    await owner.manager.setAdminThreshold(group.id, 2);
    const thresholdProposal = owner.manager.proposalsFor(group.id)[0];
    expect(thresholdProposal).toBeDefined();
    await admin.manager.receiveRoster(
      owner.manager.exportProposal(
        group.id,
        thresholdProposal.hash,
      ) as NonNullable<ReturnType<typeof owner.manager.exportProposal>>,
    );
    await admin.manager.approveProposal(group.id, thresholdProposal.hash);
    await owner.manager.receiveRoster(admin.manager.exportRoster(group.id));
    expect(owner.manager.list()[0].pendingProposals).toBe(0);

    await owner.manager.removeMember(group.id, joinerSelfId);
    const removeProposal = owner.manager.proposalsFor(group.id)[0];
    expect(removeProposal.approvals).toBe(1);
    await admin.manager.receiveRoster(
      owner.manager.exportProposal(
        group.id,
        removeProposal.hash,
      ) as NonNullable<ReturnType<typeof owner.manager.exportProposal>>,
    );
    await admin.manager.approveProposal(group.id, removeProposal.hash);
    expect(admin.manager.list()[0].removed).toBe(true);
    await owner.manager.receiveRoster(admin.manager.exportRoster(group.id));
    expect(owner.manager.list()[0].members).toBe(1);
  });

  it("rejects reusing an invite and stops viewers from publishing", async () => {
    const owner = await manager(ownerSelfId);
    const joiner = await manager(joinerSelfId);

    const group = await owner.manager.createGroup("Test Group");
    const token = owner.manager.createInvite(group.id, "member");
    const { invite, request } = joinRequest(
      token,
      joiner.identity,
      "123456789",
    );
    await owner.manager.receiveJoinRequest(request);
    await owner.manager.approveJoin(
      group.id,
      invite.nonce,
      "member",
      "123456789",
    );

    const reuse = joinRequest(
      token,
      generateIdentity(),
      "123456790",
      "urn:mrn:signalk:uuid:reuse",
    );
    await owner.manager.receiveJoinRequest(reuse.request);
    await expect(
      owner.manager.approveJoin(
        group.id,
        reuse.invite.nonce,
        "member",
        "123456790",
      ),
    ).rejects.toThrow(/already used/);

    await owner.manager.promoteMember(group.id, joinerSelfId, "viewer");
    expect(
      owner.manager.authorize(
        group.id,
        joinerSelfId,
        joiner.identity.publicKeyRaw,
        true,
      ),
    ).toBe(false);
    expect(
      owner.manager.authorize(
        group.id,
        joinerSelfId,
        joiner.identity.publicKeyRaw,
        false,
      ),
    ).toBe(true);
  });

  it("persists the group relay flag", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skp2p-group-relay-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const manager = new GroupManager({
      dataDir: directory,
      identity: generateIdentity(),
      selfId: ownerSelfId,
      onData: () => {},
      autoStart: false,
      now: () => 1000,
    });
    await manager.load();
    const group = await manager.createGroup("Relay Group");
    await manager.setRelay(group.id, true);

    const raw = JSON.parse(
      await readFile(join(directory, "groups.json"), "utf8"),
    ) as { groups: Array<{ relay?: boolean }> };
    expect(raw.groups[0].relay).toBe(true);
  });

  it("rejects a duplicate MMSI in the same group", async () => {
    const owner = await manager(ownerSelfId);
    const joiner = await manager(joinerSelfId);

    const group = await owner.manager.createGroup("Test Group");
    const token = owner.manager.createInvite(group.id, "member");
    const { invite, request } = joinRequest(
      token,
      joiner.identity,
      "123456789",
    );
    await owner.manager.receiveJoinRequest(request);
    await owner.manager.approveJoin(
      group.id,
      invite.nonce,
      "member",
      "123456789",
    );

    const secondToken = owner.manager.createInvite(group.id, "member");
    const second = joinRequest(secondToken, generateIdentity(), "123456789");
    await owner.manager.receiveJoinRequest(second.request);
    await expect(
      owner.manager.approveJoin(
        group.id,
        second.invite.nonce,
        "member",
        "123456789",
      ),
    ).rejects.toThrow(/MMSI/);
  });
});
