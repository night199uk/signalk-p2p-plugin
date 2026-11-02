import { decode, encode } from "cborg";
import type { Values } from "./types.js";

/** Generic CBOR map for the non-navigation data sets. */
export function encodeValues(values: Values): Buffer {
  return Buffer.from(encode(values));
}

export function decodeValues(data: Buffer): Values {
  const decoded = decode(data);
  if (
    decoded === null ||
    typeof decoded !== "object" ||
    Array.isArray(decoded)
  ) {
    throw new Error("values: expected a map");
  }
  return decoded as Values;
}
