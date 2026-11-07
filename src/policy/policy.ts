import { verifyDetached, type Identity } from "../identity.js";
import { canonicalJson } from "../groups/types.js";
import { PROTOCOL_VERSION } from "../data/envelope.js";
import { ALL_VESSELS_TOPIC } from "../live/topic.js";

export interface PolicySharding {
  maxVesselsPerShard: number;
  maxVesselsPerInstance: number;
  lookAheadKm: number;
  splitSettleMinutes: number;
  mergeSettleMinutes: number;
  mergeBelowRatio: number;
  boundaryHysteresisMeters: number;
}

export interface PolicyElection {
  epochMinutes: number;
  minUptimeMinutes: number;
}

export interface PolicyRates {
  maxSnapshotHzUnderway: number;
  maxSnapshotHzMoored: number;
}

export interface PolicyAis {
  maxTargets: number;
  maxRateHz: number;
}

export interface NetworkPolicy {
  version: number;
  topic: string;
  protocol: number;
  issuedAt: number;
  notBefore?: number;
  notAfter?: number;
  sharding: PolicySharding;
  election: PolicyElection;
  rates: PolicyRates;
  ais: PolicyAis;
}

export interface SignedPolicy {
  policy: NetworkPolicy;
  /** Base64 Ed25519 signature over canonicalJson(policy). */
  signature: string;
}

export const DEFAULT_POLICY_VERSION = 1;
export const MAX_POLICY_RATE_HZ = 10;

export function defaultPolicy(
  version = DEFAULT_POLICY_VERSION,
  issuedAt = Math.floor(Date.now() / 1000),
): NetworkPolicy {
  return {
    version,
    topic: ALL_VESSELS_TOPIC,
    protocol: PROTOCOL_VERSION,
    issuedAt,
    sharding: {
      maxVesselsPerShard: 500,
      maxVesselsPerInstance: 1000,
      lookAheadKm: 50,
      splitSettleMinutes: 10,
      mergeSettleMinutes: 60,
      mergeBelowRatio: 0.25,
      boundaryHysteresisMeters: 1000,
    },
    election: {
      epochMinutes: 10,
      minUptimeMinutes: 10,
    },
    rates: {
      maxSnapshotHzUnderway: 0.05,
      maxSnapshotHzMoored: 0.01,
    },
    ais: {
      maxTargets: 100,
      maxRateHz: 0.02,
    },
  };
}

export function policyBytes(policy: NetworkPolicy): Buffer {
  return Buffer.from(canonicalJson(policy));
}

export function signPolicy(
  policy: NetworkPolicy,
  identity: Identity,
): SignedPolicy {
  return {
    policy,
    signature: identity.sign(policyBytes(policy)).toString("base64"),
  };
}

export function verifyPolicy(
  signed: SignedPolicy,
  operatorKeys: string[],
  expectedTopic: string,
  now = Math.floor(Date.now() / 1000),
): boolean {
  if (!validPolicy(signed.policy, expectedTopic, now)) return false;
  const bytes = policyBytes(signed.policy);
  const signature = Buffer.from(signed.signature, "base64");
  for (const key of operatorKeys) {
    if (!/^[0-9a-f]{64}$/i.test(key)) continue;
    if (verifyDetached(Buffer.from(key, "hex"), bytes, signature)) return true;
  }
  return false;
}

export function validPolicy(
  policy: NetworkPolicy,
  expectedTopic: string,
  now = Math.floor(Date.now() / 1000),
): boolean {
  if (!Number.isInteger(policy.version) || policy.version < 1) return false;
  if (policy.topic !== expectedTopic) return false;
  if (policy.protocol !== PROTOCOL_VERSION) return false;
  if (!Number.isInteger(policy.issuedAt) || policy.issuedAt < 0) return false;
  if (
    policy.notBefore !== undefined &&
    (!Number.isInteger(policy.notBefore) || policy.notBefore > now)
  ) {
    return false;
  }
  if (
    policy.notAfter !== undefined &&
    policy.notAfter > 0 &&
    (!Number.isInteger(policy.notAfter) || policy.notAfter < now)
  ) {
    return false;
  }
  const sharding = policy.sharding;
  if (!sharding || typeof sharding !== "object") return false;
  if (!positive(sharding.maxVesselsPerShard)) return false;
  if (!positive(sharding.maxVesselsPerInstance)) return false;
  if (!nonNegative(sharding.lookAheadKm)) return false;
  if (!nonNegative(sharding.splitSettleMinutes)) return false;
  if (!nonNegative(sharding.mergeSettleMinutes)) return false;
  if (
    typeof sharding.mergeBelowRatio !== "number" ||
    sharding.mergeBelowRatio < 0 ||
    sharding.mergeBelowRatio > 1
  ) {
    return false;
  }
  if (!nonNegative(sharding.boundaryHysteresisMeters)) return false;
  const election = policy.election;
  if (!election || typeof election !== "object") return false;
  if (!positive(election.epochMinutes)) return false;
  if (!nonNegative(election.minUptimeMinutes)) return false;
  const rates = policy.rates;
  if (!rates || typeof rates !== "object") return false;
  if (!rate(rates.maxSnapshotHzUnderway)) return false;
  if (!rate(rates.maxSnapshotHzMoored)) return false;
  const ais = policy.ais;
  if (!ais || typeof ais !== "object") return false;
  if (!nonNegative(ais.maxTargets)) return false;
  if (!rate(ais.maxRateHz, true)) return false;
  return true;
}

export function encodePolicy(signed: SignedPolicy): Buffer {
  return Buffer.from(JSON.stringify(signed), "utf8");
}

export function decodePolicy(data: Buffer): SignedPolicy {
  const parsed: unknown = JSON.parse(data.toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("policy: expected an object");
  }
  const signed = parsed as SignedPolicy;
  if (
    signed.policy === null ||
    typeof signed.policy !== "object" ||
    typeof signed.signature !== "string"
  ) {
    throw new Error("policy: malformed record");
  }
  return signed;
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function rate(value: unknown, allowZero = false): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (allowZero ? value >= 0 : value > 0) &&
    value <= MAX_POLICY_RATE_HZ
  );
}
