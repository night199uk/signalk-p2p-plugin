import { describe, expect, it } from "vitest";
import { SelfPublisher } from "../src/live/publisher.js";

const selfId = "urn:mrn:signalk:uuid:6b0e776f-811a-4b35-980e-b93405371bc5";

function publisher(): SelfPublisher {
  const value = new SelfPublisher(selfId);
  value.update("name", "Test Vessel");
  value.update("mmsi", "232001234");
  value.update("design.length", { overall: 12.3 });
  value.update("design.aisShipType", { id: 36 });
  value.update("navigation.position", {
    latitude: 50.7123456,
    longitude: -1.9876543,
  });
  value.update("navigation.courseOverGroundTrue", 2.1);
  value.update("navigation.speedOverGround", 5.1);
  value.update("navigation.headingTrue", 2.0);
  value.update("navigation.state", "under way using engine");
  value.update("navigation.gnss.methodQuality", "RTK fixed integer");
  value.update("environment.depth.belowSurface", 12.3);
  return value;
}

describe("SelfPublisher", () => {
  it("builds a snapshot from the latest self state", () => {
    const snapshot = publisher().buildSnapshot(1_765_000_000, {
      includePosition: true,
      includeNavigation: true,
    });

    expect(snapshot?.latitude).toBeCloseTo(50.7123456, 6);
    expect(snapshot?.speedOverGround).toBe(5.1);
    expect(snapshot?.mmsi).toBe(232001234);
    expect(snapshot?.underway).toBe(true);
  });

  it("omits position when it is not shared", () => {
    const snapshot = publisher().buildSnapshot(1_765_000_000, {
      includePosition: false,
      includeNavigation: true,
    });

    expect(snapshot?.latitude).toBeUndefined();
    expect(snapshot?.speedOverGround).toBe(5.1);
  });

  it("coarsens the position", () => {
    const snapshot = publisher().buildSnapshot(1_765_000_000, {
      includePosition: true,
      includeNavigation: false,
      coarseMeters: 5000,
    });

    expect(snapshot?.coarse).toBe(true);
    expect(snapshot?.latitude).not.toBe(50.7123456);
  });

  it("applies the underway gate", () => {
    const value = publisher();
    value.update("navigation.speedOverGround", 0);
    expect(
      value.buildSnapshot(1_765_000_000, {
        includePosition: true,
        includeNavigation: true,
        underwayGate: true,
      }),
    ).toBeNull();
  });

  it("includes extra navigation and generic values", () => {
    const value = publisher();
    value.update("navigation.courseOverGroundMagnetic", 2.1);
    value.update("navigation.headingMagnetic", 2.0);
    value.update("navigation.magneticVariation", -0.01);
    value.update("navigation.speedThroughWater", 4.8);
    value.update("navigation.attitude", { roll: 0.1, pitch: 0.2, yaw: 0.3 });
    value.update("navigation.rateOfTurn", 0.01);
    value.update("navigation.gnss.horizontalDilution", 0.9);
    value.update("navigation.gnss.verticalDilution", 1.1);
    value.update("navigation.gnss.satellites", 12);
    value.update("environment.wind.speedTrue", 7.5);
    value.update("tanks.fuel.0.currentLevel", 0.6);
    value.update("navigation.destination.commonName", "Cowes");

    const snapshot = value.buildSnapshot(1_765_000_000, {
      includePosition: false,
      includeNavigation: true,
    });
    expect(snapshot?.courseOverGroundMagnetic).toBe(2.1);
    expect(snapshot?.attitude).toEqual({ roll: 0.1, pitch: 0.2, yaw: 0.3 });
    expect(snapshot?.gnssSatellites).toBe(12);

    expect(
      value.buildValues(
        (path) =>
          path.startsWith("environment.wind") ||
          path.startsWith("tanks.") ||
          path.startsWith("navigation.destination."),
      ),
    ).toEqual({
      "environment.wind.speedTrue": 7.5,
      "tanks.fuel.0.currentLevel": 0.6,
      "navigation.destination.commonName": "Cowes",
    });
  });

  it("builds static and depth records", () => {
    const value = publisher();
    expect(value.buildStatic()).toMatchObject({
      selfId,
      name: "Test Vessel",
      mmsi: 232001234,
      shipType: 36,
      lengthOverall: 12.3,
    });
    expect(value.buildValues()).toEqual({
      "environment.depth.belowSurface": 12.3,
    });
  });
});
