import { createHash } from "node:crypto";

/** The well-known name of the global public network. */
export const ALL_VESSELS_TOPIC = "signalk-p2p/all-vessels/v1";

/** Derive a 32-byte Hyperswarm topic from a human-readable network name. */
export function networkTopic(name: string): Buffer {
  return createHash("sha256").update(name, "utf8").digest();
}
