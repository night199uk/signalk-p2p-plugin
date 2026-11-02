/**
 * A live message is a length-prefixed bundle of records from one source.
 * Relays concatenate these buffers without parsing them, so the length prefix
 * is what lets a receiver split them again.
 *
 * A signed message carries an Ed25519 signature at the end, over every preceding
 * byte (including the length prefix). The receiver verifies it with `sourceKey`.
 */

export const LIVE_MESSAGE_VERSION = 2;

const KIND_BATCH = 1;
const FLAG_SIGNED = 1;
const SOURCE_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const FIXED_HEADER_BYTES = 4 + 1 + 1 + 1 + SOURCE_KEY_BYTES + 1 + 2;

export interface LiveMessage {
  /** Raw 32-byte Ed25519 public key of the sender. */
  sourceKey: Buffer;
  /** The sender's Signal K selfId. */
  selfId: string;
  /** Each record is a self-contained envelope. */
  records: Buffer[];
  /** Present when the message was signed. */
  signature?: Buffer;
  /** The exact bytes the signature covers (everything before the signature). */
  signedBytes?: Buffer;
}

export interface EncodeLiveMessageOptions {
  sign?: (data: Buffer) => Buffer;
}

export function encodeLiveMessage(
  message: LiveMessage,
  options: EncodeLiveMessageOptions = {},
): Buffer {
  if (message.sourceKey.length !== SOURCE_KEY_BYTES) {
    throw new Error("live: sourceKey must be 32 bytes");
  }
  const selfId = Buffer.from(message.selfId, "utf8");
  if (selfId.length > 255) {
    throw new Error("live: selfId too long");
  }

  const signed = options.sign !== undefined;
  let total =
    FIXED_HEADER_BYTES + selfId.length + (signed ? SIGNATURE_BYTES : 0);
  for (const record of message.records) {
    if (record.length > 0xffff) {
      throw new Error("live: record too large");
    }
    total += 2 + record.length;
  }
  if (total > 0xffffffff) {
    throw new Error("live: message too large");
  }

  const out = Buffer.allocUnsafe(total);
  let offset = 0;
  out.writeUInt32BE(total, offset);
  offset += 4;
  out.writeUInt8(LIVE_MESSAGE_VERSION, offset);
  offset += 1;
  out.writeUInt8(KIND_BATCH, offset);
  offset += 1;
  out.writeUInt8(signed ? FLAG_SIGNED : 0, offset);
  offset += 1;
  message.sourceKey.copy(out, offset);
  offset += SOURCE_KEY_BYTES;
  out.writeUInt8(selfId.length, offset);
  offset += 1;
  selfId.copy(out, offset);
  offset += selfId.length;
  out.writeUInt16BE(message.records.length, offset);
  offset += 2;
  for (const record of message.records) {
    out.writeUInt16BE(record.length, offset);
    offset += 2;
    record.copy(out, offset);
    offset += record.length;
  }

  if (signed) {
    const signature = options.sign!(out.subarray(0, offset));
    if (signature.length !== SIGNATURE_BYTES) {
      throw new Error("live: signature must be 64 bytes");
    }
    signature.copy(out, offset);
    offset += SIGNATURE_BYTES;
  }

  if (offset !== total) {
    throw new Error("live: internal length mismatch");
  }
  return out;
}

/** Parse one or more concatenated live messages. */
export function decodeLiveMessages(data: Buffer): LiveMessage[] {
  const messages: LiveMessage[] = [];
  let offset = 0;

  while (offset < data.length) {
    if (offset + 4 > data.length) {
      throw new Error("live: truncated message length");
    }
    const length = data.readUInt32BE(offset);
    if (length < FIXED_HEADER_BYTES || offset + length > data.length) {
      throw new Error("live: invalid message length");
    }
    const end = offset + length;
    let cursor = offset + 4;

    const version = data.readUInt8(cursor);
    cursor += 1;
    if (version !== LIVE_MESSAGE_VERSION) {
      throw new Error(`live: unsupported version ${version}`);
    }
    const kind = data.readUInt8(cursor);
    cursor += 1;
    if (kind !== KIND_BATCH) {
      throw new Error(`live: unsupported kind ${kind}`);
    }
    const flags = data.readUInt8(cursor);
    cursor += 1;
    const signed = (flags & FLAG_SIGNED) !== 0;

    const sourceKey = Buffer.from(
      data.subarray(cursor, cursor + SOURCE_KEY_BYTES),
    );
    cursor += SOURCE_KEY_BYTES;

    const selfIdLength = data.readUInt8(cursor);
    cursor += 1;
    if (cursor + selfIdLength > end) {
      throw new Error("live: truncated selfId");
    }
    const selfId = data.toString("utf8", cursor, cursor + selfIdLength);
    cursor += selfIdLength;

    if (cursor + 2 > end) {
      throw new Error("live: truncated record count");
    }
    const count = data.readUInt16BE(cursor);
    cursor += 2;

    const records: Buffer[] = [];
    for (let index = 0; index < count; index += 1) {
      if (cursor + 2 > end) {
        throw new Error("live: truncated record length");
      }
      const recordLength = data.readUInt16BE(cursor);
      cursor += 2;
      if (cursor + recordLength > end) {
        throw new Error("live: truncated record");
      }
      records.push(Buffer.from(data.subarray(cursor, cursor + recordLength)));
      cursor += recordLength;
    }

    let signature: Buffer | undefined;
    let signedBytes: Buffer | undefined;
    if (signed) {
      if (cursor + SIGNATURE_BYTES > end) {
        throw new Error("live: truncated signature");
      }
      signedBytes = data.subarray(offset, cursor);
      signature = Buffer.from(data.subarray(cursor, cursor + SIGNATURE_BYTES));
      cursor += SIGNATURE_BYTES;
    }

    if (cursor !== end) {
      throw new Error("live: trailing bytes in message");
    }
    messages.push({ sourceKey, selfId, records, signature, signedBytes });
    offset = end;
  }

  return messages;
}
