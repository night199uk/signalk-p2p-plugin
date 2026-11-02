import { describe, expect, it } from "vitest";
import {
  decodeAisSnapshot,
  decodeAisStatic,
  encodeAisSnapshot,
  encodeAisStatic,
} from "../src/data/ais.js";

describe("AIS codecs", () => {
  it("round-trips an AIS snapshot", () => {
    const snapshot = {
      mmsi: 232001999,
      timestamp: 1_765_000_000,
      latitude: 51.51,
      longitude: -0.11,
      courseOverGround: 0.5,
      speedOverGround: 3.2,
      heading: 0.6,
      navState: "under way using engine" as const,
      aisClass: "A" as const,
    };
    const decoded = decodeAisSnapshot(encodeAisSnapshot(snapshot));
    expect(decoded.mmsi).toBe(snapshot.mmsi);
    expect(decoded.timestamp).toBe(snapshot.timestamp);
    expect(decoded.latitude).toBeCloseTo(snapshot.latitude, 6);
    expect(decoded.longitude).toBeCloseTo(snapshot.longitude, 6);
    expect(decoded.courseOverGround).toBeCloseTo(snapshot.courseOverGround, 3);
    expect(decoded.speedOverGround).toBeCloseTo(snapshot.speedOverGround, 2);
    expect(decoded.heading).toBeCloseTo(snapshot.heading, 3);
    expect(decoded.navState).toBe(snapshot.navState);
    expect(decoded.aisClass).toBe(snapshot.aisClass);
  });

  it("round-trips AIS static details", () => {
    const info = {
      mmsi: 232001999,
      shipType: 36,
      name: "Target Vessel",
      callsign: "TGT1",
    };
    expect(decodeAisStatic(encodeAisStatic(info))).toEqual(info);
  });
});
