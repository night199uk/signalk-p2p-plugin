import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginRouter } from "@signalk/server-api";
import { registerRoutes, type P2PControl } from "../src/api.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

describe("plugin routes", () => {
  it("serves status, identity, claims and attest requests", async () => {
    const attests: unknown[] = [];
    const control: P2PControl = {
      status: () => ({
        started: true,
        version: "test",
        networks: [],
        peers: 0,
        injected: 0,
        claims: 0,
        eligiblePeers: 0,
      }),
      identity: () => ({
        publicKey: "ab".repeat(32),
        fingerprint: "cd".repeat(32),
        isAttestor: true,
      }),
      claims: () => [],
      attest: (input) => {
        attests.push(input);
        return { ok: true };
      },
      revoke: () => ({ ok: true }),
    };

    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerRoutes(router as unknown as PluginRouter, control);
    app.use(router);

    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    );
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    const admin = await fetch(`${base}/admin`);
    expect(admin.status).toBe(200);
    expect(admin.headers.get("content-type")).toContain("text/html");
    expect(await admin.text()).toContain("Signal K P2P");

    const status = await fetch(`${base}/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ started: true });

    const identity = await fetch(`${base}/identity`);
    expect(await identity.json()).toMatchObject({ isAttestor: true });

    const claims = await fetch(`${base}/claims`);
    expect(await claims.json()).toEqual({ claims: [] });

    const attest = await fetch(`${base}/claims/attest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selfId: "urn:mrn:signalk:uuid:test" }),
    });
    expect(attest.status).toBe(200);
    expect(attests).toHaveLength(1);
  });

  it("returns 400 when the control rejects an attestation", async () => {
    const control: P2PControl = {
      status: () => ({
        started: true,
        version: "test",
        networks: [],
        peers: 0,
        injected: 0,
        claims: 0,
        eligiblePeers: 0,
      }),
      identity: () => undefined,
      claims: () => [],
      attest: () => ({ ok: false, error: "not an attestor" }),
      revoke: () => ({ ok: false, error: "not an attestor" }),
    };

    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerRoutes(router as unknown as PluginRouter, control);
    app.use(router);

    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    );
    const port = (server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/claims/attest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ selfId: "x" }),
    });
    expect(response.status).toBe(400);

    const identity = await fetch(`http://127.0.0.1:${port}/identity`);
    expect(identity.status).toBe(503);
  });
});
