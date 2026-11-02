import { describe, expect, it } from "vitest";
import {
  snapshotToDelta,
  staticToDelta,
  valuesToDelta,
} from "../src/data/inject.js";
import type { Snapshot } from "../src/data/types.js";

const selfId = "urn:mrn:imo:mmsi:232001234";

describe("injection", () => {
  it("turns a snapshot into a vessel delta", () => {
    const snapshot: Snapshot = {
      timestamp: 1_765_000_000,
      latitude: 50.7,
      longitude: -1.9,
      courseOverGround: 2.1,
      speedOverGround: 5.1,
      heading: 2.0,
      navState: "under way using engine",
      gnssQuality: "RTK fixed integer",
      mmsi: 232001234,
    };
    const delta = snapshotToDelta(selfId, snapshot, {
      network: "all-vessels",
    });

    expect(delta?.context).toBe(`vessels.${selfId}`);
    const update = delta!.updates[0] as {
      timestamp: string;
      source: { label: string };
      values: Array<{ path: string; value: unknown }>;
    };
    expect(update.timestamp).toBe("2025-12-06T05:46:40.000Z");
    expect(update.source.label).toBe("signalk-p2p");
    expect(update.values).toEqual(
      expect.arrayContaining([
        {
          path: "navigation.position",
          value: { latitude: 50.7, longitude: -1.9 },
        },
        { path: "navigation.speedOverGround", value: 5.1 },
        { path: "navigation.state", value: "under way using engine" },
      ]),
    );
  });

  it("turns static info into root and design values", () => {
    const delta = staticToDelta(
      selfId,
      {
        selfId,
        mmsi: 232001234,
        name: "Test Vessel",
        callsign: "MABC1",
        shipType: 36,
        lengthOverall: 12.3,
        beam: 4.2,
        draft: 1.8,
        fromBow: 5.1,
        fromCenter: 0.3,
      },
      { network: "all-vessels" },
    );
    const values = (
      delta!.updates[0] as {
        values: Array<{ path: string; value: unknown }>;
      }
    ).values;

    expect(values).toEqual(
      expect.arrayContaining([
        {
          path: "",
          value: {
            name: "Test Vessel",
            mmsi: "232001234",
            callsign: "MABC1",
          },
        },
        { path: "design.aisShipType", value: { id: 36 } },
        { path: "design.beam", value: 4.2 },
      ]),
    );
  });

  it("turns a values map into a delta", () => {
    const delta = valuesToDelta(
      selfId,
      {
        "environment.depth.belowSurface": 12.3,
        "tanks.fuel.0.currentLevel": 0.7,
      },
      { network: "all-vessels" },
      "2025-12-06T05:46:40.000Z",
    );
    const values = (
      delta!.updates[0] as {
        values: Array<{ path: string; value: unknown }>;
      }
    ).values;

    expect(values).toHaveLength(2);
    expect(values[0].path).toBe("environment.depth.belowSurface");
  });
});
