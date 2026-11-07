import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadAdvancedConfig,
  mergeSimpleConfig,
  saveAdvancedConfig,
} from "../src/advanced-config.js";
import { defaultConfig, resolveConfig } from "../src/config.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("advanced config", () => {
  it("migrates the legacy configuration when no file exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skp2p-advanced-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const legacy = defaultConfig();
    legacy.sharing.position.public = false;
    expect(loadAdvancedConfig(directory, legacy)).toBe(legacy);
  });

  it("preserves sharing while overlaying the simple form fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skp2p-advanced-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const saved = defaultConfig();
    saved.sharing.position.public = false;
    saved.election.relayConsent = true;
    saved.inject.enabled = true;
    saveAdvancedConfig(directory, saved);

    const loaded = loadAdvancedConfig(directory, {});
    const merged = resolveConfig(
      mergeSimpleConfig(loaded, {
        election: { relayConsent: false } as never,
        inject: { enabled: false } as never,
      }),
    );
    expect(merged.sharing.position.public).toBe(false);
    expect(merged.election.relayConsent).toBe(false);
    expect(merged.election.epochMinutes).toBe(10);
    expect(merged.inject.enabled).toBe(false);
  });
});
