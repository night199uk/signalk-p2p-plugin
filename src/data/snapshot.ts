import { GNSS_QUALITIES, NAV_STATES, type Snapshot } from "./types.js";
import {
  clamp,
  decodeAngle,
  decodeCoordinate,
  encodeAngle,
  encodeCoordinate,
  isFiniteNumber,
  requireCoordinate,
  requireU32,
} from "./codec.js";

export const SNAPSHOT_VERSION = 2;

const MAX_SNAPSHOT_BYTES = 96;

const FLAG = {
  POSITION: 1 << 0,
  MMSI: 1 << 1,
  COG: 1 << 2,
  SOG: 1 << 3,
  HEADING: 1 << 4,
  NAV_STATE: 1 << 5,
  GNSS: 1 << 6,
  COARSE: 1 << 7,
  UNDERWAY: 1 << 8,
} as const;

const FLAG2 = {
  COG_MAGNETIC: 1 << 0,
  HEADING_MAGNETIC: 1 << 1,
  MAGNETIC_VARIATION: 1 << 2,
  ATTITUDE: 1 << 3,
  RATE_OF_TURN: 1 << 4,
  SPEED_THROUGH_WATER: 1 << 5,
  HDOP: 1 << 6,
  VDOP: 1 << 7,
  SATELLITES: 1 << 8,
} as const;

function angleCenti(radians: number): number {
  return encodeAngle(radians);
}

function signedAngleCenti(radians: number): number {
  return clamp(Math.round(((radians * 180) / Math.PI) * 100), -32768, 32767);
}

function decodeSignedAngle(centidegrees: number): number {
  return (centidegrees / 100) * (Math.PI / 180);
}

function speedCenti(value: number): number {
  return clamp(Math.round(value * 100), 0, 0xffff);
}

function dopCenti(value: number): number {
  return clamp(Math.round(value * 100), 0, 0xffff);
}

/**
 * Fixed-layout snapshot. Position is optional because Position is a separate
 * sharing toggle from Navigation. Version 2 adds magnetic course/heading,
 * variation, attitude, rate of turn, speed through water and GNSS detail.
 */
export function encodeSnapshot(snapshot: Snapshot): Buffer {
  requireU32(snapshot.timestamp, "timestamp");

  const hasPosition =
    isFiniteNumber(snapshot.latitude) && isFiniteNumber(snapshot.longitude);
  if (hasPosition) {
    requireCoordinate(snapshot.latitude as number, "latitude", 90);
    requireCoordinate(snapshot.longitude as number, "longitude", 180);
  }

  const navIndex = snapshot.navState
    ? NAV_STATES.indexOf(snapshot.navState)
    : -1;
  const gnssIndex = snapshot.gnssQuality
    ? GNSS_QUALITIES.indexOf(snapshot.gnssQuality)
    : -1;
  const attitude =
    snapshot.attitude &&
    isFiniteNumber(snapshot.attitude.roll) &&
    isFiniteNumber(snapshot.attitude.pitch) &&
    isFiniteNumber(snapshot.attitude.yaw)
      ? snapshot.attitude
      : undefined;

  let flags = 0;
  if (hasPosition) flags |= FLAG.POSITION;
  if (snapshot.mmsi !== undefined) flags |= FLAG.MMSI;
  if (isFiniteNumber(snapshot.courseOverGround)) flags |= FLAG.COG;
  if (isFiniteNumber(snapshot.speedOverGround)) flags |= FLAG.SOG;
  if (isFiniteNumber(snapshot.heading)) flags |= FLAG.HEADING;
  if (navIndex >= 0) flags |= FLAG.NAV_STATE;
  if (gnssIndex >= 0) flags |= FLAG.GNSS;
  if (snapshot.coarse) flags |= FLAG.COARSE;
  if (snapshot.underway) flags |= FLAG.UNDERWAY;

  let flags2 = 0;
  if (isFiniteNumber(snapshot.courseOverGroundMagnetic)) {
    flags2 |= FLAG2.COG_MAGNETIC;
  }
  if (isFiniteNumber(snapshot.headingMagnetic)) {
    flags2 |= FLAG2.HEADING_MAGNETIC;
  }
  if (isFiniteNumber(snapshot.magneticVariation)) {
    flags2 |= FLAG2.MAGNETIC_VARIATION;
  }
  if (attitude) flags2 |= FLAG2.ATTITUDE;
  if (isFiniteNumber(snapshot.rateOfTurn)) {
    flags2 |= FLAG2.RATE_OF_TURN;
  }
  if (isFiniteNumber(snapshot.speedThroughWater)) {
    flags2 |= FLAG2.SPEED_THROUGH_WATER;
  }
  if (isFiniteNumber(snapshot.gnssHorizontalDilution)) {
    flags2 |= FLAG2.HDOP;
  }
  if (isFiniteNumber(snapshot.gnssVerticalDilution)) {
    flags2 |= FLAG2.VDOP;
  }
  if (isFiniteNumber(snapshot.gnssSatellites)) {
    flags2 |= FLAG2.SATELLITES;
  }

  const out = Buffer.allocUnsafe(MAX_SNAPSHOT_BYTES);
  let offset = 0;
  out.writeUInt8(SNAPSHOT_VERSION, offset);
  offset += 1;
  out.writeUInt16BE(flags, offset);
  offset += 2;
  out.writeUInt16BE(flags2, offset);
  offset += 2;
  out.writeUInt32BE(snapshot.timestamp, offset);
  offset += 4;

  if (hasPosition) {
    out.writeInt32BE(encodeCoordinate(snapshot.latitude as number), offset);
    offset += 4;
    out.writeInt32BE(encodeCoordinate(snapshot.longitude as number), offset);
    offset += 4;
  }
  if (flags & FLAG.COG) {
    out.writeUInt16BE(angleCenti(snapshot.courseOverGround as number), offset);
    offset += 2;
  }
  if (flags & FLAG.SOG) {
    out.writeUInt16BE(speedCenti(snapshot.speedOverGround as number), offset);
    offset += 2;
  }
  if (flags & FLAG.HEADING) {
    out.writeUInt16BE(angleCenti(snapshot.heading as number), offset);
    offset += 2;
  }
  if (navIndex >= 0) {
    out.writeUInt8(navIndex, offset);
    offset += 1;
  }
  if (gnssIndex >= 0) {
    out.writeUInt8(gnssIndex, offset);
    offset += 1;
  }
  if (flags & FLAG.MMSI) {
    out.writeUInt32BE(requireU32(snapshot.mmsi as number, "mmsi"), offset);
    offset += 4;
  }

  if (flags2 & FLAG2.COG_MAGNETIC) {
    out.writeUInt16BE(
      angleCenti(snapshot.courseOverGroundMagnetic as number),
      offset,
    );
    offset += 2;
  }
  if (flags2 & FLAG2.HEADING_MAGNETIC) {
    out.writeUInt16BE(angleCenti(snapshot.headingMagnetic as number), offset);
    offset += 2;
  }
  if (flags2 & FLAG2.MAGNETIC_VARIATION) {
    out.writeInt16BE(
      signedAngleCenti(snapshot.magneticVariation as number),
      offset,
    );
    offset += 2;
  }
  if (attitude) {
    out.writeInt16BE(signedAngleCenti(attitude.roll), offset);
    offset += 2;
    out.writeInt16BE(signedAngleCenti(attitude.pitch), offset);
    offset += 2;
    out.writeInt16BE(signedAngleCenti(attitude.yaw), offset);
    offset += 2;
  }
  if (flags2 & FLAG2.RATE_OF_TURN) {
    out.writeInt16BE(
      clamp(
        Math.round(((snapshot.rateOfTurn as number) * 180 * 100) / Math.PI),
        -32768,
        32767,
      ),
      offset,
    );
    offset += 2;
  }
  if (flags2 & FLAG2.SPEED_THROUGH_WATER) {
    out.writeUInt16BE(speedCenti(snapshot.speedThroughWater as number), offset);
    offset += 2;
  }
  if (flags2 & FLAG2.HDOP) {
    out.writeUInt16BE(
      dopCenti(snapshot.gnssHorizontalDilution as number),
      offset,
    );
    offset += 2;
  }
  if (flags2 & FLAG2.VDOP) {
    out.writeUInt16BE(
      dopCenti(snapshot.gnssVerticalDilution as number),
      offset,
    );
    offset += 2;
  }
  if (flags2 & FLAG2.SATELLITES) {
    out.writeUInt8(
      clamp(Math.round(snapshot.gnssSatellites as number), 0, 255),
      offset,
    );
    offset += 1;
  }

  return Buffer.from(out.subarray(0, offset));
}

export function decodeSnapshot(data: Buffer): Snapshot {
  let offset = 0;
  const take = (bytes: number): number => {
    if (offset + bytes > data.length) {
      throw new Error("snapshot: truncated record");
    }
    const start = offset;
    offset += bytes;
    return start;
  };

  const version = data.readUInt8(take(1));
  if (version !== SNAPSHOT_VERSION) {
    throw new Error(`snapshot: unsupported version ${version}`);
  }
  const flags = data.readUInt16BE(take(2));
  const flags2 = data.readUInt16BE(take(2));
  const snapshot: Snapshot = { timestamp: data.readUInt32BE(take(4)) };

  if (flags & FLAG.POSITION) {
    snapshot.latitude = decodeCoordinate(data.readInt32BE(take(4)));
    snapshot.longitude = decodeCoordinate(data.readInt32BE(take(4)));
  }
  if (flags & FLAG.COG) {
    snapshot.courseOverGround = decodeAngle(data.readUInt16BE(take(2)));
  }
  if (flags & FLAG.SOG) {
    snapshot.speedOverGround = data.readUInt16BE(take(2)) / 100;
  }
  if (flags & FLAG.HEADING) {
    snapshot.heading = decodeAngle(data.readUInt16BE(take(2)));
  }
  if (flags & FLAG.NAV_STATE) {
    snapshot.navState = NAV_STATES[data.readUInt8(take(1))] ?? "unknown";
  }
  if (flags & FLAG.GNSS) {
    snapshot.gnssQuality = GNSS_QUALITIES[data.readUInt8(take(1))];
  }
  if (flags & FLAG.COARSE) snapshot.coarse = true;
  if (flags & FLAG.UNDERWAY) snapshot.underway = true;
  if (flags & FLAG.MMSI) {
    snapshot.mmsi = data.readUInt32BE(take(4));
  }

  if (flags2 & FLAG2.COG_MAGNETIC) {
    snapshot.courseOverGroundMagnetic = decodeAngle(data.readUInt16BE(take(2)));
  }
  if (flags2 & FLAG2.HEADING_MAGNETIC) {
    snapshot.headingMagnetic = decodeAngle(data.readUInt16BE(take(2)));
  }
  if (flags2 & FLAG2.MAGNETIC_VARIATION) {
    snapshot.magneticVariation = decodeSignedAngle(data.readInt16BE(take(2)));
  }
  if (flags2 & FLAG2.ATTITUDE) {
    snapshot.attitude = {
      roll: decodeSignedAngle(data.readInt16BE(take(2))),
      pitch: decodeSignedAngle(data.readInt16BE(take(2))),
      yaw: decodeSignedAngle(data.readInt16BE(take(2))),
    };
  }
  if (flags2 & FLAG2.RATE_OF_TURN) {
    snapshot.rateOfTurn = ((data.readInt16BE(take(2)) / 100) * Math.PI) / 180;
  }
  if (flags2 & FLAG2.SPEED_THROUGH_WATER) {
    snapshot.speedThroughWater = data.readUInt16BE(take(2)) / 100;
  }
  if (flags2 & FLAG2.HDOP) {
    snapshot.gnssHorizontalDilution = data.readUInt16BE(take(2)) / 100;
  }
  if (flags2 & FLAG2.VDOP) {
    snapshot.gnssVerticalDilution = data.readUInt16BE(take(2)) / 100;
  }
  if (flags2 & FLAG2.SATELLITES) {
    snapshot.gnssSatellites = data.readUInt8(take(1));
  }

  if (offset !== data.length) {
    throw new Error(`snapshot: ${data.length - offset} trailing bytes`);
  }
  return snapshot;
}
