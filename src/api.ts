import type { PluginRouter } from "@signalk/server-api";
import type { Request, Response } from "express";
import { ADMIN_PAGE } from "./admin-page.js";
import type { GroupControl, GroupResult } from "./groups/control.js";
import type { ClaimControl } from "./security/control.js";

export interface P2PStatus {
  started: boolean;
  version: string;
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

export interface P2PControl extends ClaimControl, GroupControl {
  status(): P2PStatus;
}

function sendGroup(res: Response, result: GroupResult): void {
  res.status(result.ok ? 200 : 400).json(result);
}

/**
 * Routes live on the plugin router (`/plugins/signalk-p2p/...`), which requires
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
