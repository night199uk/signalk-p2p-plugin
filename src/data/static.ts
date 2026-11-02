import type { StaticInfo } from "./types.js";
import {
  clamp,
  isFiniteNumber,
  readString8,
  requireU32,
  writeString8,
} from "./codec.js";

export const STATIC_VERSION = 1;

const MAX_STATIC_BYTES = 1024;

const FLAG = {
  MMSI: 1 << 0,
  IMO: 1 << 1,
  CALLSIGN: 1 << 2,
  SHIP_TYPE: 1 << 3,
  DIMENSIONS: 1 << 4,
  AIS_OFFSETS: 1 << 5,
  SELF_ID: 1 << 6,
  NAME: 1 << 7,
} as const;

function metresToCm(value: number | undefined): number | undefined {
  if (!isFiniteNumber(value)) return undefined;
  return clamp(Math.round(value * 100), 0, 0xffff);
}

function metresToOffsetCm(value: number | undefined): number | undefined {
  if (!isFiniteNumber(value)) return undefined;
  return clamp(Math.round(value * 100), -0x8000, 0x7fff);
}

export function encodeStatic(info: StaticInfo): Buffer {
  if (!info.selfId) {
    throw new Error("static: selfId is required");
  }

  const mmsi =
    info.mmsi !== undefined ? requireU32(info.mmsi, "mmsi") : undefined;
  const imo = info.imo !== undefined ? requireU32(info.imo, "imo") : undefined;
  const shipType =
    info.shipType !== undefined
      ? clamp(Math.round(info.shipType), 0, 0xffff)
      : undefined;
  const loa = metresToCm(info.lengthOverall);
  const beam = metresToCm(info.beam);
  const draft = metresToCm(info.draft);
  const fromBow = metresToOffsetCm(info.fromBow);
  const fromCenter = metresToOffsetCm(info.fromCenter);
  const hasDimensions =
    loa !== undefined && beam !== undefined && draft !== undefined;
  const hasOffsets = fromBow !== undefined && fromCenter !== undefined;

  let flags = FLAG.SELF_ID;
  if (mmsi !== undefined) flags |= FLAG.MMSI;
  if (imo !== undefined) flags |= FLAG.IMO;
  if (info.callsign) flags |= FLAG.CALLSIGN;
  if (shipType !== undefined) flags |= FLAG.SHIP_TYPE;
  if (hasDimensions) flags |= FLAG.DIMENSIONS;
  if (hasOffsets) flags |= FLAG.AIS_OFFSETS;
  if (info.name) flags |= FLAG.NAME;

  const out = Buffer.allocUnsafe(MAX_STATIC_BYTES);
  let offset = 0;
  out.writeUInt8(STATIC_VERSION, offset);
  offset += 1;
  out.writeUInt16BE(flags, offset);
  offset += 2;

  if (mmsi !== undefined) {
    out.writeUInt32BE(mmsi, offset);
    offset += 4;
  }
  if (imo !== undefined) {
    out.writeUInt32BE(imo, offset);
    offset += 4;
  }
  if (shipType !== undefined) {
    out.writeUInt16BE(shipType, offset);
    offset += 2;
  }
  if (hasDimensions) {
    out.writeUInt16BE(loa as number, offset);
    offset += 2;
    out.writeUInt16BE(beam as number, offset);
    offset += 2;
    out.writeUInt16BE(draft as number, offset);
    offset += 2;
  }
  if (hasOffsets) {
    out.writeInt16BE(fromBow as number, offset);
    offset += 2;
    out.writeInt16BE(fromCenter as number, offset);
    offset += 2;
  }

  offset = writeString8(out, offset, info.selfId);
  if (info.name) offset = writeString8(out, offset, info.name);
  if (info.callsign) offset = writeString8(out, offset, info.callsign);

  return Buffer.from(out.subarray(0, offset));
}

export function decodeStatic(data: Buffer): StaticInfo {
  let offset = 0;
  const take = (bytes: number): number => {
    if (offset + bytes > data.length) {
      throw new Error("static: truncated record");
    }
    const start = offset;
    offset += bytes;
    return start;
  };

  const version = data.readUInt8(take(1));
  if (version !== STATIC_VERSION) {
    throw new Error(`static: unsupported version ${version}`);
  }
  const flags = data.readUInt16BE(take(2));

  const info: Partial<StaticInfo> = {};
  if (flags & FLAG.MMSI) info.mmsi = data.readUInt32BE(take(4));
  if (flags & FLAG.IMO) info.imo = data.readUInt32BE(take(4));
  if (flags & FLAG.SHIP_TYPE) info.shipType = data.readUInt16BE(take(2));
  if (flags & FLAG.DIMENSIONS) {
    info.lengthOverall = data.readUInt16BE(take(2)) / 100;
    info.beam = data.readUInt16BE(take(2)) / 100;
    info.draft = data.readUInt16BE(take(2)) / 100;
  }
  if (flags & FLAG.AIS_OFFSETS) {
    info.fromBow = data.readInt16BE(take(2)) / 100;
    info.fromCenter = data.readInt16BE(take(2)) / 100;
  }
  if (flags & FLAG.SELF_ID) {
    const read = readString8(data, offset);
    info.selfId = read.value;
    offset = read.offset;
  }
  if (flags & FLAG.NAME) {
    const read = readString8(data, offset);
    info.name = read.value;
    offset = read.offset;
  }
  if (flags & FLAG.CALLSIGN) {
    const read = readString8(data, offset);
    info.callsign = read.value;
    offset = read.offset;
  }

  if (!info.selfId) {
    throw new Error("static: missing selfId");
  }
  if (offset !== data.length) {
    throw new Error(`static: ${data.length - offset} trailing bytes`);
  }
  return info as StaticInfo;
}
