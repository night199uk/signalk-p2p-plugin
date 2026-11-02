import { describe, expect, it } from "vitest";
import { LastWriterWins } from "../src/data/merge.js";

describe("LastWriterWins", () => {
  it("applies newer data and rejects older data", () => {
    const lww = new LastWriterWins();

    expect(
      lww.apply(
        "vessels.a",
        "navigation.position",
        { lat: 1 },
        {
          timestamp: 10,
          source: "b",
        },
      ),
    ).toBe(true);
    expect(
      lww.apply(
        "vessels.a",
        "navigation.position",
        { lat: 2 },
        {
          timestamp: 20,
          source: "b",
        },
      ),
    ).toBe(true);
    expect(
      lww.apply(
        "vessels.a",
        "navigation.position",
        { lat: 3 },
        {
          timestamp: 15,
          source: "b",
        },
      ),
    ).toBe(false);

    expect(lww.get("vessels.a", "navigation.position")?.value).toEqual({
      lat: 2,
    });
  });

  it("lets local data win an exact timestamp tie", () => {
    const lww = new LastWriterWins();

    lww.apply("vessels.a", "name", "remote", {
      timestamp: 10,
      source: "z",
      priority: 0,
    });
    expect(
      lww.apply("vessels.a", "name", "local", {
        timestamp: 10,
        source: "a",
        priority: 1,
      }),
    ).toBe(true);
    expect(lww.get("vessels.a", "name")?.value).toBe("local");
  });

  it("breaks equal timestamps deterministically by source", () => {
    const lww = new LastWriterWins();

    expect(
      lww.apply("vessels.a", "name", "from-b", {
        timestamp: 10,
        source: "b",
      }),
    ).toBe(true);
    expect(
      lww.apply("vessels.a", "name", "from-a", {
        timestamp: 10,
        source: "a",
      }),
    ).toBe(true);
    expect(
      lww.apply("vessels.a", "name", "from-c", {
        timestamp: 10,
        source: "c",
      }),
    ).toBe(false);
    expect(lww.get("vessels.a", "name")?.value).toBe("from-a");
  });

  it("groups values by context and can drop a context", () => {
    const lww = new LastWriterWins();
    lww.apply("vessels.a", "name", "A", { timestamp: 1, source: "s" });
    lww.apply("vessels.a", "mmsi", "1", { timestamp: 1, source: "s" });
    lww.apply("vessels.b", "name", "B", { timestamp: 1, source: "s" });

    expect([...lww.values("vessels.a").keys()]).toEqual(["name", "mmsi"]);
    expect(lww.contexts().sort()).toEqual(["vessels.a", "vessels.b"]);

    lww.deleteContext("vessels.a");
    expect(lww.get("vessels.a", "name")).toBeUndefined();
    expect(lww.size).toBe(1);
  });
});
