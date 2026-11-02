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
    expect(config.networks[0].id).toBe("all-vessels");
    expect(config.networks[0].enabled).toBe(true);
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

  it("exposes every data set in the schema", () => {
    const generated = schema() as {
      properties: { sharing: { properties: Record<string, unknown> } };
    };
    expect(Object.keys(generated.properties.sharing.properties)).toEqual(
      DATA_SETS.map((dataSet) => dataSet.id),
    );
  });
});
