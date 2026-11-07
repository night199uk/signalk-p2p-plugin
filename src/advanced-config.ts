import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";

export const ADVANCED_CONFIG_FILE = "advanced.json";

/**
 * Advanced settings live outside the Signal K plugin configuration form so a
 * form save cannot drop them. The form owns only the simple relay/injection
 * toggles; sharing, network consent, AIS, security and topology stay here.
 */
export function loadAdvancedConfig(
  dataDir: string,
  legacy: Partial<Config>,
): Partial<Config> {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(dataDir, ADVANCED_CONFIG_FILE), "utf8"),
    );
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as Partial<Config>;
    }
  } catch {
    // No advanced file yet: migrate from the legacy plugin configuration.
  }
  return legacy;
}

export function mergeSimpleConfig(
  advanced: Partial<Config>,
  simple: Partial<Config>,
): Partial<Config> {
  return {
    ...advanced,
    election: {
      ...(advanced.election ?? {}),
      ...(simple.election ?? {}),
    } as Config["election"],
    inject: {
      ...(advanced.inject ?? {}),
      ...(simple.inject ?? {}),
    } as Config["inject"],
  };
}

export function saveAdvancedConfig(dataDir: string, config: Config): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dataDir, ADVANCED_CONFIG_FILE),
    JSON.stringify(config, null, 2) + "\n",
    { mode: 0o600 },
  );
}
