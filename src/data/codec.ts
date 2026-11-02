export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Radians to hundredths of a degree, normalised to 0..35999. */
export function encodeAngle(radians: number): number {
  const degrees = ((radians * 180) / Math.PI) % 360;
  const normalised = (degrees + 360) % 360;
  return Math.round(normalised * 100) % 36000;
}

export function decodeAngle(centidegrees: number): number {
  return ((centidegrees % 36000) / 100) * (Math.PI / 180);
}

/** Degrees to fixed-point 1e-7 degrees. */
export function encodeCoordinate(degrees: number): number {
  return Math.round(degrees * 1e7);
}

export function decodeCoordinate(fixed: number): number {
  return fixed / 1e7;
}

export function writeString8(
  buf: Buffer,
  offset: number,
  value: string,
): number {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > 255) {
    throw new Error(`codec: string too long (${bytes.length} > 255 bytes)`);
  }
  buf.writeUInt8(bytes.length, offset);
  bytes.copy(buf, offset + 1);
  return offset + 1 + bytes.length;
}

export function readString8(
  buf: Buffer,
  offset: number,
): { value: string; offset: number } {
  if (offset >= buf.length) {
    throw new Error("codec: truncated string length");
  }
  const length = buf.readUInt8(offset);
  const start = offset + 1;
  const end = start + length;
  if (end > buf.length) {
    throw new Error("codec: truncated string");
  }
  return { value: buf.toString("utf8", start, end), offset: end };
}

export function requireU32(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`codec: ${name} must be a uint32`);
  }
  return value;
}

export function requireCoordinate(
  value: number,
  name: string,
  limit: number,
): number {
  if (!isFiniteNumber(value) || Math.abs(value) > limit) {
    throw new Error(`codec: ${name} out of range`);
  }
  return value;
}
