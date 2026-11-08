import { describe, expect, it } from "vitest";
import type { Delta } from "@signalk/server-api";
import { AisTargetStore } from "../src/ais/store.js";

function aisDelta(
  mmsi: number,
  values: Array<{ path: string; value: unknown }>,
  sourceLabel = "nmea2000",
): Delta {
  return {
    context: `vessels.urn:mrn:imo:mmsi:${mmsi}`,
    updates: [
      {
        timestamp: new Date().toISOString(),
        source: { label: sourceLabel },
        values,
      },
    ],
  } as unknown as Delta;
}

const targetValues = [
  { path: "navigation.position", value: { latitude: 51.51, longitude: -0.11 } },
  { path: "navigation.courseOverGroundTrue", value: 0.5 },
  { path: "navigation.speedOverGround", value: 3.2 },
  { path: "navigation.headingTrue", value: 0.6 },
  { path: "sensors.ais.class", value: "A" },
  { path: "name", value: "Target Vessel" },
  { path: "callsign", value: "TGT1" },
  { path: "design.aisShipType", value: { id: 36 } },
];

describe("AisTargetStore", () => {
  it("collects a local AIS target", () => {
    const store = new AisTargetStore();
    store.applyDelta(aisDelta(232001999, targetValues), 1000);
    const targets = store.nearest(undefined, 10, 1000);

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      mmsi: 232001999,
      name: "Target Vessel",
      callsign: "TGT1",
      shipType: 36,
      aisClass: "A",
    });
  });

  it("ignores P2P-injected sources", () => {
    const store = new AisTargetStore();
    store.applyDelta(aisDelta(232001999, targetValues, "signalk-p2p"), 1000);
    expect(store.nearest(undefined, 10, 1000)).toHaveLength(0);
  });

  it("ignores the self vessel's MMSI", () => {
    const store = new AisTargetStore(232001999);
    store.applyDelta(aisDelta(232001999, targetValues), 1000);
    expect(store.nearest(undefined, 10, 1000)).toHaveLength(0);
  });

  it("shares a target even when the receiver omits AIS class", () => {
    const store = new AisTargetStore();
    store.applyDelta(
      aisDelta(
        232001999,
        targetValues.filter((value) => value.path !== "sensors.ais.class"),
      ),
      1000,
    );
    const targets = store.nearest(undefined, 10, 1000);
    expect(targets).toHaveLength(1);
    expect(targets[0].aisClass).toBeUndefined();
  });

  it("tracks and filters local AIS sources", () => {
    const store = new AisTargetStore();
    store.applyDelta(aisDelta(232001999, targetValues, "physical"), 1000);
    store.applyDelta(aisDelta(232001998, targetValues, "marinetraffic"), 1000);

    expect(store.sourceLabels()).toEqual(["marinetraffic", "physical"]);
    expect(
      store
        .nearest(undefined, 10, 1000, 900, ["physical"])
        .map((target) => target.mmsi),
    ).toEqual([232001999]);
    expect(
      store
        .nearest(undefined, 10, 1000, 900, ["marinetraffic"])
        .map((target) => target.mmsi),
    ).toEqual([232001998]);
  });

  it("orders by distance and caps the result", () => {
    const store = new AisTargetStore();
    store.applyDelta(
      aisDelta(232001999, [
        {
          path: "navigation.position",
          value: { latitude: 51.9, longitude: -0.1 },
        },
        { path: "sensors.ais.class", value: "A" },
      ]),
      1000,
    );
    store.applyDelta(
      aisDelta(232001998, [
        {
          path: "navigation.position",
          value: { latitude: 51.5001, longitude: -0.1 },
        },
        { path: "sensors.ais.class", value: "A" },
      ]),
      1000,
    );

    const targets = store.nearest({ latitude: 51.5, longitude: -0.1 }, 1, 1000);
    expect(targets).toHaveLength(1);
    expect(targets[0].mmsi).toBe(232001998);
  });

  it("prunes stale targets", () => {
    const store = new AisTargetStore();
    store.applyDelta(aisDelta(232001999, targetValues), 1000);
    store.prune(2000, 900);
    expect(store.nearest(undefined, 10, 2000)).toHaveLength(0);
  });
});
