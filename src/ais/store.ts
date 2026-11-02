import type { Delta } from "@signalk/server-api";
import type { AisClass } from "../data/ais.js";
import { NAV_STATES, type NavState } from "../data/types.js";

export interface AisTarget {
  mmsi: number;
  name?: string;
  callsign?: string;
  shipType?: number;
  latitude?: number;
  longitude?: number;
  courseOverGround?: number;
  speedOverGround?: number;
  heading?: number;
  navState?: NavState;
  aisClass?: AisClass;
  /** Unix seconds when this target was last heard locally. */
  lastSeen: number;
}

const MMSI_CONTEXT = /^vessels\.urn:mrn:imo:mmsi:(\d+)$/;

/**
 * Collects AIS targets heard by this vessel's own receiver. It deliberately
 * reads only local sources: P2P-injected data is excluded by the subscription
 * and filtered again here, so a received observation is never re-published.
 */
export class AisTargetStore {
  private readonly targets = new Map<number, AisTarget>();

  constructor(private readonly selfMmsi?: number) {}

  applyDelta(delta: Delta, now: number): void {
    const match = MMSI_CONTEXT.exec(delta.context ?? "");
    if (!match) return;
    const mmsi = Number(match[1]);
    if (mmsi === this.selfMmsi) return;

    for (const update of delta.updates) {
      if (!("values" in update)) continue;
      if (update.source?.label === "signalk-p2p") continue;

      let target = this.targets.get(mmsi);
      if (!target) {
        target = { mmsi, lastSeen: now };
        this.targets.set(mmsi, target);
      }
      target.lastSeen = now;
      for (const { path, value } of update.values) {
        this.applyPath(target, path as string, value);
      }
    }
  }

  private applyPath(target: AisTarget, path: string, value: unknown): void {
    switch (path) {
      case "navigation.position": {
        if (value === null || typeof value !== "object") return;
        const position = value as Record<string, unknown>;
        const latitude = Number(position.latitude);
        const longitude = Number(position.longitude);
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          target.latitude = latitude;
          target.longitude = longitude;
        }
        return;
      }
      case "navigation.courseOverGroundTrue": {
        if (isNumber(value)) target.courseOverGround = value;
        return;
      }
      case "navigation.speedOverGround": {
        if (isNumber(value)) target.speedOverGround = value;
        return;
      }
      case "navigation.headingTrue": {
        if (isNumber(value)) target.heading = value;
        return;
      }
      case "navigation.state": {
        if (
          typeof value === "string" &&
          (NAV_STATES as readonly string[]).includes(value)
        ) {
          target.navState = value as NavState;
        }
        return;
      }
      case "name": {
        if (typeof value === "string") target.name = value;
        return;
      }
      case "callsign": {
        if (typeof value === "string") target.callsign = value;
        return;
      }
      case "design.aisShipType": {
        const id =
          value !== null && typeof value === "object"
            ? Number((value as Record<string, unknown>).id)
            : Number(value);
        if (Number.isFinite(id)) target.shipType = id;
        return;
      }
      case "sensors.ais.class": {
        if (value === "A" || value === "B" || value === "ATON") {
          target.aisClass = value;
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * Targets that can be shared: heard locally, with a position, an AIS class,
   * and recently seen. The nearest to `position` come first.
   */
  nearest(
    position: { latitude: number; longitude: number } | undefined,
    maxTargets: number,
    now: number,
    maxAgeSeconds = 900,
  ): AisTarget[] {
    const eligible = [...this.targets.values()].filter(
      (target) =>
        target.aisClass !== undefined &&
        target.latitude !== undefined &&
        target.longitude !== undefined &&
        now - target.lastSeen <= maxAgeSeconds,
    );

    if (position) {
      const scored = eligible.map((target) => ({
        target,
        distance: squaredDistance(
          position,
          target as { latitude: number; longitude: number },
        ),
      }));
      scored.sort((a, b) => a.distance - b.distance);
      return scored.slice(0, maxTargets).map((entry) => entry.target);
    }

    eligible.sort((a, b) => b.lastSeen - a.lastSeen);
    return eligible.slice(0, maxTargets);
  }

  prune(now: number, maxAgeSeconds = 900): void {
    for (const [mmsi, target] of this.targets) {
      if (now - target.lastSeen > maxAgeSeconds) {
        this.targets.delete(mmsi);
      }
    }
  }

  clear(): void {
    this.targets.clear();
  }
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function squaredDistance(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const latitude = a.latitude - b.latitude;
  const longitude =
    (a.longitude - b.longitude) * Math.cos((a.latitude * Math.PI) / 180);
  return latitude * latitude + longitude * longitude;
}
