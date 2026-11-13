import { describe, expect, it } from "vitest";
import {
  DATA_SETS,
  defaultConfig,
  resolveConfig,
  schema,
} from "../src/config.js";

describe("config", () => {
  it("defaults to sharing identity, position, navigation and depth publicly", () => {
    const config = defaultConfig();

    expect(config.sharing.identity.public).toBe(true);
    expect(config.sharing.position.public).toBe(true);
    expect(config.sharing.navigation.public).toBe(true);
    expect(config.sharing.depth.public).toBe(true);
    expect(config.sharing.tanksFuel.public).toBe(false);
    expect(config.sharing.propulsion.public).toBe(false);
    expect(config.sharing.electrical.public).toBe(false);
    expect(DATA_SETS.some((dataSet) => dataSet.id === "electrical")).toBe(true);
    expect(config.networks[0].id).toBe("all-vessels");
    expect(config.networks[0].enabled).toBe(true);
    expect(config.networks[0].consent).toBe("receive-only");
    expect(config.ais.mode).toBe("subscribe");
    expect(config.ais.public).toBe(false);
    expect(config.ais.sources).toBe("all");
  });

  it("merges a partial data-set override without dropping its sibling", () => {
    const config = resolveConfig({
      sharing: {
        destination: { public: true, groups: ["grp_1"] },
      },
      networks: [
        {
          id: "all-vessels",
          kind: "public",
          enabled: false,
          consent: "underway-gated",
        },
      ],
    });

    expect(config.sharing.destination).toEqual({
      public: true,
      groups: ["grp_1"],
    });
    expect(config.sharing.identity.public).toBe(true);
    expect(config.networks[0].enabled).toBe(false);
    expect(config.networks[0].consent).toBe("underway-gated");
  });

  it("hides advanced settings from the plugin config schema", () => {
    const generated = schema() as {
      properties: Record<string, { properties?: Record<string, unknown> }>;
    };
    expect(Object.keys(generated.properties).sort()).toEqual([
      "election",
      "inject",
    ]);
    expect(generated.properties.election.properties).toEqual({
      relayConsent: expect.any(Object),
    });
    expect(generated.properties.inject.properties).toEqual({
      enabled: expect.any(Object),
    });
    for (const hidden of [
      "sharing",
      "sharding",
      "security",
      "networks",
      "ais",
      "identity",
      "bootstrapPeers",
    ]) {
      expect(generated.properties).not.toHaveProperty(hidden);
    }
  });
});
