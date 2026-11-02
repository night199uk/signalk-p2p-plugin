/**
 * Values are Signal K native: radians for angles, m/s for speeds, metres for
 * lengths. The wire formats convert to compact fixed-point units.
 */

/** Signal K `navigation.state` values, in wire-index order. */
export const NAV_STATES = [
  "not under command",
  "restricted maneuverability",
  "constrained by draft",
  "moored",
  "anchored",
  "aground",
  "fishing",
  "under way using engine",
  "under way sailing",
  "power-driven vessel pushing ahead",
  "power-driven vessel towing astern",
  "power-driven vessel pushing ahead or towing alongside",
  "AIS-SART",
  "unknown",
] as const;

export type NavState = (typeof NAV_STATES)[number];

/** Signal K `navigation.gnss.methodQuality` values, in wire-index order. */
export const GNSS_QUALITIES = [
  "no GPS",
  "GNSS Fix",
  "DGNSS fix",
  "Precise GNSS",
  "RTK fixed integer",
  "RTK float",
  "Estimated (DR) mode",
  "Manual input",
  "Simulator mode",
] as const;

export type GnssQuality = (typeof GNSS_QUALITIES)[number];

export interface Attitude {
  roll: number;
  pitch: number;
  yaw: number;
}

/** One live position/navigation sample for the sender's own vessel. */
export interface Snapshot {
  /** Unix seconds. */
  timestamp: number;
  latitude?: number;
  longitude?: number;
  /** Radians, true north. */
  courseOverGround?: number;
  /** Metres per second. */
  speedOverGround?: number;
  /** Radians, true north. */
  heading?: number;
  /** Radians, magnetic north. */
  courseOverGroundMagnetic?: number;
  /** Radians, magnetic north. */
  headingMagnetic?: number;
  /** Radians. */
  magneticVariation?: number;
  /** Metres per second. */
  speedThroughWater?: number;
  /** Radians. */
  attitude?: Attitude;
  /** Radians per second. */
  rateOfTurn?: number;
  gnssHorizontalDilution?: number;
  gnssVerticalDilution?: number;
  gnssSatellites?: number;
  navState?: NavState;
  gnssQuality?: GnssQuality;
  mmsi?: number;
  underway?: boolean;
  /** Position has been deliberately coarsened by the sender. */
  coarse?: boolean;
}

/** Identity and static details for the sender's own vessel. */
export interface StaticInfo {
  /**
   * The sender's Signal K selfId:
   * `urn:mrn:imo:mmsi:<mmsi>` or `urn:mrn:signalk:uuid:<uuid>`.
   */
  selfId: string;
  mmsi?: number;
  imo?: number;
  shipType?: number;
  name?: string;
  callsign?: string;
  /** Metres. */
  lengthOverall?: number;
  /** Metres. */
  beam?: number;
  /** Metres. */
  draft?: number;
  /** Metres from the bow to the AIS reference point. */
  fromBow?: number;
  /** Metres from the centreline (positive to starboard). */
  fromCenter?: number;
}

/** A generic map of canonical Signal K paths to native values. */
export type Values = Record<string, unknown>;

export type RecordType =
  | "snapshot"
  | "static"
  | "values"
  | "ais-snapshot"
  | "ais-static"
  | "claim"
  | "capability"
  | "group-roster"
  | "group-join"
  | "group-roster-request";
