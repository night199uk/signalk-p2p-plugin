import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLUGIN_VERSION } from "../src/plugin.js";

describe("admin webapp", () => {
  it("ships an entry point that calls the admin-gated plugin API", () => {
    const html = readFileSync(
      new URL("../public/index.html", import.meta.url),
      "utf8",
    );
    expect(html).toContain("Signal K P2P");
    expect(html).toContain("/plugins/signalk-p2p-plugin");
    expect(html).toContain("renderIdentity(");
    expect(html).toContain("renderPublicNetwork(");
    expect(html).toContain('call("/sharing")');
    expect(html).toContain("setPublic(");
  });

  it("is declared as a webapp and ships the public directory", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      keywords: string[];
      files: string[];
      version: string;
      signalk: { appIcon?: string };
    };
    expect(pkg.keywords).toContain("signalk-webapp");
    expect(pkg.files).toContain("public");
    expect(pkg.signalk.appIcon).toBe("icon.svg");
    expect(PLUGIN_VERSION).toBe(pkg.version);
  });
});
