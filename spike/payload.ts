import { pathToFileURL } from "node:url";
import { encodeEnvelope } from "../src/data/envelope.js";
import { encodeSnapshot } from "../src/data/snapshot.js";
import { encodeStatic } from "../src/data/static.js";
import { encodeValues } from "../src/data/values.js";
import type { Snapshot, StaticInfo } from "../src/data/types.js";

export interface PayloadResult {
  snapshotBytes: number;
  staticBytes: number;
  valuesBytes: number;
  snapshotJsonBytes: number;
  valuesJsonBytes: number;
  perVesselPerDay: Record<string, number>;
}

const sampleSnapshot: Snapshot = {
  timestamp: 1_765_000_000,
  latitude: 50.7123456,
  longitude: -1.9876543,
  courseOverGround: 2.154,
  speedOverGround: 5.12,
  heading: 2.094,
  navState: "under way using engine",
  gnssQuality: "RTK fixed integer",
  mmsi: 232001234,
  underway: true,
};

const sampleStatic: StaticInfo = {
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

const sampleValues = {
  "environment.water.temperature": 285.15,
  "environment.wind.speedTrue": 7.2,
  "environment.wind.directionTrue": 1.2,
  "environment.outside.pressure": 101_325,
  "tanks.fuel.0.currentLevel": 0.72,
};

export function payloadSpike(): PayloadResult {
  const snapshotBytes = encodeEnvelope(
    "snapshot",
    encodeSnapshot(sampleSnapshot),
  ).length;
  const staticBytes = encodeEnvelope(
    "static",
    encodeStatic(sampleStatic),
  ).length;
  const valuesBytes = encodeEnvelope(
    "values",
    encodeValues(sampleValues),
  ).length;

  const snapshotJsonBytes = Buffer.byteLength(
    JSON.stringify(sampleSnapshot),
    "utf8",
  );
  const valuesJsonBytes = Buffer.byteLength(
    JSON.stringify(sampleValues),
    "utf8",
  );

  const perVesselPerDay: Record<string, number> = {};
  for (const vessels of [100, 500, 1000, 5000]) {
    for (const hz of [0.05, 0.1]) {
      perVesselPerDay[`${vessels}v@${hz}Hz`] =
        snapshotBytes * hz * 86_400 * vessels;
    }
  }

  return {
    snapshotBytes,
    staticBytes,
    valuesBytes,
    snapshotJsonBytes,
    valuesJsonBytes,
    perVesselPerDay,
  };
}

function mb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function formatPayloadReport(result: PayloadResult): string {
  const lines = [
    "Payload sizes",
    "-------------",
    `snapshot (position + navigation): ${result.snapshotBytes} B  (JSON ~${result.snapshotJsonBytes} B)`,
    `static (identity/dimensions):     ${result.staticBytes} B`,
    `values (env/tanks, CBOR):         ${result.valuesBytes} B  (JSON ~${result.valuesJsonBytes} B)`,
    "",
    "Inbound per day at the snapshot rate (one sender per vessel):",
  ];
  for (const [key, bytes] of Object.entries(result.perVesselPerDay)) {
    lines.push(`  ${key.padEnd(12)} ${mb(bytes)}`);
  }
  return lines.join("\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log(formatPayloadReport(payloadSpike()));
}
