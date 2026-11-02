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

export interface Config {
  identity: { keyFile: string };
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
      public: true,
      groups: [],
      mode: "both",
      maxTargets: 100,
      rateHz: 0.02,
    },
    networks: [
      {
        id: "all-vessels",
        kind: "public",
        enabled: true,
        consent: "opt-out",
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
  const audience = (
    title: string,
    description: string,
    publicDefault: boolean,
    groupsDefault: "all" | "none",
  ) => ({
    type: "object",
    title,
    description,
    properties: {
      public: {
        type: "boolean",
        title: "Share publicly",
        description: "Publish this data set on the global all-vessels network.",
        default: publicDefault,
      },
      groups: {
        title: "Share with groups",
        description:
          "Publish this data set to every group, or only to the selected groups.",
        oneOf: [
          { enum: ["all"], title: "All groups" },
          {
            type: "array",
            title: "Selected groups",
            items: { type: "string", title: "Group id" },
          },
        ],
        default: groupsDefault === "all" ? "all" : [],
      },
    },
    additionalProperties: false,
  });

  const sharingProperties = Object.fromEntries(
    DATA_SETS.map((dataSet) => [
      dataSet.id,
      audience(
        dataSet.title,
        dataSet.description,
        dataSet.publicDefault,
        dataSet.groupsDefault,
      ),
    ]),
  );

  return {
    type: "object",
    title: "Signal K P2P",
    properties: {
      identity: {
        type: "object",
        title: "Identity",
        properties: {
          keyFile: {
            type: "string",
            title: "Identity key file",
            description:
              "Where the instance Ed25519 key is stored. 'auto' keeps it in the plugin data directory.",
            default: "auto",
          },
        },
      },
      sharding: {
        type: "object",
        title: "Public network sharding",
        properties: {
          maxVesselsPerShard: {
            type: "number",
            title: "Maximum vessels per shard",
            default: 500,
            minimum: 100,
          },
          maxVesselsPerInstance: {
            type: "number",
            title: "Maximum vessels injected per instance",
            default: 1000,
            minimum: 100,
          },
          lookAheadKm: {
            type: "number",
            title: "Look-ahead radius (km)",
            default: 50,
            minimum: 0,
          },
          splitSettleMinutes: {
            type: "number",
            title: "Split settle time (minutes)",
            default: 10,
            minimum: 1,
          },
          mergeSettleMinutes: {
            type: "number",
            title: "Merge settle time (minutes)",
            default: 60,
            minimum: 1,
          },
          mergeBelowRatio: {
            type: "number",
            title: "Merge below this fraction of the maximum",
            default: 0.25,
            minimum: 0,
            maximum: 1,
          },
          boundaryHysteresisMeters: {
            type: "number",
            title: "Shard boundary hysteresis (m)",
            default: 1000,
            minimum: 0,
          },
        },
      },
      bootstrapPeers: {
        type: "array",
        title: "Bootstrap peers",
        description:
          "Optional always-on peers used to reach the mesh or bridge CGNAT. " +
          "They are ordinary peers, not required relays; leave empty for an " +
          "open, peer-elected mesh.",
        items: { type: "string" },
        default: [],
      },
      election: {
        type: "object",
        title: "Peer election",
        properties: {
          enabled: {
            type: "boolean",
            title: "Elect a relay/aggregator per shard",
            default: true,
          },
          epochMinutes: {
            type: "number",
            title: "Election epoch (minutes)",
            default: 10,
            minimum: 1,
          },
          minUptimeMinutes: {
            type: "number",
            title: "Minimum uptime to be eligible (minutes)",
            default: 10,
            minimum: 0,
          },
          relayConsent: {
            type: "boolean",
            title: "Offer to relay/aggregate for this shard",
            default: false,
          },
          reachable: {
            type: "boolean",
            title: "Advertise as publicly reachable",
            default: false,
          },
          unmetered: {
            type: "boolean",
            title: "Advertise an unmetered link",
            default: false,
          },
          capacity: {
            type: "number",
            title: "Relative relay capacity",
            default: 1,
            minimum: 1,
            maximum: 16,
          },
        },
      },
      security: {
        type: "object",
        title: "Security",
        properties: {
          publicAttestors: {
            type: "array",
            title: "Public attestors",
            description:
              "Keys allowed to attest public MMSI claims. Empty means TOFU only.",
            items: { type: "string" },
            default: [],
          },
          requireAttestation: {
            type: "boolean",
            title: "Require attestation for public members",
            default: false,
          },
          attestationThreshold: {
            type: "number",
            title: "Attestations required",
            default: 1,
            minimum: 1,
          },
        },
      },
      sharing: {
        type: "object",
        title: "Shared data",
        description:
          "Choose who receives each data set. Public means the all-vessels network.",
        properties: sharingProperties,
      },
      ais: {
        type: "object",
        title: "AIS vessels",
        properties: {
          public: { type: "boolean", title: "Share publicly", default: true },
          groups: {
            title: "Share with groups",
            oneOf: [
              { enum: ["all"], title: "All groups" },
              {
                type: "array",
                title: "Selected groups",
                items: { type: "string" },
              },
            ],
            default: [],
          },
          mode: {
            type: "string",
            title: "AIS direction",
            enum: ["both", "publish", "subscribe", "off"],
            enumNames: [
              "Send and receive",
              "Send our AIS vessels",
              "Receive AIS vessels only",
              "No AIS over P2P",
            ],
            default: "both",
          },
          maxTargets: {
            type: "number",
            title: "Maximum AIS targets per snapshot",
            default: 100,
            minimum: 0,
          },
          rateHz: {
            type: "number",
            title: "AIS snapshot rate (Hz)",
            default: 0.02,
            minimum: 0,
          },
        },
      },
      networks: {
        type: "array",
        title: "Networks",
        items: {
          type: "object",
          properties: {
            id: { type: "string", title: "Id" },
            kind: {
              type: "string",
              title: "Kind",
              enum: ["public", "group"],
            },
            name: { type: "string", title: "Name" },
            enabled: { type: "boolean", title: "Enabled", default: true },
            consent: {
              type: "string",
              title: "Consent",
              enum: [
                "opt-out",
                "underway-gated",
                "receive-only",
                "coarse-position",
              ],
              enumNames: [
                "Publish everything",
                "Publish only while underway",
                "Receive only",
                "Publish a coarse position",
              ],
              default: "opt-out",
            },
            rateHzUnderway: {
              type: "number",
              title: "Snapshot rate underway (Hz)",
              default: 0.05,
              minimum: 0,
            },
            rateHzMoored: {
              type: "number",
              title: "Snapshot rate moored (Hz)",
              default: 0.01,
              minimum: 0,
            },
            invite: { type: "string", title: "Group invite" },
          },
        },
      },
      inject: {
        type: "object",
        title: "Injection",
        properties: {
          enabled: {
            type: "boolean",
            title: "Inject received vessels into the Signal K tree",
            default: true,
          },
          history: {
            type: "boolean",
            title: "Allow injected vessels in history",
            default: false,
          },
          maxAgeSeconds: {
            type: "number",
            title: "Maximum age (seconds)",
            default: 900,
            minimum: 60,
          },
        },
      },
    },
  };
}
