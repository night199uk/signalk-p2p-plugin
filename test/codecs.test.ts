import { describe, expect, it } from "vitest";
import { decodeEnvelope, encodeEnvelope } from "../src/data/envelope.js";
import { decodeSnapshot, encodeSnapshot } from "../src/data/snapshot.js";
import { decodeStatic, encodeStatic } from "../src/data/static.js";
import { decodeValues, encodeValues } from "../src/data/values.js";
import type { Snapshot, StaticInfo } from "../src/data/types.js";

const snapshot: Snapshot = {
  timestamp: 1_765_000_000,
  latitude: 50.7123456,
  longitude: -1.9876543,
  courseOverGround: (123.45 * Math.PI) / 180,
  speedOverGround: 5.12,
  heading: (120 * Math.PI) / 180,
  navState: "under way using engine",
  gnssQuality: "RTK fixed integer",
  mmsi: 232001234,
  underway: true,
};

describe("snapshot codec", () => {
  it("round-trips a full snapshot", () => {
    const decoded = decodeSnapshot(encodeSnapshot(snapshot));

    expect(decoded.timestamp).toBe(snapshot.timestamp);
    expect(decoded.latitude).toBeCloseTo(snapshot.latitude as number, 6);
    expect(decoded.longitude).toBeCloseTo(snapshot.longitude as number, 6);
    expect(decoded.courseOverGround).toBeCloseTo(
      snapshot.courseOverGround as number,
      3,
    );
    expect(decoded.speedOverGround).toBeCloseTo(
      snapshot.speedOverGround as number,
      2,
    );
    expect(decoded.heading).toBeCloseTo(snapshot.heading as number, 3);
    expect(decoded.navState).toBe(snapshot.navState);
    expect(decoded.gnssQuality).toBe(snapshot.gnssQuality);
    expect(decoded.mmsi).toBe(snapshot.mmsi);
    expect(decoded.underway).toBe(true);
  });

  it("omits position when it is not shared", () => {
    const withoutPosition: Snapshot = {
      timestamp: 1_765_000_000,
      courseOverGround: 1,
      speedOverGround: 2,
      heading: 3,
    };
    const decoded = decodeSnapshot(encodeSnapshot(withoutPosition));

    expect(decoded.latitude).toBeUndefined();
    expect(decoded.longitude).toBeUndefined();
    expect(decoded.courseOverGround).toBeCloseTo(1, 3);
    expect(decoded.speedOverGround).toBeCloseTo(2, 2);
    expect(decoded.heading).toBeCloseTo(3, 3);
  });

  it("round-trips coarse and underway flags", () => {
    const decoded = decodeSnapshot(
      encodeSnapshot({ ...snapshot, coarse: true }),
    );
    expect(decoded.coarse).toBe(true);
    expect(decoded.underway).toBe(true);
  });

  it("round-trips the extended navigation and GNSS fields", () => {
    const extended: Snapshot = {
      ...snapshot,
      courseOverGroundMagnetic: 2.14,
      headingMagnetic: 2.13,
      magneticVariation: -0.02,
      speedThroughWater: 4.8,
      attitude: { roll: 0.05, pitch: -0.01, yaw: 1.2 },
      rateOfTurn: 0.01,
      gnssHorizontalDilution: 0.8,
      gnssVerticalDilution: 1.2,
      gnssSatellites: 14,
    };
    const decoded = decodeSnapshot(encodeSnapshot(extended));

    expect(decoded.courseOverGroundMagnetic).toBeCloseTo(2.14, 3);
    expect(decoded.headingMagnetic).toBeCloseTo(2.13, 3);
    expect(decoded.magneticVariation).toBeCloseTo(-0.02, 3);
    expect(decoded.speedThroughWater).toBeCloseTo(4.8, 2);
    expect(decoded.attitude?.roll).toBeCloseTo(0.05, 3);
    expect(decoded.attitude?.pitch).toBeCloseTo(-0.01, 3);
    expect(decoded.attitude?.yaw).toBeCloseTo(1.2, 3);
    expect(decoded.rateOfTurn).toBeCloseTo(0.01, 3);
    expect(decoded.gnssHorizontalDilution).toBeCloseTo(0.8, 2);
    expect(decoded.gnssVerticalDilution).toBeCloseTo(1.2, 2);
    expect(decoded.gnssSatellites).toBe(14);
  });

  it("rejects an out-of-range coordinate", () => {
    expect(() =>
      encodeSnapshot({ timestamp: 1, latitude: 91, longitude: 0 }),
    ).toThrow(/latitude/);
  });
});

const staticInfo: StaticInfo = {
  selfId: "urn:mrn:signalk:uuid:6b0e776f-811a-4b35-980e-b93405371bc5",
  mmsi: 232001234,
  imo: 9123456,
  shipType: 36,
  name: "Test Vessel",
  callsign: "MABC1",
  lengthOverall: 12.34,
  beam: 4.2,
  draft: 1.8,
  fromBow: 5.1,
  fromCenter: 0.3,
};

describe("static codec", () => {
  it("round-trips identity and dimensions", () => {
    const decoded = decodeStatic(encodeStatic(staticInfo));

    expect(decoded).toEqual(staticInfo);
  });

  it("requires a selfId", () => {
    expect(() => encodeStatic({ selfId: "" })).toThrow(/selfId/);
  });
});

describe("envelope codec", () => {
  it("round-trips the record type and payload", () => {
    const payload = encodeSnapshot(snapshot);
    const decoded = decodeEnvelope(encodeEnvelope("snapshot", payload));

    expect(decoded.version).toBe(1);
    expect(decoded.type).toBe("snapshot");
    expect(decoded.payload.equals(payload)).toBe(true);
  });

  it("rejects a truncated envelope", () => {
    expect(() => decodeEnvelope(Buffer.from([1, 1, 0, 10]))).toThrow(/payload/);
  });
});

describe("values codec", () => {
  it("round-trips the non-navigation map", () => {
    const values = {
      "environment.water.temperature": 285.15,
      "tanks.fuel.0.currentLevel": 0.72,
      "navigation.destination.commonName": "Cowes",
    };
    expect(decodeValues(encodeValues(values))).toEqual(values);
  });
});
