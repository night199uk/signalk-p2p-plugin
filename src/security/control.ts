import type { Identity } from "../identity.js";
import { createAttestation, createRevocation } from "./attestor.js";
import type { ClaimRecord } from "./claim.js";
import type { ClaimEntry, ClaimRegistry } from "./registry.js";

export interface ControlIdentity {
  publicKey: string;
  fingerprint: string;
  isAttestor: boolean;
}

export interface ControlResult {
  ok: boolean;
  error?: string;
  claim?: ClaimEntry;
}

export interface AttestInput {
  selfId?: unknown;
  key?: unknown;
  expiresAt?: unknown;
}

export interface RevokeInput {
  selfId?: unknown;
  key?: unknown;
}

export interface ClaimControl {
  identity(): ControlIdentity | undefined;
  claims(): ClaimEntry[];
  attest(input: AttestInput): ControlResult;
  revoke(input: RevokeInput): ControlResult;
}

export interface ControlContext {
  identity(): Identity | undefined;
  registry(): ClaimRegistry | undefined;
  attestors(): string[];
  broadcast(record: ClaimRecord): void;
  now?: () => number;
}

export function isAttestor(
  identity: Identity | undefined,
  attestors: string[],
): boolean {
  if (!identity) return false;
  const key = identity.publicKeyRaw.toString("hex");
  return attestors.some((attestor) => attestor.toLowerCase() === key);
}

interface ParsedInput {
  selfId: string;
  key?: Buffer;
  expiresAt?: number;
}

function parseInput(
  input: AttestInput | RevokeInput,
): ParsedInput | { error: string } {
  if (typeof input.selfId !== "string" || input.selfId.length === 0) {
    return { error: "selfId is required" };
  }
  let key: Buffer | undefined;
  if (input.key !== undefined) {
    if (typeof input.key !== "string" || !/^[0-9a-fA-F]{64}$/.test(input.key)) {
      return { error: "key must be 64 hex characters" };
    }
    key = Buffer.from(input.key, "hex");
  }
  let expiresAt: number | undefined;
  if ("expiresAt" in input && input.expiresAt !== undefined) {
    if (
      typeof input.expiresAt !== "number" ||
      !Number.isInteger(input.expiresAt) ||
      input.expiresAt < 0
    ) {
      return { error: "expiresAt must be a non-negative integer" };
    }
    expiresAt = input.expiresAt;
  }
  return { selfId: input.selfId, key, expiresAt };
}

function claimKey(registry: ClaimRegistry, selfId: string): Buffer | undefined {
  const key = registry.get(selfId)?.key;
  if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) return undefined;
  return Buffer.from(key, "hex");
}

export function createClaimControl(context: ControlContext): ClaimControl {
  const identityInfo = (): ControlIdentity | undefined => {
    const identity = context.identity();
    if (!identity) return undefined;
    return {
      publicKey: identity.publicKeyRaw.toString("hex"),
      fingerprint: identity.fingerprint,
      isAttestor: isAttestor(identity, context.attestors()),
    };
  };

  const attest = (input: AttestInput): ControlResult => {
    const identity = context.identity();
    const registry = context.registry();
    if (!identity || !registry) {
      return { ok: false, error: "plugin is not started" };
    }
    if (!isAttestor(identity, context.attestors())) {
      return {
        ok: false,
        error: "this instance is not a configured public attestor",
      };
    }
    const parsed = parseInput(input);
    if ("error" in parsed) return { ok: false, error: parsed.error };

    const subjectKey = parsed.key ?? claimKey(registry, parsed.selfId);
    if (!subjectKey) {
      return {
        ok: false,
        error: "no key known for this selfId; provide it explicitly",
      };
    }

    const record = createAttestation(identity, parsed.selfId, subjectKey, {
      expiresAt: parsed.expiresAt,
      now: context.now?.(),
    });
    if (!registry.applyAttestation(record)) {
      return { ok: false, error: "attestation rejected" };
    }
    context.broadcast(record);
    return { ok: true, claim: registry.get(parsed.selfId) };
  };

  const revoke = (input: RevokeInput): ControlResult => {
    const identity = context.identity();
    const registry = context.registry();
    if (!identity || !registry) {
      return { ok: false, error: "plugin is not started" };
    }
    if (!isAttestor(identity, context.attestors())) {
      return {
        ok: false,
        error: "this instance is not a configured public attestor",
      };
    }
    const parsed = parseInput(input);
    if ("error" in parsed) return { ok: false, error: parsed.error };

    const subjectKey = parsed.key ?? claimKey(registry, parsed.selfId);
    if (!subjectKey) {
      return {
        ok: false,
        error: "no key known for this selfId; provide it explicitly",
      };
    }

    const record = createRevocation(identity, parsed.selfId, subjectKey, {
      now: context.now?.(),
    });
    if (!registry.applyRevocation(record)) {
      return { ok: false, error: "revocation rejected" };
    }
    context.broadcast(record);
    return { ok: true, claim: registry.get(parsed.selfId) };
  };

  return {
    identity: identityInfo,
    claims: () => context.registry()?.snapshot() ?? [],
    attest,
    revoke,
  };
}
