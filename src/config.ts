import { DEFAULT_OPERATOR_PUBLIC_KEY } from "./policy/operator.js";

export const DATA_SETS = [
  {
    id: "identity",
    title: "Identity & static",
    description: "Name, MMSI, IMO, callsign, type and dimensions.",
    publicDefault: true,
    groupsDefault: "all",
  },
  {
    id: "position",
    title: "Position",
    description: "navigation.position, subject to the consent mode.",
    publicDefault: true,
    groupsDefault: "all",
  },
  {
    id: "navigation",
    title: "Navigation & safety",
    description:
      "Course, speed, heading, attitude, rate of turn, state and GNSS.",
    publicDefault: true,
    groupsDefault: "all",
  },
  {
    id: "depth",
    title: "Depth",
    description: "environment.depth.*, the live depth reading.",
    publicDefault: true,
    groupsDefault: "all",
  },
  {
    id: "temperature",
    title: "Environment: temperature",
    description: "Air, water and inside temperatures.",
    publicDefault: false,
    groupsDefault: "all",
  },
  {
    id: "wind",
    title: "Environment: wind",
    description: "True and apparent wind.",
    publicDefault: false,
    groupsDefault: "all",
  },
  {
    id: "pressureHumidity",
    title: "Environment: pressure & humidity",
    description: "Pressure, humidity, dew point, air density and illuminance.",
    publicDefault: false,
    groupsDefault: "all",
  },
  {
    id: "tanksFuel",
    title: "Tanks: fuel",
    description: "tanks.fuel.*",
    publicDefault: false,
    groupsDefault: "none",
  },
  {
    id: "tanksFreshWater",
    title: "Tanks: fresh water",
    description: "tanks.freshWater.*",
    publicDefault: false,
    groupsDefault: "none",
  },
  {
    id: "tanksHolding",
    title: "Tanks: holding",
    description: "tanks.blackWater.* and tanks.wasteWater.*",
    publicDefault: false,
    groupsDefault: "none",
  },
  {
    id: "destination",
    title: "Destination",
    description: "navigation.destination.*, which reveals intentions.",
    publicDefault: false,
    groupsDefault: "none",
  },
  {
    id: "anchor",
    title: "Anchor",
    description: "navigation.anchor.*, which reveals where you are anchored.",
    publicDefault: false,
    groupsDefault: "all",
  },
  {
    id: "propulsion",
    title: "Propulsion",
    description: "propulsion.* and legacy engine.* paths.",
    publicDefault: false,
    groupsDefault: "none",
  },
  {
    id: "systems",
    title: "Systems",
    description: "Steering, sensors and navigation lights.",
    publicDefault: false,
    groupsDefault: "none",
  },
] as const;

export type DataSetId = (typeof DATA_SETS)[number]["id"];

export interface ShareAudience {
  public: boolean;
  /** "all", or a list of group ids. */
  groups: "all" | string[];
}

export type SharingConfig = Record<DataSetId, ShareAudience>;

export type ConsentMode =
  "opt-out" | "underway-gated" | "receive-only" | "coarse-position";

export type AisMode = "both" | "publish" | "subscribe" | "off";

export type NetworkKind = "public" | "group";

export interface NetworkConfig {
  id: string;
  kind: NetworkKind;
  name?: string;
  enabled: boolean;
  consent?: ConsentMode;
  rateHzUnderway?: number;
  rateHzMoored?: number;
  /** Only while joining; the group's epoch is stored elsewhere. */
  invite?: string;
}

export interface ShardingConfig {
  maxVesselsPerShard: number;
  maxVesselsPerInstance: number;
  lookAheadKm: number;
  splitSettleMinutes: number;
  mergeSettleMinutes: number;
  mergeBelowRatio: number;
  boundaryHysteresisMeters: number;
}

export interface SecurityConfig {
  publicAttestors: string[];
  requireAttestation: boolean;
  attestationThreshold: number;
}

export interface ElectionConfig {
  enabled: boolean;
  epochMinutes: number;
  minUptimeMinutes: number;
  /** Advertise this instance as willing to relay/aggregate. */
  relayConsent: boolean;
  /** Advertise as publicly reachable. */
  reachable: boolean;
  /** Advertise as having an unmetered link. */
  unmetered: boolean;
  /** Relative capacity weight (1..16 in the election). */
  capacity: number;
}

export interface AisConfig extends ShareAudience {
  mode: AisMode;
  maxTargets: number;
  rateHz: number;
}

export interface InjectConfig {
  enabled: boolean;
  history: boolean;
  maxAgeSeconds: number;
}

export interface PolicyConfig {
  /** Ed25519 public keys allowed to sign the network policy. */
  operatorKeys: string[];
}

export interface Config {
  identity: { keyFile: string };
  policy: PolicyConfig;
  sharding: ShardingConfig;
  /** Optional always-on peers used to bootstrap or bridge CGNAT. */
  bootstrapPeers: string[];
  election: ElectionConfig;
  security: SecurityConfig;
  sharing: SharingConfig;
  ais: AisConfig;
  networks: NetworkConfig[];
  inject: InjectConfig;
}

function defaultSharing(): SharingConfig {
  const sharing = {} as SharingConfig;
  for (const dataSet of DATA_SETS) {
    sharing[dataSet.id] = {
      public: dataSet.publicDefault,
      groups: dataSet.groupsDefault === "all" ? "all" : [],
    };
  }
  return sharing;
}

export function defaultConfig(): Config {
  return {
    identity: { keyFile: "auto" },
    policy: { operatorKeys: [DEFAULT_OPERATOR_PUBLIC_KEY] },
    sharding: {
      maxVesselsPerShard: 500,
      maxVesselsPerInstance: 1000,
      lookAheadKm: 50,
      splitSettleMinutes: 10,
      mergeSettleMinutes: 60,
      mergeBelowRatio: 0.25,
      boundaryHysteresisMeters: 1000,
    },
    bootstrapPeers: [],
    election: {
      enabled: true,
      epochMinutes: 10,
      minUptimeMinutes: 10,
      relayConsent: false,
      reachable: false,
      unmetered: false,
      capacity: 1,
    },
    security: {
      publicAttestors: [],
      requireAttestation: false,
      attestationThreshold: 1,
    },
    sharing: defaultSharing(),
    ais: {
      public: false,
      groups: [],
      mode: "subscribe",
      maxTargets: 100,
      rateHz: 0.02,
    },
    networks: [
      {
        id: "all-vessels",
        kind: "public",
        enabled: true,
        consent: "receive-only",
        rateHzUnderway: 0.05,
        rateHzMoored: 0.01,
      },
    ],
    inject: {
      enabled: true,
      history: false,
      maxAgeSeconds: 900,
    },
  };
}

export function resolveConfig(partial?: Partial<Config>): Config {
  const defaults = defaultConfig();
  if (!partial) return defaults;

  const sharing = { ...defaults.sharing };
  for (const dataSet of DATA_SETS) {
    const override = partial.sharing?.[dataSet.id];
    if (override) {
      sharing[dataSet.id] = { ...sharing[dataSet.id], ...override };
    }
  }

  return {
    identity: { ...defaults.identity, ...partial.identity },
    policy: { ...defaults.policy, ...partial.policy },
    sharding: { ...defaults.sharding, ...partial.sharding },
    bootstrapPeers: partial.bootstrapPeers ?? defaults.bootstrapPeers,
    election: { ...defaults.election, ...partial.election },
    security: { ...defaults.security, ...partial.security },
    sharing,
    ais: { ...defaults.ais, ...partial.ais },
    networks: partial.networks ?? defaults.networks,
    inject: { ...defaults.inject, ...partial.inject },
  };
}

export function schema(): Record<string, unknown> {
  return {
    type: "object",
    title: "Signal K P2P",
    properties: {
      election: {
        type: "object",
        title: "Relay",
        properties: {
          relayConsent: {
            type: "boolean",
            title: "Help relay nearby vessels",
            description:
              "Offer this instance as a relay when the network elects it. " +
              "Topology and rate limits come from the signed network policy.",
            default: false,
          },
        },
      },
      inject: {
        type: "object",
        title: "Other vessels",
        properties: {
          enabled: {
            type: "boolean",
            title: "Show vessels received from the network",
            default: true,
          },
        },
      },
    },
  };
}
