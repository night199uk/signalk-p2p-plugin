import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_VESSELS_TOPIC } from "../live/topic.js";
import {
  defaultPolicy,
  decodePolicy,
  verifyPolicy,
  type NetworkPolicy,
  type SignedPolicy,
} from "./policy.js";

/** Public key of the all-vessels network operator. */
export const DEFAULT_OPERATOR_PUBLIC_KEY =
  "b393c24608f23cdb389cfb0cbc8c9de619345fa110cdddcb14ab6afdb494db09";

export const DEFAULT_OPERATOR_FINGERPRINT =
  "254375e336e45f93bb5691e49fdb4e758fefed7981940d98dc9773b8b23390bf";

export function defaultOperatorKeys(): string[] {
  return [DEFAULT_OPERATOR_PUBLIC_KEY];
}

export function operatorKeysFromConfig(keys?: string[]): string[] {
  return keys && keys.length > 0 ? keys : defaultOperatorKeys();
}

/** The signed policy shipped in the package, if present and valid. */
export function loadShippedPolicy(
  operatorKeys: string[] = defaultOperatorKeys(),
): SignedPolicy | undefined {
  try {
    const data = readFileSync(
      new URL("../../policy/default.json", import.meta.url),
    );
    const signed = decodePolicy(data);
    return verifyPolicy(signed, operatorKeys, ALL_VESSELS_TOPIC)
      ? signed
      : undefined;
  } catch {
    return undefined;
  }
}

/** The newest valid policy from the package or this instance's cache. */
export function effectivePolicy(
  dataDir: string,
  operatorKeys: string[] = defaultOperatorKeys(),
): NetworkPolicy {
  const shipped = loadShippedPolicy(operatorKeys)?.policy ?? defaultPolicy();
  const cached = loadCachedPolicy(dataDir, operatorKeys);
  if (cached && cached.policy.version > shipped.version) {
    return cached.policy;
  }
  return shipped;
}

export function loadCachedPolicy(
  dataDir: string,
  operatorKeys: string[] = defaultOperatorKeys(),
): SignedPolicy | undefined {
  try {
    const data = readFileSync(join(dataDir, "policy.json"));
    const signed = decodePolicy(data);
    return verifyPolicy(signed, operatorKeys, ALL_VESSELS_TOPIC)
      ? signed
      : undefined;
  } catch {
    return undefined;
  }
}

export function saveCachedPolicy(dataDir: string, signed: SignedPolicy): void {
  writeFileSync(join(dataDir, "policy.json"), JSON.stringify(signed) + "\n", {
    mode: 0o600,
  });
}
