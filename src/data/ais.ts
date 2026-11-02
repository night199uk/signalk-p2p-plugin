import {
  clamp,
  decodeAngle,
  decodeCoordinate,
  encodeAngle,
  encodeCoordinate,
  isFiniteNumber,
  readString8,
  requireCoordinate,
  requireU32,
  writeString8,
} from "./codec.js";
import { NAV_STATES, type NavState } from "./types.js";

export const AIS_SNAPSHOT_VERSION = 1;
export const AIS_STATIC_VERSION = 1;

export type AisClass = "A" | "B" | "ATON";

const CLASS_CODE: Record<AisClass, number> = { A: 1, B: 2, ATON: 3 };
const CLASS_NAME: Record<number, AisClass> = { 1: "A", 2: "B", 3: "ATON" };

export interface AisSnapshot {
  mmsi: number;
  /** Unix seconds of the observation. */
  timestamp: number;
  latitude?: number;
  longitude?: number;
  courseOverGround?: number;
  speedOverGround?: number;
  heading?: number;
  navState?: NavState;
  aisClass?: AisClass;
}

export interface AisStaticInfo {
  mmsi: number;
  shipType?: number;
  name?: string;
  callsign?: string;
}

const SNAPSHOT_FLAGS = {
  POSITION: 1 << 0,
  COG: 1 << 1,
  SOG: 1 << 2,
  HEADING: 1 << 3,
  NAV_STATE: 1 << 4,
  AIS_CLASS: 1 << 5,
} as const;

const STATIC_FLAGS = {
  SHIP_TYPE: 1 << 0,
  NAME: 1 << 1,
  CALLSIGN: 1 << 2,
} as const;

export function encodeAisSnapshot(snapshot: AisSnapshot): Buffer {
  requireU32(snapshot.mmsi, "mmsi");
  requireU32(snapshot.timestamp, "timestamp");
  const hasPosition =
    isFiniteNumber(snapshot.latitude) && isFiniteNumber(snapshot.longitude);
  if (hasPosition) {
    requireCoordinate(snapshot.latitude as number, "latitude", 90);
    requireCoordinate(snapshot.longitude as number, "longitude", 180);
  }
  const hasCog = isFiniteNumber(snapshot.courseOverGround);
  const hasSog = isFiniteNumber(snapshot.speedOverGround);
  const hasHeading = isFiniteNumber(snapshot.heading);
  const navIndex = snapshot.navState
    ? NAV_STATES.indexOf(snapshot.navState)
    : -1;
  const classCode = snapshot.aisClass
    ? CLASS_CODE[snapshot.aisClass]
    : undefined;

  let flags = 0;
  if (hasPosition) flags |= SNAPSHOT_FLAGS.POSITION;
  if (hasCog) flags |= SNAPSHOT_FLAGS.COG;
  if (hasSog) flags |= SNAPSHOT_FLAGS.SOG;
  if (hasHeading) flags |= SNAPSHOT_FLAGS.HEADING;
  if (navIndex >= 0) flags |= SNAPSHOT_FLAGS.NAV_STATE;
  if (classCode !== undefined) flags |= SNAPSHOT_FLAGS.AIS_CLASS;

  const out = Buffer.allocUnsafe(64);
  let offset = 0;
  out.writeUInt8(AIS_SNAPSHOT_VERSION, offset);
  offset += 1;
  out.writeUInt8(flags, offset);
  offset += 1;
  out.writeUInt32BE(snapshot.mmsi, offset);
  offset += 4;
  out.writeUInt32BE(snapshot.timestamp, offset);
  offset += 4;
  if (hasPosition) {
    out.writeInt32BE(encodeCoordinate(snapshot.latitude as number), offset);
    offset += 4;
    out.writeInt32BE(encodeCoordinate(snapshot.longitude as number), offset);
    offset += 4;
  }
  if (hasCog) {
    out.writeUInt16BE(encodeAngle(snapshot.courseOverGround as number), offset);
    offset += 2;
  }
  if (hasSog) {
    out.writeUInt16BE(
      clamp(Math.round((snapshot.speedOverGround as number) * 100), 0, 0xffff),
      offset,
    );
    offset += 2;
  }
  if (hasHeading) {
    out.writeUInt16BE(encodeAngle(snapshot.heading as number), offset);
    offset += 2;
  }
  if (navIndex >= 0) {
    out.writeUInt8(navIndex, offset);
    offset += 1;
  }
  if (classCode !== undefined) {
    out.writeUInt8(classCode, offset);
    offset += 1;
  }
  return Buffer.from(out.subarray(0, offset));
}

export function decodeAisSnapshot(data: Buffer): AisSnapshot {
  let offset = 0;
  const take = (bytes: number): number => {
    if (offset + bytes > data.length) {
      throw new Error("ais snapshot: truncated record");
    }
    const start = offset;
    offset += bytes;
    return start;
  };

  const version = data.readUInt8(take(1));
  if (version !== AIS_SNAPSHOT_VERSION) {
    throw new Error(`ais snapshot: unsupported version ${version}`);
  }
  const flags = data.readUInt8(take(1));
  const snapshot: AisSnapshot = {
    mmsi: data.readUInt32BE(take(4)),
    timestamp: data.readUInt32BE(take(4)),
  };
  if (flags & SNAPSHOT_FLAGS.POSITION) {
    snapshot.latitude = decodeCoordinate(data.readInt32BE(take(4)));
    snapshot.longitude = decodeCoordinate(data.readInt32BE(take(4)));
  }
  if (flags & SNAPSHOT_FLAGS.COG) {
    snapshot.courseOverGround = decodeAngle(data.readUInt16BE(take(2)));
  }
  if (flags & SNAPSHOT_FLAGS.SOG) {
    snapshot.speedOverGround = data.readUInt16BE(take(2)) / 100;
  }
  if (flags & SNAPSHOT_FLAGS.HEADING) {
    snapshot.heading = decodeAngle(data.readUInt16BE(take(2)));
  }
  if (flags & SNAPSHOT_FLAGS.NAV_STATE) {
    snapshot.navState = NAV_STATES[data.readUInt8(take(1))] ?? "unknown";
  }
  if (flags & SNAPSHOT_FLAGS.AIS_CLASS) {
    snapshot.aisClass = CLASS_NAME[data.readUInt8(take(1))];
  }
  if (offset !== data.length) {
    throw new Error(`ais snapshot: ${data.length - offset} trailing bytes`);
  }
  return snapshot;
}

export function encodeAisStatic(info: AisStaticInfo): Buffer {
  requireU32(info.mmsi, "mmsi");
  let flags = 0;
  if (info.shipType !== undefined) flags |= STATIC_FLAGS.SHIP_TYPE;
  if (info.name) flags |= STATIC_FLAGS.NAME;
  if (info.callsign) flags |= STATIC_FLAGS.CALLSIGN;

  const out = Buffer.allocUnsafe(512);
  let offset = 0;
  out.writeUInt8(AIS_STATIC_VERSION, offset);
  offset += 1;
  out.writeUInt8(flags, offset);
  offset += 1;
  out.writeUInt32BE(info.mmsi, offset);
  offset += 4;
  if (info.shipType !== undefined) {
    out.writeUInt16BE(clamp(Math.round(info.shipType), 0, 0xffff), offset);
    offset += 2;
  }
  if (info.name) offset = writeString8(out, offset, info.name);
  if (info.callsign) offset = writeString8(out, offset, info.callsign);
  return Buffer.from(out.subarray(0, offset));
}

export function decodeAisStatic(data: Buffer): AisStaticInfo {
  let offset = 0;
  const take = (bytes: number): number => {
    if (offset + bytes > data.length) {
      throw new Error("ais static: truncated record");
    }
    const start = offset;
    offset += bytes;
    return start;
  };

  const version = data.readUInt8(take(1));
  if (version !== AIS_STATIC_VERSION) {
    throw new Error(`ais static: unsupported version ${version}`);
  }
  const flags = data.readUInt8(take(1));
  const info: AisStaticInfo = { mmsi: data.readUInt32BE(take(4)) };
  if (flags & STATIC_FLAGS.SHIP_TYPE) {
    info.shipType = data.readUInt16BE(take(2));
  }
  if (flags & STATIC_FLAGS.NAME) {
    const read = readString8(data, offset);
    info.name = read.value;
    offset = read.offset;
  }
  if (flags & STATIC_FLAGS.CALLSIGN) {
    const read = readString8(data, offset);
    info.callsign = read.value;
    offset = read.offset;
  }
  if (offset !== data.length) {
    throw new Error(`ais static: ${data.length - offset} trailing bytes`);
  }
  return info;
}
