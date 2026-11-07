import type { RecordType } from "./types.js";

export const PROTOCOL_VERSION = 1;

const enum WireRecordType {
  Snapshot = 1,
  Static = 2,
  Values = 3,
  AisSnapshot = 4,
  AisStatic = 5,
  Claim = 6,
  Capability = 7,
  GroupRoster = 8,
  GroupJoin = 9,
  GroupRosterRequest = 10,
  Policy = 11,
  GroupInvite = 12,
}

const WIRE_TYPES: Record<RecordType, WireRecordType> = {
  snapshot: WireRecordType.Snapshot,
  static: WireRecordType.Static,
  values: WireRecordType.Values,
  "ais-snapshot": WireRecordType.AisSnapshot,
  "ais-static": WireRecordType.AisStatic,
  claim: WireRecordType.Claim,
  capability: WireRecordType.Capability,
  policy: WireRecordType.Policy,
  "group-invite": WireRecordType.GroupInvite,
  "group-roster": WireRecordType.GroupRoster,
  "group-join": WireRecordType.GroupJoin,
  "group-roster-request": WireRecordType.GroupRosterRequest,
};

const WIRE_TYPE_NAMES: Record<number, RecordType> = {
  [WireRecordType.Snapshot]: "snapshot",
  [WireRecordType.Static]: "static",
  [WireRecordType.Values]: "values",
  [WireRecordType.AisSnapshot]: "ais-snapshot",
  [WireRecordType.AisStatic]: "ais-static",
  [WireRecordType.Claim]: "claim",
  [WireRecordType.Capability]: "capability",
  [WireRecordType.Policy]: "policy",
  [WireRecordType.GroupInvite]: "group-invite",
  [WireRecordType.GroupRoster]: "group-roster",
  [WireRecordType.GroupJoin]: "group-join",
  [WireRecordType.GroupRosterRequest]: "group-roster-request",
};

export interface Envelope {
  version: number;
  type: RecordType;
  payload: Buffer;
}

const HEADER_BYTES = 4;

export function encodeEnvelope(type: RecordType, payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
  out.writeUInt8(PROTOCOL_VERSION, 0);
  out.writeUInt8(WIRE_TYPES[type], 1);
  out.writeUInt16BE(payload.length, 2);
  payload.copy(out, HEADER_BYTES);
  return out;
}

export function decodeEnvelope(data: Buffer): Envelope {
  if (data.length < HEADER_BYTES) {
    throw new Error("envelope: buffer too short");
  }
  const version = data.readUInt8(0);
  const wireType = data.readUInt8(1);
  const length = data.readUInt16BE(2);
  if (data.length !== HEADER_BYTES + length) {
    throw new Error(
      `envelope: expected ${length} payload bytes, got ${data.length - HEADER_BYTES}`,
    );
  }
  const type = WIRE_TYPE_NAMES[wireType];
  if (!type) {
    throw new Error(`envelope: unknown record type ${wireType}`);
  }
  return { version, type, payload: data.subarray(HEADER_BYTES) };
}
