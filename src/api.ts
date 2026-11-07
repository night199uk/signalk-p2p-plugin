import type { PluginRouter } from "@signalk/server-api";
import type { Request, Response } from "express";
import { ADMIN_PAGE } from "./admin-page.js";
import type { GroupControl, GroupResult } from "./groups/control.js";
import type { ClaimControl } from "./security/control.js";
import type { ConsentMode, DataSetId } from "./config.js";

export interface P2PStatus {
  started: boolean;
  version: string;
  policy?: {
    version: number;
    issuedAt: number;
    operator?: string;
  };
  identity?: {
    fingerprint: string;
    publicKey: string;
  };
  networks: Array<{
    id: string;
    kind: string;
    enabled: boolean;
  }>;
  peers: number;
  injected: number;
  claims: number;
  groups: number;
  eligiblePeers: number;
  electedPeer?: {
    key: string;
    selfId: string;
    capacity: number;
  };
  error?: string;
}

export interface SharingInfo {
  network?: {
    id: string;
    enabled: boolean;
    consent?: ConsentMode;
  };
  dataSets: Array<{
    id: DataSetId;
    title: string;
    description: string;
    public: boolean;
    groups: "all" | string[];
  }>;
}

export interface P2PControl extends ClaimControl, GroupControl {
  status(): P2PStatus;
  sharing(): SharingInfo;
  setSharing(
    dataSet: string,
    update: { public?: boolean; groups?: "all" | string[] },
  ): Promise<{ ok: boolean; error?: string }>;
  setConsent(consent: string): Promise<{ ok: boolean; error?: string }>;
}

function sendGroup(res: Response, result: GroupResult): void {
  res.status(result.ok ? 200 : 400).json(result);
}

/**
 * Routes live on the plugin router (`/plugins/signalk-p2p-plugin/...`), which requires
 * admin access. Membership and attestation changes are therefore operator-only.
 */
export function registerRoutes(
  router: PluginRouter,
  control: P2PControl,
): void {
  router.get("/admin", (_req: Request, res: Response) => {
    res.type("html").send(ADMIN_PAGE);
  });

  router.get("/status", (_req: Request, res: Response) => {
    res.json(control.status());
  });

  router.get("/identity", (_req: Request, res: Response) => {
    const identity = control.identity();
    if (!identity) {
      res.status(503).json({ error: "plugin is not started" });
      return;
    }
    res.json(identity);
  });

  router.get("/sharing", (_req: Request, res: Response) => {
    res.json(control.sharing());
  });

  router.post("/sharing", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      dataSet?: unknown;
      public?: unknown;
      groups?: unknown;
    };
    const publicValue =
      typeof body.public === "boolean" ? body.public : undefined;
    let groups: "all" | string[] | undefined;
    if (body.groups === "all") {
      groups = "all";
    } else if (Array.isArray(body.groups)) {
      if (body.groups.some((id) => typeof id !== "string")) {
        res.status(400).json({ ok: false, error: "groups must be strings" });
        return;
      }
      groups = body.groups as string[];
    } else if (body.groups !== undefined) {
      res
        .status(400)
        .json({ ok: false, error: "groups must be 'all' or an array" });
      return;
    }
    if (
      typeof body.dataSet !== "string" ||
      (publicValue === undefined && groups === undefined)
    ) {
      res.status(400).json({
        ok: false,
        error: "dataSet and a sharing change are required",
      });
      return;
    }
    void control
      .setSharing(body.dataSet, { public: publicValue, groups })
      .then((result) => sendGroup(res, result));
  });

  router.post("/network/consent", (req: Request, res: Response) => {
    const consent = (req.body ?? {}).consent;
    if (typeof consent !== "string") {
      res.status(400).json({ ok: false, error: "consent is required" });
      return;
    }
    void control.setConsent(consent).then((result) => sendGroup(res, result));
  });

  router.get("/claims", (_req: Request, res: Response) => {
    res.json({ claims: control.claims() });
  });

  router.post("/claims/attest", (req: Request, res: Response) => {
    const result = control.attest(req.body ?? {});
    res.status(result.ok ? 200 : 400).json(result);
  });

  router.post("/claims/revoke", (req: Request, res: Response) => {
    const result = control.revoke(req.body ?? {});
    res.status(result.ok ? 200 : 400).json(result);
  });

  router.get("/groups", (_req: Request, res: Response) => {
    res.json({ groups: control.groups() });
  });

  router.get("/groups/requests", (_req: Request, res: Response) => {
    res.json({ requests: control.groupRequests() });
  });

  router.post("/groups", (req: Request, res: Response) => {
    void control
      .createGroup(req.body ?? {})
      .then((result) => sendGroup(res, result));
  });

  router.post("/groups/invite", (req: Request, res: Response) => {
    sendGroup(res, control.createInvite(req.body ?? {}));
  });

  router.post("/groups/join", (req: Request, res: Response) => {
    void control
      .joinGroup(req.body ?? {})
      .then((result) => sendGroup(res, result));
  });

  router.post("/groups/members/approve", (req: Request, res: Response) => {
    void control
      .approveMember(req.body ?? {})
      .then((result) => sendGroup(res, result));
  });

  router.post("/groups/members/remove", (req: Request, res: Response) => {
    void control
      .removeMember(req.body ?? {})
      .then((result) => sendGroup(res, result));
  });

  router.post("/groups/members/promote", (req: Request, res: Response) => {
    void control
      .promoteMember(req.body ?? {})
      .then((result) => sendGroup(res, result));
  });

  router.post("/groups/rate", (req: Request, res: Response) => {
    void control
      .setRate(req.body ?? {})
      .then((result) => sendGroup(res, result));
  });

  router.post("/groups/rate-cap", (req: Request, res: Response) => {
    void control
      .setRateCap(req.body ?? {})
      .then((result) => sendGroup(res, result));
  });

  router.post("/groups/leave", (req: Request, res: Response) => {
    void control
      .leaveGroup(req.body ?? {})
      .then((result) => sendGroup(res, result));
  });

  router.get("/groups/proposals", (req: Request, res: Response) => {
    const groupId =
      typeof req.query.groupId === "string" ? req.query.groupId : undefined;
    res.json({ proposals: control.groupProposals(groupId) });
  });

  router.post("/groups/proposals/approve", (req: Request, res: Response) => {
    void control
      .approveProposal(req.body ?? {})
      .then((result) => sendGroup(res, result));
  });

  router.post("/groups/threshold", (req: Request, res: Response) => {
    void control
      .setThreshold(req.body ?? {})
      .then((result) => sendGroup(res, result));
  });
}
