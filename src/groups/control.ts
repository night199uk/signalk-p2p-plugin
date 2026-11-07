import type { GroupManager } from "./manager.js";
import type {
  GroupInfo,
  GroupRole,
  PendingRequest,
  ProposalInfo,
} from "./types.js";

export interface GroupResult {
  ok: boolean;
  error?: string;
  group?: GroupInfo;
  token?: string;
}

export interface GroupControl {
  groups(): GroupInfo[];
  createGroup(input: { name?: unknown }): Promise<GroupResult>;
  createInvite(input: {
    groupId?: unknown;
    role?: unknown;
    expiresInSeconds?: unknown;
  }): GroupResult;
  joinGroup(input: { token?: unknown; mmsi?: unknown }): Promise<GroupResult>;
  groupRequests(): PendingRequest[];
  approveMember(input: {
    groupId?: unknown;
    nonce?: unknown;
    role?: unknown;
    mmsi?: unknown;
  }): Promise<GroupResult>;
  removeMember(input: {
    groupId?: unknown;
    selfId?: unknown;
  }): Promise<GroupResult>;
  promoteMember(input: {
    groupId?: unknown;
    selfId?: unknown;
    role?: unknown;
  }): Promise<GroupResult>;
  leaveGroup(input: { groupId?: unknown }): Promise<GroupResult>;
  setRate(input: { groupId?: unknown; rateHz?: unknown }): Promise<GroupResult>;
  setRateCap(input: {
    groupId?: unknown;
    rateHz?: unknown;
  }): Promise<GroupResult>;
  groupProposals(groupId?: string): ProposalInfo[];
  approveProposal(input: {
    groupId?: unknown;
    hash?: unknown;
  }): Promise<GroupResult>;
  setThreshold(input: {
    groupId?: unknown;
    threshold?: unknown;
  }): Promise<GroupResult>;
}

const ROLES: GroupRole[] = ["owner", "admin", "member", "viewer"];

function failure(error: unknown): GroupResult {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function roleField(value: unknown): GroupRole | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(ROLES as string[]).includes(value)) {
    throw new Error("role must be owner, admin, member or viewer");
  }
  return value as GroupRole;
}

function rateField(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("rateHz must be a number");
  }
  return value;
}

function numberField(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("expiresInSeconds must be a number");
  }
  return value;
}

export function createGroupControl(
  getManager: () => GroupManager | undefined,
): GroupControl {
  const requireManager = (): GroupManager => {
    const manager = getManager();
    if (!manager) throw new Error("plugin is not started");
    return manager;
  };

  return {
    groups: () => getManager()?.list() ?? [],
    groupRequests: () => getManager()?.requests() ?? [],

    createGroup: async (input) => {
      try {
        const name = stringField(input.name, "name");
        return { ok: true, group: await requireManager().createGroup(name) };
      } catch (error) {
        return failure(error);
      }
    },

    createInvite: (input) => {
      try {
        const groupId = stringField(input.groupId, "groupId");
        const role = roleField(input.role) ?? "member";
        return {
          ok: true,
          token: requireManager().createInvite(
            groupId,
            role,
            numberField(input.expiresInSeconds),
          ),
        };
      } catch (error) {
        return failure(error);
      }
    },

    joinGroup: async (input) => {
      try {
        const token = stringField(input.token, "token");
        return {
          ok: true,
          group: await requireManager().join(token, optionalString(input.mmsi)),
        };
      } catch (error) {
        return failure(error);
      }
    },

    approveMember: async (input) => {
      try {
        const groupId = stringField(input.groupId, "groupId");
        const nonce = stringField(input.nonce, "nonce");
        return {
          ok: true,
          group: await requireManager().approveJoin(
            groupId,
            nonce,
            roleField(input.role),
            optionalString(input.mmsi),
          ),
        };
      } catch (error) {
        return failure(error);
      }
    },

    removeMember: async (input) => {
      try {
        const groupId = stringField(input.groupId, "groupId");
        const selfId = stringField(input.selfId, "selfId");
        return {
          ok: true,
          group: await requireManager().removeMember(groupId, selfId),
        };
      } catch (error) {
        return failure(error);
      }
    },

    promoteMember: async (input) => {
      try {
        const groupId = stringField(input.groupId, "groupId");
        const selfId = stringField(input.selfId, "selfId");
        const role = roleField(input.role);
        if (!role) throw new Error("role is required");
        return {
          ok: true,
          group: await requireManager().promoteMember(groupId, selfId, role),
        };
      } catch (error) {
        return failure(error);
      }
    },

    groupProposals: (groupId) => getManager()?.proposalsFor(groupId) ?? [],

    approveProposal: async (input) => {
      try {
        const groupId = stringField(input.groupId, "groupId");
        const hash = stringField(input.hash, "hash");
        return {
          ok: true,
          group: await requireManager().approveProposal(groupId, hash),
        };
      } catch (error) {
        return failure(error);
      }
    },

    setThreshold: async (input) => {
      try {
        const groupId = stringField(input.groupId, "groupId");
        const threshold = numberField(input.threshold);
        if (threshold === undefined) {
          throw new Error("threshold is required");
        }
        return {
          ok: true,
          group: await requireManager().setAdminThreshold(groupId, threshold),
        };
      } catch (error) {
        return failure(error);
      }
    },

    setRate: async (input) => {
      try {
        const groupId = stringField(input.groupId, "groupId");
        return {
          ok: true,
          group: await requireManager().setPublishRate(
            groupId,
            rateField(input.rateHz),
          ),
        };
      } catch (error) {
        return failure(error);
      }
    },

    setRateCap: async (input) => {
      try {
        const groupId = stringField(input.groupId, "groupId");
        return {
          ok: true,
          group: await requireManager().setRateCap(
            groupId,
            rateField(input.rateHz),
          ),
        };
      } catch (error) {
        return failure(error);
      }
    },

    leaveGroup: async (input) => {
      try {
        const groupId = stringField(input.groupId, "groupId");
        await requireManager().leave(groupId);
        return { ok: true };
      } catch (error) {
        return failure(error);
      }
    },
  };
}
