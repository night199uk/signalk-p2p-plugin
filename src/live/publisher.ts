import type { Delta } from "@signalk/server-api";
import {
  GNSS_QUALITIES,
  NAV_STATES,
  type Attitude,
  type GnssQuality,
  type NavState,
  type Snapshot,
  type StaticInfo,
  type Values,
} from "../data/types.js";

export interface Position {
  latitude: number;
  longitude: number;
}

export interface SnapshotOptions {
  includePosition: boolean;
  includeNavigation: boolean;
  /** Round the position to this grid, in metres. */
  coarseMeters?: number;
  /** Return nothing unless the vessel is underway. */
  underwayGate?: boolean;
}

/**
 * Keeps the latest self-vessel state and turns it into compact records.
 * It is deliberately independent of Signal K so it is easy to test.
 */
export class SelfPublisher {
  private position: Position | undefined;
  private cog: number | undefined;
  private sog: number | undefined;
  private heading: number | undefined;
  private navState: NavState | undefined;
  private gnss: GnssQuality | undefined;
  private cogMagnetic: number | undefined;
  private headingMagnetic: number | undefined;
  private magneticVariation: number | undefined;
  private speedThroughWater: number | undefined;
  private attitude: Attitude | undefined;
  private rateOfTurn: number | undefined;
  private hdop: number | undefined;
  private vdop: number | undefined;
  private satellites: number | undefined;
  private mmsi: number | undefined;
  private readonly values = new Map<string, unknown>();
  private valuesDirty = false;
  private readonly staticInfo: Partial<StaticInfo> = {};

  constructor(private readonly selfId: string) {}

  applyDelta(delta: Delta): void {
    for (const update of delta.updates) {
      if (!("values" in update)) continue;
      for (const { path, value } of update.values) {
        this.update(path as string, value);
      }
    }
  }

  update(path: string, value: unknown): void {
    switch (path) {
      case "navigation.position": {
        const position = asPosition(value);
        if (position) this.position = position;
        return;
      }
      case "navigation.courseOverGroundTrue": {
        if (isNumber(value)) this.cog = value;
        return;
      }
      case "navigation.speedOverGround": {
        if (isNumber(value)) this.sog = value;
        return;
      }
      case "navigation.headingTrue": {
        if (isNumber(value)) this.heading = value;
        return;
      }
      case "navigation.state": {
        if (isString(value) && isNavState(value)) this.navState = value;
        return;
      }
      case "navigation.gnss.methodQuality": {
        if (isString(value) && isGnssQuality(value)) this.gnss = value;
        return;
      }
      case "navigation.courseOverGroundMagnetic": {
        if (isNumber(value)) this.cogMagnetic = value;
        return;
      }
      case "navigation.headingMagnetic": {
        if (isNumber(value)) this.headingMagnetic = value;
        return;
      }
      case "navigation.magneticVariation": {
        if (isNumber(value)) this.magneticVariation = value;
        return;
      }
      case "navigation.speedThroughWater": {
        if (isNumber(value)) this.speedThroughWater = value;
        return;
      }
      case "navigation.attitude": {
        const attitude = asAttitude(value);
        if (attitude) this.attitude = attitude;
        return;
      }
      case "navigation.rateOfTurn": {
        if (isNumber(value)) this.rateOfTurn = value;
        return;
      }
      case "navigation.gnss.horizontalDilution": {
        if (isNumber(value)) this.hdop = value;
        return;
      }
      case "navigation.gnss.verticalDilution": {
        if (isNumber(value)) this.vdop = value;
        return;
      }
      case "navigation.gnss.satellites": {
        if (isNumber(value)) this.satellites = value;
        return;
      }
      default:
        if (isValuePath(path)) {
          this.values.set(path, value);
          this.valuesDirty = true;
          return;
        }
        this.updateStatic(path, value);
    }
  }

  private updateStatic(path: string, value: unknown): void {
    switch (path) {
      case "name":
        if (isString(value)) this.staticInfo.name = value;
        return;
      case "callsign":
        if (isString(value)) this.staticInfo.callsign = value;
        return;
      case "mmsi": {
        const mmsi = asNumber(value);
        if (mmsi !== undefined) {
          this.staticInfo.mmsi = mmsi;
          this.mmsi = mmsi;
        }
        return;
      }
      case "imo": {
        const imo = asNumber(value);
        if (imo !== undefined) this.staticInfo.imo = imo;
        return;
      }
      case "design.aisShipType": {
        const id = objectNumber(value, "id") ?? asNumber(value);
        if (id !== undefined) this.staticInfo.shipType = id;
        return;
      }
      case "design.length": {
        const overall = objectNumber(value, "overall") ?? asNumber(value);
        if (overall !== undefined) this.staticInfo.lengthOverall = overall;
        return;
      }
      case "design.beam": {
        const beam = asNumber(value);
        if (beam !== undefined) this.staticInfo.beam = beam;
        return;
      }
      case "design.draft": {
        const draft = objectNumber(value, "maximum") ?? asNumber(value);
        if (draft !== undefined) this.staticInfo.draft = draft;
        return;
      }
      case "sensors.ais.fromBow": {
        const fromBow = asNumber(value);
        if (fromBow !== undefined) this.staticInfo.fromBow = fromBow;
        return;
      }
      case "sensors.ais.fromCenter": {
        const fromCenter = asNumber(value);
        if (fromCenter !== undefined) this.staticInfo.fromCenter = fromCenter;
        return;
      }
      default:
        return;
    }
  }

  get underway(): boolean {
    return this.sog !== undefined && this.sog > 0.5;
  }

  get currentPosition(): Position | undefined {
    return this.position;
  }

  get hasPosition(): boolean {
    return this.position !== undefined;
  }

  buildSnapshot(timestamp: number, options: SnapshotOptions): Snapshot | null {
    if (options.underwayGate && !this.underway) {
      return null;
    }

    const snapshot: Snapshot = { timestamp };
    let hasData = false;

    if (options.includePosition && this.position) {
      const position = options.coarseMeters
        ? coarsenPosition(this.position, options.coarseMeters)
        : this.position;
      snapshot.latitude = position.latitude;
      snapshot.longitude = position.longitude;
      if (options.coarseMeters) snapshot.coarse = true;
      hasData = true;
    }

    if (options.includeNavigation) {
      if (this.cog !== undefined) {
        snapshot.courseOverGround = this.cog;
        hasData = true;
      }
      if (this.sog !== undefined) {
        snapshot.speedOverGround = this.sog;
        hasData = true;
      }
      if (this.heading !== undefined) {
        snapshot.heading = this.heading;
        hasData = true;
      }
      if (this.navState !== undefined) {
        snapshot.navState = this.navState;
        hasData = true;
      }
      if (this.gnss !== undefined) {
        snapshot.gnssQuality = this.gnss;
        hasData = true;
      }
      if (this.cogMagnetic !== undefined) {
        snapshot.courseOverGroundMagnetic = this.cogMagnetic;
        hasData = true;
      }
      if (this.headingMagnetic !== undefined) {
        snapshot.headingMagnetic = this.headingMagnetic;
        hasData = true;
      }
      if (this.magneticVariation !== undefined) {
        snapshot.magneticVariation = this.magneticVariation;
        hasData = true;
      }
      if (this.speedThroughWater !== undefined) {
        snapshot.speedThroughWater = this.speedThroughWater;
        hasData = true;
      }
      if (this.attitude !== undefined) {
        snapshot.attitude = this.attitude;
        hasData = true;
      }
      if (this.rateOfTurn !== undefined) {
        snapshot.rateOfTurn = this.rateOfTurn;
        hasData = true;
      }
      if (this.hdop !== undefined) {
        snapshot.gnssHorizontalDilution = this.hdop;
        hasData = true;
      }
      if (this.vdop !== undefined) {
        snapshot.gnssVerticalDilution = this.vdop;
        hasData = true;
      }
      if (this.satellites !== undefined) {
        snapshot.gnssSatellites = this.satellites;
        hasData = true;
      }
    }

    if (this.mmsi !== undefined) {
      snapshot.mmsi = this.mmsi;
    }
    if (this.underway) {
      snapshot.underway = true;
    }

    return hasData ? snapshot : null;
  }

  buildStatic(): StaticInfo | null {
    const info: StaticInfo = {
      ...this.staticInfo,
      selfId: this.selfId,
    };
    if (this.mmsi !== undefined) info.mmsi = this.mmsi;
    if (Object.keys(info).length <= 1) {
      return null;
    }
    return info;
  }

  get valuesChanged(): boolean {
    return this.valuesDirty;
  }

  /** Clear the change flag after a values record has been emitted. */
  consumeValuesChanged(): boolean {
    const changed = this.valuesDirty;
    this.valuesDirty = false;
    return changed;
  }

  buildValues(filter?: (path: string) => boolean): Values | null {
    const entries = [...this.values].filter(([path]) =>
      filter ? filter(path) : true,
    );
    return entries.length > 0 ? Object.fromEntries(entries) : null;
  }
}

function isValuePath(path: string): boolean {
  if (path === "sensors.ais.class") return true;
  if (path.startsWith("sensors.")) {
    return !path.startsWith("sensors.ais.");
  }
  return (
    path.startsWith("environment.") ||
    path.startsWith("tanks.") ||
    path.startsWith("propulsion.") ||
    path.startsWith("engine.") ||
    path.startsWith("steering.") ||
    path.startsWith("navigation.destination.") ||
    path.startsWith("navigation.anchor.") ||
    path.startsWith("navigation.lights.")
  );
}

function asAttitude(value: unknown): Attitude | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const attitude = value as Record<string, unknown>;
  const roll = asNumber(attitude.roll);
  const pitch = asNumber(attitude.pitch);
  const yaw = asNumber(attitude.yaw);
  if (roll === undefined || pitch === undefined || yaw === undefined) {
    return undefined;
  }
  return { roll, pitch, yaw };
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNavState(value: string): value is NavState {
  return (NAV_STATES as readonly string[]).includes(value);
}

function isGnssQuality(value: string): value is GnssQuality {
  return (GNSS_QUALITIES as readonly string[]).includes(value);
}

function asNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function objectNumber(value: unknown, key: string): number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  return asNumber((value as Record<string, unknown>)[key]);
}

function asPosition(value: unknown): Position | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const position = value as Record<string, unknown>;
  const latitude = asNumber(position.latitude);
  const longitude = asNumber(position.longitude);
  if (latitude === undefined || longitude === undefined) return undefined;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined;
  return { latitude, longitude };
}

function coarsenPosition(position: Position, metres: number): Position {
  const latitudeStep = metres / 111_320;
  const longitudeStep =
    latitudeStep / Math.max(Math.cos((position.latitude * Math.PI) / 180), 0.1);
  return {
    latitude: round(position.latitude, latitudeStep),
    longitude: Math.max(
      -180,
      Math.min(180, round(position.longitude, longitudeStep)),
    ),
  };
}

function round(value: number, step: number): number {
  return Math.round(value / step) * step;
}
