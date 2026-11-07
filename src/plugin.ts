import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Context,
  Delta,
  Path,
  Plugin,
  PluginRouter,
  ServerAPI,
} from "@signalk/server-api";
import { AisTargetStore } from "./ais/store.js";
import { buildAisRecords } from "./ais/publish.js";
import {
  registerRoutes,
  type P2PControl,
  type P2PStatus,
  type SharingInfo,
} from "./api.js";
import { decodeAisSnapshot, decodeAisStatic } from "./data/ais.js";
import {
  DATA_SETS,
  resolveConfig,
  schema,
  type Config,
  type DataSetId,
  type NetworkConfig,
} from "./config.js";
import {
  decodeEnvelope,
  encodeEnvelope,
  PROTOCOL_VERSION,
  type Envelope,
} from "./data/envelope.js";
import {
  aisSnapshotToDelta,
  aisStaticToDelta,
  snapshotToDelta,
  staticToDelta,
  valuesToDelta,
} from "./data/inject.js";
import { decodeSnapshot, encodeSnapshot } from "./data/snapshot.js";
import { decodeStatic, encodeStatic } from "./data/static.js";
import { decodeValues, encodeValues } from "./data/values.js";
import { createGroupControl } from "./groups/control.js";
import { GroupManager } from "./groups/manager.js";
import { loadOrCreateIdentity, type Identity } from "./identity.js";
import { decodeCapability, encodeCapability } from "./live/capability.js";
import { LiveClient } from "./live/client.js";
import { PeerDirectory } from "./live/directory.js";
import type { LiveMessage } from "./live/message.js";
import { SelfPublisher } from "./live/publisher.js";
import { ALL_VESSELS_TOPIC, networkTopic } from "./live/topic.js";
import { decodeClaim, encodeClaim } from "./security/claim.js";
import { createClaimControl } from "./security/control.js";
import { ClaimRegistry } from "./security/registry.js";

export const PLUGIN_ID = "signalk-p2p-plugin";
export const PLUGIN_NAME = "Signal K P2P";
const PACKAGE_VERSION = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

export const PLUGIN_VERSION = PACKAGE_VERSION;

const PUBLIC_NETWORK_ID = "all-vessels";
const BATCH_INTERVAL_MS = 2000;
const VALUES_INTERVAL_MS = 60_000;
const STATIC_INTERVAL_MS = 600_000;
const CAPABILITY_INTERVAL_MS = 30_000;
const AIS_MAX_AGE_SECONDS = 900;
const AIS_PRECEDENCE_WINDOW_SECONDS = 300;
const AIS_PRUNE_INTERVAL_MS = 60_000;
const AIS_PATHS: string[] = [
  "navigation.position",
  "navigation.courseOverGroundTrue",
  "navigation.speedOverGround",
  "navigation.headingTrue",
  "navigation.state",
  "name",
  "callsign",
  "design.aisShipType",
  "sensors.ais.class",
  "mmsi",
];
const TICK_INTERVAL_MS = 1000;
const COARSE_POSITION_METERS = 5000;

const SNAPSHOT_PATHS: string[] = [
  "navigation.position",
  "navigation.courseOverGroundTrue",
  "navigation.courseOverGroundMagnetic",
  "navigation.speedOverGround",
  "navigation.speedThroughWater",
  "navigation.headingTrue",
  "navigation.headingMagnetic",
  "navigation.magneticVariation",
  "navigation.attitude",
  "navigation.rateOfTurn",
  "navigation.state",
  "navigation.gnss.methodQuality",
  "navigation.gnss.horizontalDilution",
  "navigation.gnss.verticalDilution",
  "navigation.gnss.satellites",
];

const VALUE_PATHS: string[] = [
  "environment.depth.*",
  "environment.water.temperature",
  "environment.outside.*",
  "environment.inside.*",
  "environment.wind.*",
  "tanks.*",
  "propulsion.*",
  "engine.*",
  "steering.*",
  "sensors.*",
  "navigation.destination.*",
  "navigation.anchor.*",
  "navigation.lights.*",
];

const INITIAL_VALUE_PATHS: string[] = [
  "environment.depth.belowSurface",
  "environment.depth.belowTransducer",
  "environment.depth.belowKeel",
  "environment.water.temperature",
  "environment.outside.temperature",
  "environment.outside.pressure",
  "environment.outside.relativeHumidity",
  "environment.wind.speedTrue",
  "environment.wind.directionTrue",
  "navigation.destination.commonName",
  "navigation.anchor.position",
  "navigation.anchor.radius",
];

const STATIC_PATHS: string[] = [
  "name",
  "mmsi",
  "imo",
  "callsign",
  "design.aisShipType",
  "design.length",
  "design.beam",
  "design.draft",
  "sensors.ais.fromBow",
  "sensors.ais.fromCenter",
];

export default function createPlugin(app: ServerAPI): Plugin {
  let config: Config = resolveConfig();
  let identity: Identity | undefined;
  let client: LiveClient | undefined;
  let publisher: SelfPublisher | undefined;
  let registry: ClaimRegistry | undefined;
  let directory: PeerDirectory | undefined;
  let groups: GroupManager | undefined;
  let selfId = "";
  let startedAt = 0;
  let running = false;
  let error: string | undefined;
  let injected = 0;
  let unsubscribes: Array<() => void> = [];
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let lastSnapshotAt = 0;
  let lastValuesAt = 0;
  let lastStaticAt = 0;
  let lastClaimAt = 0;
  let lastCapabilityAt = 0;
  let lastGroupSnapshotAt = 0;
  let lastGroupValuesAt = 0;
  let lastGroupStaticAt = 0;
  let aisStore: AisTargetStore | undefined;
  let selfMmsi: number | undefined;
  let lastAisAt = 0;
  let lastAisPruneAt = 0;
  const sentAisStatic = new Map<number, string>();
  const selfSeen = new Map<string, number>();
  const observationSeen = new Map<string, number>();
  const selfContexts = new Map<string, number>();

  const status = (): P2PStatus => {
    const now = Math.floor(Date.now() / 1000);
    const election = {
      now,
      epochSeconds: Math.max(1, config.election.epochMinutes) * 60,
      minUptimeSeconds: Math.max(0, config.election.minUptimeMinutes) * 60,
    };
    const eligible = directory?.eligible(election) ?? [];
    const elected =
      directory && config.election.enabled
        ? directory.elected(election)
        : undefined;

    return {
      started: running,
      version: PLUGIN_VERSION,
      identity: identity
        ? {
            fingerprint: identity.fingerprint,
            publicKey: identity.publicKeyRaw.toString("hex"),
          }
        : undefined,
      networks: config.networks.map((network) => ({
        id: network.id,
        kind: network.kind,
        enabled: network.enabled,
      })),
      peers: client?.peerCount ?? 0,
      injected,
      claims: registry?.snapshot().length ?? 0,
      groups: groups?.list().length ?? 0,
      eligiblePeers: eligible.length,
      electedPeer: elected
        ? {
            key: elected.key,
            selfId: elected.selfId,
            capacity: elected.capacity,
          }
        : undefined,
      error,
    };
  };

  function publicNetwork(): NetworkConfig | undefined {
    return config.networks.find(
      (network) => network.kind === "public" && network.enabled,
    );
  }

  function readSelfValue(path: string): unknown {
    const node = app.getSelfPath(path as Path) as unknown;
    if (
      node !== null &&
      typeof node === "object" &&
      "value" in (node as Record<string, unknown>)
    ) {
      return (node as { value: unknown }).value;
    }
    return node;
  }

  function loadInitialState(): void {
    if (!publisher) return;
    for (const path of [
      ...SNAPSHOT_PATHS,
      ...INITIAL_VALUE_PATHS,
      ...STATIC_PATHS,
    ]) {
      const value = readSelfValue(path);
      if (value !== undefined) {
        publisher.update(path, value);
      }
    }
  }

  function subscribeSelf(): void {
    const paths = [...SNAPSHOT_PATHS, ...VALUE_PATHS];
    app.subscriptionmanager.subscribe(
      {
        context: "vessels.self" as Context,
        subscribe: paths.map((path) => ({
          path: path as Path,
          policy: "instant" as const,
        })),
      },
      unsubscribes,
      (subscriptionError) =>
        app.error(`P2P subscription error: ${String(subscriptionError)}`),
      (delta: Delta) => publisher?.applyDelta(delta),
    );
  }

  function subscribeAis(): void {
    if (!aisStore) return;
    app.subscriptionmanager.subscribe(
      {
        context: "vessels.*" as Context,
        subscribe: AIS_PATHS.map((path) => ({
          path: path as Path,
          policy: "instant" as const,
        })),
        sourcePolicy: "all",
      },
      unsubscribes,
      (subscriptionError) =>
        app.error(`P2P AIS subscription error: ${String(subscriptionError)}`),
      (delta: Delta) =>
        aisStore?.applyDelta(delta, Math.floor(Date.now() / 1000)),
    );
  }

  function publishStatic(): void {
    if (!client || !publisher) return;
    const info = publisher.buildStatic();
    if (!info) return;
    client.enqueue(encodeEnvelope("static", encodeStatic(info)));
    lastStaticAt = Date.now();
  }

  function publishClaim(): void {
    if (!client || !identity) return;
    const now = Math.floor(Date.now() / 1000);
    client.enqueue(
      encodeEnvelope(
        "claim",
        encodeClaim({
          kind: "claim",
          selfId,
          subjectKey: identity.publicKeyRaw,
          issuerKey: identity.publicKeyRaw,
          issuedAt: now,
          expiresAt: 0,
        }),
      ),
    );
    lastClaimAt = Date.now();
  }

  function publishCapability(): void {
    if (!client || !identity) return;
    const now = Math.floor(Date.now() / 1000);
    const capability = {
      topic: networkTopic(ALL_VESSELS_TOPIC),
      selfId,
      updatedAt: now,
      uptimeSince: startedAt,
      relayConsent: config.election.relayConsent,
      reachable: config.election.reachable,
      unmetered: config.election.unmetered,
      capacity: config.election.capacity,
      load: 0,
    };
    directory?.update(capability, identity.publicKeyRaw, now);
    client.enqueue(encodeEnvelope("capability", encodeCapability(capability)));
    lastCapabilityAt = Date.now();
  }

  function sharesWith(audience: "all" | string[], groupId: string): boolean {
    return audience === "all" || audience.includes(groupId);
  }

  function dataSetForPath(path: string): DataSetId | undefined {
    if (path.startsWith("environment.depth.")) return "depth";
    if (
      path === "environment.water.temperature" ||
      path === "environment.outside.temperature" ||
      (path.startsWith("environment.inside.") && path.endsWith(".temperature"))
    ) {
      return "temperature";
    }
    if (path.startsWith("environment.wind.")) return "wind";
    if (
      path.startsWith("environment.outside.") ||
      path.startsWith("environment.inside.")
    ) {
      return "pressureHumidity";
    }
    if (path.startsWith("tanks.fuel.")) return "tanksFuel";
    if (path.startsWith("tanks.freshWater.")) return "tanksFreshWater";
    if (
      path.startsWith("tanks.blackWater.") ||
      path.startsWith("tanks.wasteWater.")
    ) {
      return "tanksHolding";
    }
    if (path.startsWith("navigation.destination.")) return "destination";
    if (path.startsWith("navigation.anchor.")) return "anchor";
    if (path.startsWith("propulsion.") || path.startsWith("engine.")) {
      return "propulsion";
    }
    if (
      path.startsWith("steering.") ||
      path.startsWith("navigation.lights.") ||
      (path.startsWith("sensors.") && !path.startsWith("sensors.ais."))
    ) {
      return "systems";
    }
    return undefined;
  }

  function valuesFilter(groupId?: string): (path: string) => boolean {
    return (path) => {
      const set = dataSetForPath(path);
      if (!set) return false;
      const share = config.sharing[set];
      if (groupId === undefined) return share.public;
      return share.groups === "all" || share.groups.includes(groupId);
    };
  }

  function publishGroups(
    now: number,
    interval: number,
    valuesChanged: boolean,
  ): void {
    const manager = groups;
    if (!manager) return;
    const sharing = config.sharing;
    const timestamp = Math.floor(now / 1000);
    const snapshotDue = now - lastGroupSnapshotAt >= interval;
    const valuesDue =
      valuesChanged || now - lastGroupValuesAt >= VALUES_INTERVAL_MS;
    const staticDue = now - lastGroupStaticAt >= STATIC_INTERVAL_MS;

    for (const info of manager.list()) {
      if (info.removed || !manager.canPublish(info.id)) continue;
      if (snapshotDue) {
        const includePosition = sharesWith(sharing.position.groups, info.id);
        const includeNavigation = sharesWith(
          sharing.navigation.groups,
          info.id,
        );
        if (includePosition || includeNavigation) {
          const snapshot = publisher?.buildSnapshot(timestamp, {
            includePosition,
            includeNavigation,
          });
          if (snapshot) {
            manager.enqueueData(
              info.id,
              encodeEnvelope("snapshot", encodeSnapshot(snapshot)),
            );
          }
        }
      }
      if (valuesDue) {
        const values = publisher?.buildValues(valuesFilter(info.id));
        if (values) {
          manager.enqueueData(
            info.id,
            encodeEnvelope("values", encodeValues(values)),
          );
        }
      }
      if (staticDue && sharesWith(sharing.identity.groups, info.id)) {
        const staticInfo = publisher?.buildStatic();
        if (staticInfo) {
          manager.enqueueData(
            info.id,
            encodeEnvelope("static", encodeStatic(staticInfo)),
          );
        }
      }
    }

    if (snapshotDue) lastGroupSnapshotAt = now;
    if (valuesDue) lastGroupValuesAt = now;
    if (staticDue) lastGroupStaticAt = now;
  }

  function canPublishAis(): boolean {
    return config.ais.mode === "both" || config.ais.mode === "publish";
  }

  function canIngestAis(): boolean {
    return config.ais.mode === "both" || config.ais.mode === "subscribe";
  }

  function publishAis(now: number): void {
    if (!aisStore || !publisher || !canPublishAis()) return;
    const rate = Math.max(config.ais.rateHz ?? 0.02, 0.001);
    if (now - lastAisAt < 1000 / rate) return;

    const targets = aisStore.nearest(
      publisher.currentPosition,
      Math.max(0, Math.round(config.ais.maxTargets ?? 100)),
      Math.floor(now / 1000),
      AIS_MAX_AGE_SECONDS,
    );
    const records = buildAisRecords(targets, sentAisStatic);
    if (records.length > 0) {
      if (config.ais.public && client) {
        for (const record of records) client.enqueue(record);
      }
      for (const info of groups?.list() ?? []) {
        if (
          info.removed ||
          !groups?.canPublish(info.id) ||
          !sharesWith(config.ais.groups, info.id)
        ) {
          continue;
        }
        for (const record of records) groups.enqueueData(info.id, record);
      }
    }
    lastAisAt = now;

    if (now - lastAisPruneAt >= AIS_PRUNE_INTERVAL_MS) {
      aisStore.prune(Math.floor(now / 1000), AIS_MAX_AGE_SECONDS);
      lastAisPruneAt = now;
    }
  }

  function publishTick(): void {
    if (!publisher) return;
    const network = publicNetwork();
    const now = Date.now();
    const nowSeconds = Math.floor(now / 1000);
    const sharing = config.sharing;
    const rate = publisher.underway
      ? (network?.rateHzUnderway ?? 0.05)
      : (network?.rateHzMoored ?? 0.01);
    const interval = 1000 / Math.max(rate, 0.001);

    if (client) {
      const elected = config.election.enabled
        ? directory?.elected({
            now: nowSeconds,
            epochSeconds: Math.max(1, config.election.epochMinutes) * 60,
            minUptimeSeconds:
              Math.max(0, config.election.minUptimeMinutes) * 60,
          })
        : undefined;
      const ownKey = identity?.publicKeyRaw.toString("hex");
      client.setAggregator(
        Boolean(elected && ownKey && elected.key === ownKey),
      );
      client.setPreferredPeer(elected?.key);
    }

    const consent = network?.consent ?? "opt-out";
    const valuesChanged = publisher.consumeValuesChanged();
    if (client && consent !== "receive-only") {
      if (now - lastSnapshotAt >= interval) {
        const includePosition = sharing.position.public;
        const includeNavigation = sharing.navigation.public;
        if (includePosition || includeNavigation) {
          const snapshot = publisher.buildSnapshot(nowSeconds, {
            includePosition,
            includeNavigation,
            coarseMeters:
              consent === "coarse-position"
                ? COARSE_POSITION_METERS
                : undefined,
            underwayGate: consent === "underway-gated",
          });
          if (snapshot) {
            client.enqueue(
              encodeEnvelope("snapshot", encodeSnapshot(snapshot)),
            );
            lastSnapshotAt = now;
          }
        }
      }
      if (valuesChanged || now - lastValuesAt >= VALUES_INTERVAL_MS) {
        if (consent !== "underway-gated" || publisher.underway) {
          const values = publisher.buildValues(valuesFilter());
          if (values) {
            client.enqueue(encodeEnvelope("values", encodeValues(values)));
          }
        }
        lastValuesAt = now;
      }
      if (sharing.identity.public && now - lastStaticAt >= STATIC_INTERVAL_MS) {
        publishStatic();
      }
    }

    publishGroups(now, interval, valuesChanged);

    if (now - lastClaimAt >= STATIC_INTERVAL_MS) publishClaim();
    if (now - lastCapabilityAt >= CAPABILITY_INTERVAL_MS) publishCapability();

    publishAis(now);
  }

  const claimControl = createClaimControl({
    identity: () => identity,
    registry: () => registry,
    attestors: () => config.security.publicAttestors,
    broadcast: (record) => {
      client?.enqueue(encodeEnvelope("claim", encodeClaim(record)));
    },
  });

  const groupControl = createGroupControl(() => groups);

  function sharingInfo(): SharingInfo {
    const network = config.networks.find((entry) => entry.kind === "public");
    return {
      network: network
        ? {
            id: network.id,
            enabled: network.enabled,
            consent: network.consent,
          }
        : undefined,
      dataSets: DATA_SETS.map((set) => ({
        id: set.id,
        title: set.title,
        description: set.description,
        public: config.sharing[set.id].public,
      })),
    };
  }

  async function setPublicSharing(
    dataSet: string,
    publicValue: boolean,
  ): Promise<{ ok: boolean; error?: string }> {
    const set = DATA_SETS.find((entry) => entry.id === dataSet);
    if (!set) return { ok: false, error: "unknown data set" };
    const audience = config.sharing[set.id];
    const previous = audience.public;
    audience.public = publicValue;
    return new Promise((resolve) => {
      app.savePluginOptions(config, (err) => {
        if (err) {
          audience.public = previous;
          resolve({ ok: false, error: `save failed: ${err.message}` });
        } else {
          resolve({ ok: true });
        }
      });
    });
  }

  const control: P2PControl = {
    status,
    sharing: sharingInfo,
    setPublicSharing,
    ...claimControl,
    ...groupControl,
  };

  function handleMessage(message: LiveMessage): void {
    if (!config.inject.enabled) return;
    if (message.selfId === selfId) return;

    for (const record of message.records) {
      let envelope;
      try {
        envelope = decodeEnvelope(record);
      } catch (decodeError) {
        app.debug(`P2P dropped malformed envelope: ${String(decodeError)}`);
        continue;
      }

      if (envelope.type === "capability") {
        try {
          const capability = decodeCapability(envelope.payload);
          if (
            capability.selfId === message.selfId &&
            capability.topic.equals(networkTopic(ALL_VESSELS_TOPIC))
          ) {
            directory?.update(
              capability,
              message.sourceKey,
              Math.floor(Date.now() / 1000),
            );
          }
        } catch (capabilityError) {
          app.debug(
            `P2P dropped malformed capability: ${String(capabilityError)}`,
          );
        }
        continue;
      }

      if (envelope.type === "claim") {
        try {
          const claim = decodeClaim(envelope.payload);
          if (claim.kind === "claim") {
            if (
              claim.selfId === message.selfId &&
              claim.subjectKey.equals(message.sourceKey) &&
              claim.issuerKey.equals(message.sourceKey)
            ) {
              registry?.applyClaim(claim);
            }
          } else if (claim.kind === "attest") {
            registry?.applyAttestation(claim);
          } else {
            registry?.applyRevocation(claim);
          }
        } catch (claimError) {
          app.debug(`P2P dropped malformed claim: ${String(claimError)}`);
        }
        continue;
      }

      const authorization = registry?.authorize(
        message.selfId,
        message.sourceKey,
      );
      if (!authorization?.ok) {
        app.debug(
          `P2P rejected ${message.selfId}: ` +
            `${authorization?.reason ?? "no claim registry"}`,
        );
        continue;
      }

      try {
        injectEnvelope(envelope, message, PUBLIC_NETWORK_ID);
      } catch (recordError) {
        app.debug(`P2P dropped bad record: ${String(recordError)}`);
      }
    }
  }

  function injectEnvelope(
    envelope: Envelope,
    message: LiveMessage,
    network: string,
  ): void {
    const context = `vessels.${message.selfId}`;
    const seenKey = `${network}|${context}`;

    switch (envelope.type) {
      case "snapshot": {
        const snapshot = decodeSnapshot(envelope.payload);
        const previous = selfSeen.get(seenKey) ?? 0;
        if (snapshot.timestamp <= previous) break;
        const delta = snapshotToDelta(message.selfId, snapshot, { network });
        if (delta) {
          selfSeen.set(seenKey, snapshot.timestamp);
          selfContexts.set(seenKey, Math.floor(Date.now() / 1000));
          app.handleMessage(PLUGIN_ID, delta);
          injected += 1;
        }
        break;
      }
      case "static": {
        const info = decodeStatic(envelope.payload);
        const delta = staticToDelta(message.selfId, info, { network });
        if (delta) {
          selfContexts.set(seenKey, Math.floor(Date.now() / 1000));
          app.handleMessage(PLUGIN_ID, delta);
          injected += 1;
        }
        break;
      }
      case "values": {
        const values = decodeValues(envelope.payload);
        const delta = valuesToDelta(message.selfId, values, { network });
        if (delta) {
          selfContexts.set(seenKey, Math.floor(Date.now() / 1000));
          app.handleMessage(PLUGIN_ID, delta);
          injected += 1;
        }
        break;
      }
      case "ais-snapshot": {
        if (!canIngestAis()) break;
        const snapshot = decodeAisSnapshot(envelope.payload);
        if (snapshot.mmsi === selfMmsi) break;
        const context = `vessels.urn:mrn:imo:mmsi:${snapshot.mmsi}`;
        const aisKey = `${network}|${context}`;
        const selfAt = selfContexts.get(aisKey);
        if (
          selfAt !== undefined &&
          Math.floor(Date.now() / 1000) - selfAt <=
            AIS_PRECEDENCE_WINDOW_SECONDS
        ) {
          break;
        }
        const previous = observationSeen.get(aisKey) ?? 0;
        if (snapshot.timestamp <= previous) break;
        const delta = aisSnapshotToDelta(snapshot, { network });
        if (delta) {
          observationSeen.set(aisKey, snapshot.timestamp);
          app.handleMessage(PLUGIN_ID, delta);
          injected += 1;
        }
        break;
      }
      case "ais-static": {
        if (!canIngestAis()) break;
        const info = decodeAisStatic(envelope.payload);
        if (info.mmsi === selfMmsi) break;
        const context = `vessels.urn:mrn:imo:mmsi:${info.mmsi}`;
        const aisKey = `${network}|${context}`;
        const selfAt = selfContexts.get(aisKey);
        if (
          selfAt !== undefined &&
          Math.floor(Date.now() / 1000) - selfAt <=
            AIS_PRECEDENCE_WINDOW_SECONDS
        ) {
          break;
        }
        const delta = aisStaticToDelta(info, { network });
        if (delta) {
          app.handleMessage(PLUGIN_ID, delta);
          injected += 1;
        }
        break;
      }
      default:
        break;
    }
  }

  function injectRecords(message: LiveMessage, network: string): void {
    for (const record of message.records) {
      let envelope: Envelope;
      try {
        envelope = decodeEnvelope(record);
      } catch (decodeError) {
        app.debug(`P2P dropped malformed envelope: ${String(decodeError)}`);
        continue;
      }
      try {
        injectEnvelope(envelope, message, network);
      } catch (recordError) {
        app.debug(`P2P dropped bad record: ${String(recordError)}`);
      }
    }
  }

  function handleGroupMessage(groupId: string, message: LiveMessage): void {
    if (!config.inject.enabled) return;
    if (groups?.authorize(groupId, message.selfId, message.sourceKey)) {
      injectRecords(message, groupId);
    }
  }

  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description:
      "Private and public peer-to-peer mesh networks for sharing vessel data.",

    schema() {
      return schema();
    },

    async start(startConfig?: Partial<Config>) {
      config = resolveConfig(startConfig);
      selfId = app.selfId;
      selfMmsi = selfMmsiFromId(selfId);

      try {
        identity = await loadOrCreateIdentity(app.getDataDirPath());
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        app.setPluginError(`P2P failed to start: ${error}`);
        throw cause;
      }

      registry = new ClaimRegistry({
        path: join(app.getDataDirPath(), "claims.json"),
        attestors: config.security.publicAttestors,
        requireAttestation: config.security.requireAttestation,
        attestationThreshold: config.security.attestationThreshold,
        log: {
          error: (message) => app.error(message),
          debug: (message) => app.debug(message),
        },
      });
      await registry.load();

      groups = new GroupManager({
        dataDir: app.getDataDirPath(),
        identity,
        selfId,
        log: {
          info: (message) => app.debug(message),
          error: (message) => app.error(message),
          debug: (message) => app.debug(message),
        },
        onData: (groupId, message) => handleGroupMessage(groupId, message),
      });
      await groups.load();
      try {
        await groups.start();
      } catch (cause) {
        app.setPluginError(`P2P groups failed: ${String(cause)}`);
      }

      running = true;
      error = undefined;

      publisher = new SelfPublisher(selfId);
      loadInitialState();
      aisStore = new AisTargetStore(selfMmsi);

      const network = publicNetwork();
      if (!network) {
        app.setPluginStatus("P2P: no public network enabled");
        return;
      }

      startedAt = Math.floor(Date.now() / 1000);
      const topic = networkTopic(ALL_VESSELS_TOPIC);
      directory = new PeerDirectory(topic);

      client = new LiveClient({
        identity,
        selfId,
        topic,
        batchIntervalMs: BATCH_INTERVAL_MS,
        log: {
          info: (message) => app.debug(message),
          error: (message) => app.error(message),
          debug: (message) => app.debug(message),
        },
      });
      client.onMessage(handleMessage);

      try {
        await client.start();
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        app.setPluginError(`P2P network failed: ${error}`);
      }

      subscribeSelf();
      subscribeAis();
      tickTimer = setInterval(publishTick, TICK_INTERVAL_MS);
      tickTimer.unref?.();

      app.setPluginStatus(
        `P2P identity ${identity.fingerprint.slice(0, 12)} on ` +
          `${ALL_VESSELS_TOPIC} (protocol v${PROTOCOL_VERSION})`,
      );
    },

    stop() {
      running = false;
      if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = undefined;
      }
      for (const unsubscribe of unsubscribes) {
        try {
          unsubscribe();
        } catch {
          // ignore
        }
      }
      unsubscribes = [];
      void client?.stop();
      client = undefined;
      publisher = undefined;
      void registry?.flush();
      registry = undefined;
      void groups?.stop();
      groups = undefined;
      directory = undefined;
      aisStore?.clear();
      aisStore = undefined;
      sentAisStatic.clear();
      selfSeen.clear();
      observationSeen.clear();
      selfContexts.clear();
      identity = undefined;
    },

    registerWithRouter(router: PluginRouter) {
      registerRoutes(router, control);
    },
  };
}

function selfMmsiFromId(selfId: string): number | undefined {
  const match = /^urn:mrn:imo:mmsi:(\d+)$/.exec(selfId);
  return match ? Number(match[1]) : undefined;
}
