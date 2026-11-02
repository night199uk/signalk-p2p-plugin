/**
 * End-to-end smoke test for the plugin path without a full Signal K server.
 *
 * Two mock Signal K apps start the plugin. Both join the public topic on the
 * deployed VPS relay, publish self snapshots, and inject each other's data.
 * Run with: npm run smoke:plugin
 */
import { mkdir, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Delta, ServerAPI } from "@signalk/server-api";
import { encodeEnvelope } from "../src/data/envelope.js";
import { generateIdentity, loadOrCreateIdentity } from "../src/identity.js";
import { LiveClient } from "../src/live/client.js";
import { ALL_VESSELS_TOPIC, networkTopic } from "../src/live/topic.js";
import createPlugin from "../src/plugin.js";
import { createAttestation } from "../src/security/attestor.js";
import { encodeClaim } from "../src/security/claim.js";

const A_ID = "urn:mrn:signalk:uuid:11111111-1111-4111-8111-111111111111";

interface MockApp {
  app: ServerAPI;
  dataDir: string;
  emit(delta: Delta): void;
  waitForRemote(
    timeoutMs: number,
    match?: (delta: Delta) => boolean,
  ): Promise<Delta>;
  waitFor(
    match: (delta: Delta) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<Delta>;
}

async function createMockApp(
  selfId: string,
  name: string,
  mmsi: number,
  dataDir: string,
): Promise<MockApp> {
  await mkdir(dataDir, { recursive: true });
  const values = new Map<string, unknown>([
    ["name", { value: name }],
    ["mmsi", { value: String(mmsi) }],
    ["design.length", { value: { overall: 12 } }],
    ["design.aisShipType", { value: { id: 36 } }],
    ["navigation.position", { value: { latitude: 50.7, longitude: -1.9 } }],
  ]);
  const subscriptions: Array<{
    context: unknown;
    callback: (delta: Delta) => void;
  }> = [];
  const received: Delta[] = [];
  let resolveRemote: ((delta: Delta) => void) | undefined;

  const app = {
    selfId,
    getDataDirPath: () => dataDir,
    getSelfPath: (path: string) => values.get(path),
    subscriptionmanager: {
      subscribe: (
        command: { context?: unknown },
        unsubscribes: Array<() => void>,
        _onError: (error: unknown) => void,
        onDelta: (delta: Delta) => void,
      ) => {
        unsubscribes.push(() => {});
        subscriptions.push({ context: command.context, callback: onDelta });
      },
    },
    handleMessage: (pluginId: string, delta: Delta) => {
      received.push(delta);
      const context = delta.context ?? "";
      if (
        context.startsWith("vessels.urn:mrn:signalk:uuid:") &&
        context !== `vessels.${selfId}`
      ) {
        resolveRemote?.(delta);
      }
    },
    setPluginStatus: (message: string) =>
      console.log(`[${name}] status: ${message}`),
    setPluginError: (message: string) =>
      console.error(`[${name}] error: ${message}`),
    debug: (message: string) => {
      if (process.env.DEBUG !== undefined) console.log(`[${name}] ${message}`);
    },
    error: (message: string) => console.error(`[${name}] ${message}`),
  } as unknown as ServerAPI;

  return {
    app,
    dataDir,
    emit: (delta: Delta) => {
      for (const subscription of subscriptions) {
        if (
          subscription.context === "vessels.self" &&
          delta.context !== "vessels.self"
        ) {
          continue;
        }
        subscription.callback(delta);
      }
    },
    waitForRemote: (timeoutMs, match) =>
      new Promise<Delta>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("no remote vessel arrived")),
          timeoutMs,
        );
        resolveRemote = (delta) => {
          if (match && !match(delta)) return;
          clearTimeout(timer);
          resolve(delta);
        };
      }),
    waitFor: async (match, timeoutMs, label) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = received.find(match);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`timeout waiting for ${label}`);
    },
  };
}

async function main(): Promise<void> {
  // Stable data dirs keep the identity keys stable across runs, so the relay's
  // replayed history still verifies and the TOFU binding does not flip.
  const a = await createMockApp(
    A_ID,
    "Vessel A",
    232001234,
    join(tmpdir(), "skp2p-smoke-a"),
  );
  const b = await createMockApp(
    "urn:mrn:signalk:uuid:22222222-2222-4222-8222-222222222222",
    "Vessel B",
    232001235,
    join(tmpdir(), "skp2p-smoke-b"),
  );

  const attestor = generateIdentity();
  const attestorKey = attestor.publicKeyRaw.toString("hex");
  const config = {
    networks: [
      {
        id: "all-vessels",
        kind: "public" as const,
        enabled: true,
        consent: "opt-out" as const,
        rateHzUnderway: 0.2,
        rateHzMoored: 0.2,
      },
    ],
    security: {
      publicAttestors: [attestorKey],
      requireAttestation: false,
      attestationThreshold: 1,
    },
    election: {
      enabled: true,
      epochMinutes: 10,
      minUptimeMinutes: 0,
      relayConsent: false,
      reachable: false,
      unmetered: false,
      capacity: 1,
    },
    sharing: {
      temperature: { public: true, groups: "all" },
      wind: { public: true, groups: "all" },
      pressureHumidity: { public: true, groups: "all" },
      tanksFuel: { public: true, groups: "all" },
      destination: { public: true, groups: "all" },
      anchor: { public: true, groups: "all" },
    },
    ais: {
      public: true,
      groups: [],
      mode: "both" as const,
      maxTargets: 100,
      rateHz: 0.5,
    },
  };

  const pluginA = createPlugin(a.app);
  const pluginB = createPlugin(b.app);
  let attestorClient: LiveClient | undefined;

  try {
    await pluginA.start(config);
    await pluginB.start(config);
    console.log("plugins started; waiting for peers before publishing");

    await new Promise((resolve) => setTimeout(resolve, 4000));

    a.emit({
      context: "vessels.self",
      updates: [
        {
          timestamp: new Date().toISOString(),
          values: [
            {
              path: "navigation.position",
              value: { latitude: 51.5, longitude: -0.1 },
            },
            { path: "navigation.speedOverGround", value: 4.2 },
            { path: "navigation.courseOverGroundTrue", value: 1.2 },
            { path: "navigation.courseOverGroundMagnetic", value: 1.19 },
            { path: "navigation.headingTrue", value: 1.2 },
            { path: "navigation.headingMagnetic", value: 1.18 },
            { path: "navigation.magneticVariation", value: -0.001 },
            { path: "navigation.speedThroughWater", value: 4.0 },
            {
              path: "navigation.attitude",
              value: { roll: 0.05, pitch: -0.01, yaw: 1.19 },
            },
            { path: "navigation.rateOfTurn", value: 0.01 },
            { path: "navigation.gnss.horizontalDilution", value: 0.8 },
            { path: "navigation.gnss.verticalDilution", value: 1.2 },
            { path: "navigation.gnss.satellites", value: 14 },
            { path: "environment.wind.speedTrue", value: 7.5 },
            { path: "environment.water.temperature", value: 285.15 },
            { path: "environment.outside.pressure", value: 101325 },
            { path: "tanks.fuel.0.currentLevel", value: 0.6 },
            { path: "navigation.destination.commonName", value: "Cowes" },
            { path: "navigation.anchor.radius", value: 30 },
          ],
        },
      ],
    } as Delta);

    a.emit({
      context: "vessels.urn:mrn:imo:mmsi:232001999",
      updates: [
        {
          timestamp: new Date().toISOString(),
          source: { label: "test-ais" },
          values: [
            {
              path: "navigation.position",
              value: { latitude: 51.51, longitude: -0.11 },
            },
            { path: "navigation.courseOverGroundTrue", value: 0.5 },
            { path: "navigation.speedOverGround", value: 3.2 },
            { path: "navigation.headingTrue", value: 0.6 },
            { path: "sensors.ais.class", value: "A" },
            { path: "name", value: "Target Vessel" },
            { path: "callsign", value: "TGT1" },
            { path: "design.aisShipType", value: { id: 36 } },
          ],
        },
      ],
    } as Delta);

    const remote = await b.waitForRemote(30_000, (delta) => {
      const update = delta.updates?.[0];
      if (!update || !("values" in update)) return false;
      return update.values.some(
        (value) =>
          value.path === "navigation.position" &&
          (value.value as { latitude?: number } | undefined)?.latitude === 51.5,
      );
    });
    console.log("B injected remote context:", remote.context);
    const update = remote.updates?.[0] as {
      source?: { label?: string };
      values?: Array<{ path: string; value: unknown }>;
    };
    console.log("source label:", update?.source?.label);
    console.log("values:", JSON.stringify(update?.values));

    const extended = await b.waitFor(
      (delta) => {
        const item = delta.updates?.[0];
        if (!item || !("values" in item)) return false;
        return item.values.some(
          (value) => value.path === "environment.wind.speedTrue",
        );
      },
      30_000,
      "extended values",
    );
    console.log(
      "extended values:",
      JSON.stringify(extended.updates?.[0]?.values),
    );

    const ais = await b.waitFor(
      (delta) => delta.context === "vessels.urn:mrn:imo:mmsi:232001999",
      30_000,
      "AIS target",
    );
    const aisUpdate = ais.updates?.[0] as {
      source?: { label?: string };
      values?: Array<{ path: string; value: unknown }>;
    };
    console.log("AIS source label:", aisUpdate?.source?.label);
    console.log("AIS values:", JSON.stringify(aisUpdate?.values));

    // Act as a configured public attestor and upgrade A's claim to attested.
    const identityA = await loadOrCreateIdentity(
      join(tmpdir(), "skp2p-smoke-a"),
    );
    attestorClient = new LiveClient({
      identity: attestor,
      selfId: `urn:mrn:signalk:uuid:${randomUUID()}`,
      topic: networkTopic(ALL_VESSELS_TOPIC),
      batchIntervalMs: 0,
      log: {
        info: () => {},
        error: (message) => console.error(`[attestor] ${message}`),
        debug: () => {},
      },
    });
    await attestorClient.start();
    await new Promise((resolve) => setTimeout(resolve, 4000));

    const attestation = createAttestation(
      attestor,
      A_ID,
      identityA.publicKeyRaw,
      { now: Math.floor(Date.now() / 1000) },
    );
    attestorClient.enqueue(encodeEnvelope("claim", encodeClaim(attestation)));
    attestorClient.flush();
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const claims = JSON.parse(
      await readFile(join(b.dataDir, "claims.json"), "utf8"),
    ) as Array<{ selfId: string; status: string }>;
    const binding = claims.find((entry) => entry.selfId === A_ID);
    console.log("B attestation status:", binding?.status);
    if (binding?.status !== "attested") {
      throw new Error("attestation did not update the receiver");
    }
    console.log("SMOKE OK");
  } finally {
    pluginA.stop();
    pluginB.stop();
    await attestorClient?.stop();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
