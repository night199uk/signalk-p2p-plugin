import { describe, expect, it } from "vitest";
import { buildAisRecords } from "../src/ais/publish.js";
import { decodeEnvelope } from "../src/data/envelope.js";
import { decodeAisSnapshot, decodeAisStatic } from "../src/data/ais.js";

const target = {
  mmsi: 232001999,
  name: "Target Vessel",
  callsign: "TGT1",
  shipType: 36,
  latitude: 51.51,
  longitude: -0.11,
  courseOverGround: 0.5,
  speedOverGround: 3.2,
  heading: 0.6,
  navState: "under way using engine" as const,
  aisClass: "A" as const,
  lastSeen: 1000,
};

describe("buildAisRecords", () => {
  it("emits a snapshot and static record once", () => {
    const sent = new Map<number, string>();
    const first = buildAisRecords([target], sent).map(decodeEnvelope);

    expect(first.map((envelope) => envelope.type)).toEqual([
      "ais-snapshot",
      "ais-static",
    ]);
    expect(decodeAisSnapshot(first[0].payload).mmsi).toBe(232001999);
    expect(decodeAisStatic(first[1].payload).name).toBe("Target Vessel");

    const second = buildAisRecords([target], sent).map(decodeEnvelope);
    expect(second.map((envelope) => envelope.type)).toEqual(["ais-snapshot"]);
  });
});
