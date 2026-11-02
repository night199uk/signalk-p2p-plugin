import type { Delta } from "@signalk/server-api";
import type { AisSnapshot, AisStaticInfo } from "./ais.js";
import type { Snapshot, StaticInfo, Values } from "./types.js";

export interface InjectSource {
  network: string;
}

function source(network: string) {
  return { label: "signalk-p2p", type: "p2p", network };
}

function deltaForContext(
  context: string,
  timestamp: string,
  values: Array<{ path: string; value: unknown }>,
  network: string,
): Delta | null {
  if (values.length === 0) return null;
  return {
    context,
    updates: [
      {
        timestamp,
        source: source(network),
        values,
      },
    ],
  } as unknown as Delta;
}

function delta(
  selfId: string,
  timestamp: string,
  values: Array<{ path: string; value: unknown }>,
  network: string,
): Delta | null {
  return deltaForContext(`vessels.${selfId}`, timestamp, values, network);
}

export function snapshotToDelta(
  selfId: string,
  snapshot: Snapshot,
  options: InjectSource,
): Delta | null {
  const values: Array<{ path: string; value: unknown }> = [];

  if (snapshot.latitude !== undefined && snapshot.longitude !== undefined) {
    values.push({
      path: "navigation.position",
      value: {
        latitude: snapshot.latitude,
        longitude: snapshot.longitude,
      },
    });
  }
  if (snapshot.courseOverGround !== undefined) {
    values.push({
      path: "navigation.courseOverGroundTrue",
      value: snapshot.courseOverGround,
    });
  }
  if (snapshot.speedOverGround !== undefined) {
    values.push({
      path: "navigation.speedOverGround",
      value: snapshot.speedOverGround,
    });
  }
  if (snapshot.heading !== undefined) {
    values.push({
      path: "navigation.headingTrue",
      value: snapshot.heading,
    });
  }
  if (snapshot.courseOverGroundMagnetic !== undefined) {
    values.push({
      path: "navigation.courseOverGroundMagnetic",
      value: snapshot.courseOverGroundMagnetic,
    });
  }
  if (snapshot.headingMagnetic !== undefined) {
    values.push({
      path: "navigation.headingMagnetic",
      value: snapshot.headingMagnetic,
    });
  }
  if (snapshot.magneticVariation !== undefined) {
    values.push({
      path: "navigation.magneticVariation",
      value: snapshot.magneticVariation,
    });
  }
  if (snapshot.speedThroughWater !== undefined) {
    values.push({
      path: "navigation.speedThroughWater",
      value: snapshot.speedThroughWater,
    });
  }
  if (snapshot.attitude !== undefined) {
    values.push({
      path: "navigation.attitude",
      value: snapshot.attitude,
    });
  }
  if (snapshot.rateOfTurn !== undefined) {
    values.push({
      path: "navigation.rateOfTurn",
      value: snapshot.rateOfTurn,
    });
  }
  if (snapshot.gnssHorizontalDilution !== undefined) {
    values.push({
      path: "navigation.gnss.horizontalDilution",
      value: snapshot.gnssHorizontalDilution,
    });
  }
  if (snapshot.gnssVerticalDilution !== undefined) {
    values.push({
      path: "navigation.gnss.verticalDilution",
      value: snapshot.gnssVerticalDilution,
    });
  }
  if (snapshot.gnssSatellites !== undefined) {
    values.push({
      path: "navigation.gnss.satellites",
      value: snapshot.gnssSatellites,
    });
  }
  if (snapshot.navState !== undefined) {
    values.push({ path: "navigation.state", value: snapshot.navState });
  }
  if (snapshot.gnssQuality !== undefined) {
    values.push({
      path: "navigation.gnss.methodQuality",
      value: snapshot.gnssQuality,
    });
  }
  if (snapshot.mmsi !== undefined) {
    values.push({ path: "", value: { mmsi: String(snapshot.mmsi) } });
  }

  return delta(
    selfId,
    new Date(snapshot.timestamp * 1000).toISOString(),
    values,
    options.network,
  );
}

export function staticToDelta(
  selfId: string,
  info: StaticInfo,
  options: InjectSource,
): Delta | null {
  const values: Array<{ path: string; value: unknown }> = [];
  const root: Record<string, unknown> = {};
  if (info.name) root.name = info.name;
  if (info.mmsi !== undefined) root.mmsi = String(info.mmsi);
  if (info.imo !== undefined) root.imo = String(info.imo);
  if (info.callsign) root.callsign = info.callsign;
  if (Object.keys(root).length > 0) {
    values.push({ path: "", value: root });
  }
  if (info.shipType !== undefined) {
    values.push({
      path: "design.aisShipType",
      value: { id: info.shipType },
    });
  }
  if (info.lengthOverall !== undefined) {
    values.push({
      path: "design.length",
      value: { overall: info.lengthOverall },
    });
  }
  if (info.beam !== undefined) {
    values.push({ path: "design.beam", value: info.beam });
  }
  if (info.draft !== undefined) {
    values.push({
      path: "design.draft",
      value: { maximum: info.draft },
    });
  }
  if (info.fromBow !== undefined) {
    values.push({ path: "sensors.ais.fromBow", value: info.fromBow });
  }
  if (info.fromCenter !== undefined) {
    values.push({
      path: "sensors.ais.fromCenter",
      value: info.fromCenter,
    });
  }

  return delta(selfId, new Date().toISOString(), values, options.network);
}

export function valuesToDelta(
  selfId: string,
  values: Values,
  options: InjectSource,
  timestamp = new Date().toISOString(),
): Delta | null {
  const entries = Object.entries(values).map(([path, value]) => ({
    path,
    value,
  }));
  return delta(selfId, timestamp, entries, options.network);
}

export function aisSnapshotToDelta(
  snapshot: AisSnapshot,
  options: InjectSource,
): Delta | null {
  const values: Array<{ path: string; value: unknown }> = [
    { path: "", value: { mmsi: String(snapshot.mmsi) } },
  ];
  if (snapshot.latitude !== undefined && snapshot.longitude !== undefined) {
    values.push({
      path: "navigation.position",
      value: {
        latitude: snapshot.latitude,
        longitude: snapshot.longitude,
      },
    });
  }
  if (snapshot.courseOverGround !== undefined) {
    values.push({
      path: "navigation.courseOverGroundTrue",
      value: snapshot.courseOverGround,
    });
  }
  if (snapshot.speedOverGround !== undefined) {
    values.push({
      path: "navigation.speedOverGround",
      value: snapshot.speedOverGround,
    });
  }
  if (snapshot.heading !== undefined) {
    values.push({
      path: "navigation.headingTrue",
      value: snapshot.heading,
    });
  }
  if (snapshot.navState !== undefined) {
    values.push({ path: "navigation.state", value: snapshot.navState });
  }
  if (snapshot.aisClass !== undefined) {
    values.push({ path: "sensors.ais.class", value: snapshot.aisClass });
  }

  return deltaForContext(
    `vessels.urn:mrn:imo:mmsi:${snapshot.mmsi}`,
    new Date(snapshot.timestamp * 1000).toISOString(),
    values,
    options.network,
  );
}

export function aisStaticToDelta(
  info: AisStaticInfo,
  options: InjectSource,
): Delta | null {
  const values: Array<{ path: string; value: unknown }> = [];
  const root: Record<string, unknown> = { mmsi: String(info.mmsi) };
  if (info.name) root.name = info.name;
  if (info.callsign) root.callsign = info.callsign;
  values.push({ path: "", value: root });
  if (info.shipType !== undefined) {
    values.push({
      path: "design.aisShipType",
      value: { id: info.shipType },
    });
  }

  return deltaForContext(
    `vessels.urn:mrn:imo:mmsi:${info.mmsi}`,
    new Date().toISOString(),
    values,
    options.network,
  );
}
