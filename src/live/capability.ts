import { clamp, readString8, requireU32, writeString8 } from "../data/codec.js";

export const CAPABILITY_VERSION = 1;
export const CAPABILITY_TOPIC_BYTES = 32;

const FLAG_RELAY_CONSENT = 1;
const FLAG_REACHABLE = 2;
const FLAG_UNMETERED = 4;

export interface CapabilityRecord {
  /** The 32-byte network topic this capability applies to. */
  topic: Buffer;
  /** The advertiser's Signal K selfId (or a synthetic peer id). */
  selfId: string;
  /** Unix seconds. */
  updatedAt: number;
  /** Unix seconds when the advertiser's current process started. */
  uptimeSince: number;
  relayConsent: boolean;
  reachable: boolean;
  unmetered: boolean;
  /** Relative capacity weight, 1..255. */
  capacity: number;
  /** Current load, 0..100. */
  load: number;
}

export function encodeCapability(record: CapabilityRecord): Buffer {
  if (record.topic.length !== CAPABILITY_TOPIC_BYTES) {
    throw new Error("capability: topic must be 32 bytes");
  }
  const selfId = Buffer.from(record.selfId, "utf8");
  if (selfId.length > 255) {
    throw new Error("capability: selfId too long");
  }

  let flags = 0;
  if (record.relayConsent) flags |= FLAG_RELAY_CONSENT;
  if (record.reachable) flags |= FLAG_REACHABLE;
  if (record.unmetered) flags |= FLAG_UNMETERED;

  const total =
    1 + 1 + CAPABILITY_TOPIC_BYTES + 1 + selfId.length + 4 + 4 + 1 + 1;
  const out = Buffer.allocUnsafe(total);
  let offset = 0;
  out.writeUInt8(CAPABILITY_VERSION, offset);
  offset += 1;
  out.writeUInt8(flags, offset);
  offset += 1;
  record.topic.copy(out, offset);
  offset += CAPABILITY_TOPIC_BYTES;
  offset = writeString8(out, offset, record.selfId);
  out.writeUInt32BE(requireU32(record.updatedAt, "updatedAt"), offset);
  offset += 4;
  out.writeUInt32BE(requireU32(record.uptimeSince, "uptimeSince"), offset);
  offset += 4;
  out.writeUInt8(clamp(Math.round(record.capacity), 1, 255), offset);
  offset += 1;
  out.writeUInt8(clamp(Math.round(record.load), 0, 100), offset);
  offset += 1;

  if (offset !== total) {
    throw new Error("capability: internal length mismatch");
  }
  return out;
}

export function decodeCapability(data: Buffer): CapabilityRecord {
  let offset = 0;
  const take = (bytes: number): number => {
    if (offset + bytes > data.length) {
      throw new Error("capability: truncated record");
    }
    const start = offset;
    offset += bytes;
    return start;
  };

  const version = data.readUInt8(take(1));
  if (version !== CAPABILITY_VERSION) {
    throw new Error(`capability: unsupported version ${version}`);
  }
  const flags = data.readUInt8(take(1));
  const topic = Buffer.from(
    data.subarray(take(CAPABILITY_TOPIC_BYTES), offset),
  );

  const read = readString8(data, offset);
  const selfId = read.value;
  offset = read.offset;

  const updatedAt = data.readUInt32BE(take(4));
  const uptimeSince = data.readUInt32BE(take(4));
  const capacity = data.readUInt8(take(1));
  const load = data.readUInt8(take(1));

  if (offset !== data.length) {
    throw new Error(`capability: ${data.length - offset} trailing bytes`);
  }

  return {
    topic,
    selfId,
    updatedAt,
    uptimeSince,
    relayConsent: (flags & FLAG_RELAY_CONSENT) !== 0,
    reachable: (flags & FLAG_REACHABLE) !== 0,
    unmetered: (flags & FLAG_UNMETERED) !== 0,
    capacity,
    load,
  };
}
