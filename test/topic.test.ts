import { describe, expect, it } from "vitest";
import { ALL_VESSELS_TOPIC, networkTopic } from "../src/live/topic.js";

describe("networkTopic", () => {
  it("is a deterministic 32-byte topic", () => {
    const first = networkTopic(ALL_VESSELS_TOPIC);
    const second = networkTopic(ALL_VESSELS_TOPIC);

    expect(first).toHaveLength(32);
    expect(first.equals(second)).toBe(true);
  });

  it("differs between networks", () => {
    expect(networkTopic("group-a").equals(networkTopic("group-b"))).toBe(false);
  });
});
