import { encodeAisSnapshot, encodeAisStatic } from "../data/ais.js";
import { encodeEnvelope } from "../data/envelope.js";
import type { AisTarget } from "./store.js";

/**
 * Build AIS observation records for a set of local targets. Static details are
 * only emitted when they change, to keep repeat batches small.
 */
export function buildAisRecords(
  targets: AisTarget[],
  sentStatic: Map<number, string>,
): Buffer[] {
  const records: Buffer[] = [];

  for (const target of targets) {
    if (target.latitude === undefined || target.longitude === undefined) {
      continue;
    }
    records.push(
      encodeEnvelope(
        "ais-snapshot",
        encodeAisSnapshot({
          mmsi: target.mmsi,
          timestamp: target.lastSeen,
          latitude: target.latitude,
          longitude: target.longitude,
          courseOverGround: target.courseOverGround,
          speedOverGround: target.speedOverGround,
          heading: target.heading,
          navState: target.navState,
          aisClass: target.aisClass,
        }),
      ),
    );

    if (
      target.name !== undefined ||
      target.callsign !== undefined ||
      target.shipType !== undefined
    ) {
      const key = `${target.name ?? ""}\u0000${target.callsign ?? ""}\u0000${
        target.shipType ?? ""
      }`;
      if (sentStatic.get(target.mmsi) !== key) {
        records.push(
          encodeEnvelope(
            "ais-static",
            encodeAisStatic({
              mmsi: target.mmsi,
              shipType: target.shipType,
              name: target.name,
              callsign: target.callsign,
            }),
          ),
        );
        sentStatic.set(target.mmsi, key);
      }
    }
  }

  return records;
}
