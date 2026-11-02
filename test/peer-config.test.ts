import { describe, expect, it } from "vitest";
import { DEFAULT_PEER_CONFIG, loadPeerConfig } from "../src/peer/config.js";

describe("peer config", () => {
  it("uses the public all-vessels topic by default", () => {
    const config = loadPeerConfig();
    expect(config.topic).toBe(DEFAULT_PEER_CONFIG.topic);
    expect(config.batchIntervalMs).toBe(2000);
    expect(config.historyBatches).toBe(10);
  });

  it("applies CLI-style overrides", () => {
    const config = loadPeerConfig({
      dataDir: "/tmp/skp2p-peer-test",
      topic: "signalk-p2p/test/v1",
      batchIntervalMs: 500,
      historyBatches: 3,
      port: 49737,
    });

    expect(config.dataDir).toBe("/tmp/skp2p-peer-test");
    expect(config.topic).toBe("signalk-p2p/test/v1");
    expect(config.batchIntervalMs).toBe(500);
    expect(config.historyBatches).toBe(3);
    expect(config.port).toBe(49737);
  });

  it("rejects an invalid batch interval", () => {
    expect(() => loadPeerConfig({ batchIntervalMs: -1 })).toThrow(
      /batchIntervalMs/,
    );
  });

  it("accepts group invite tokens", () => {
    const config = loadPeerConfig({
      groupInvites: ["token-one", "token-two"],
    });
    expect(config.groupInvites).toEqual(["token-one", "token-two"]);
  });

  it("rejects a non-array groupInvites", () => {
    expect(() =>
      loadPeerConfig({
        groupInvites: "nope" as unknown as string[],
      }),
    ).toThrow(/groupInvites/);
  });

  it("rejects an invalid port", () => {
    expect(() => loadPeerConfig({ port: 70_000 })).toThrow(/port/);
  });
});
