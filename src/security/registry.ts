import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ClaimRecord } from "./claim.js";
import { verifyClaimSignature } from "./claim.js";

export type ClaimStatus = "unverified" | "attested" | "revoked";

export interface Attestation {
  issuer: string;
  issuedAt: number;
  expiresAt: number;
  /** Base64 Ed25519 signature over the attestation record. */
  signature: string;
}

const CLOCK_SKEW_SECONDS = 300;

export interface ClaimEntry {
  selfId: string;
  /** Hex-encoded 32-byte key. */
  key: string;
  status: ClaimStatus;
  claimedAt: number;
  attestations: Attestation[];
}

export interface ClaimRegistryLogger {
  error(message: string): void;
  debug?(message: string): void;
}

export interface ClaimRegistryOptions {
  /** Persistence path, e.g. `<dataDir>/claims.json`. */
  path: string;
  /** Hex-encoded keys allowed to attest/revoke. */
  attestors?: string[];
  /** Reject unverified claims; only attested claims authorize. */
  requireAttestation?: boolean;
  /** Distinct attestations required before a claim is attested. */
  attestationThreshold?: number;
  now?: () => number;
  log?: ClaimRegistryLogger;
}

const defaultLogger: ClaimRegistryLogger = {
  error: (message) => console.error(message),
};

/**
 * Authoritative-ish public binding of selfId -> key.
 *
 * It starts as TOFU (the first verified key owns an unclaimed selfId) and is
 * upgraded by attestations from configured public attestors. It persists to a
 * local JSON file and converges as peers exchange claim records.
 */
export class ClaimRegistry {
  private readonly claims = new Map<string, ClaimEntry>();
  private readonly attestors = new Set<string>();
  private readonly requireAttestation: boolean;
  private readonly attestationThreshold: number;
  private readonly now: () => number;
  private readonly log: ClaimRegistryLogger;
  private readonly path: string;
  private loaded = false;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: ClaimRegistryOptions) {
    this.path = options.path;
    this.requireAttestation = options.requireAttestation ?? false;
    const threshold = options.attestationThreshold ?? 1;
    this.attestationThreshold =
      Number.isInteger(threshold) && threshold > 0 ? threshold : 1;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.log = options.log ?? defaultLogger;
    for (const attestor of options.attestors ?? []) {
      this.attestors.add(attestor.toLowerCase());
    }
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const value of parsed) {
          const entry = normalizeEntry(value);
          if (entry) this.claims.set(entry.selfId, entry);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.log.error(`claim registry load failed: ${String(error)}`);
      }
    }
    this.loaded = true;
  }

  authorize(selfId: string, key: Buffer): { ok: boolean; reason?: string } {
    const keyHex = key.toString("hex");
    const entry = this.claims.get(selfId);

    if (!entry) {
      if (this.requireAttestation) {
        return { ok: false, reason: "no attested claim" };
      }
      this.claims.set(selfId, {
        selfId,
        key: keyHex,
        status: "unverified",
        claimedAt: this.now(),
        attestations: [],
      });
      this.persist();
      return { ok: true };
    }

    if (entry.key !== keyHex) {
      return { ok: false, reason: "key mismatch" };
    }
    if (entry.status === "revoked") {
      return { ok: false, reason: "claim revoked" };
    }
    const active = this.activeAttestations(entry).length;
    const attested = active >= this.attestationThreshold;
    const nextStatus = attested ? "attested" : "unverified";
    if (entry.status !== nextStatus) {
      entry.status = nextStatus;
      this.persist();
    }
    if (this.requireAttestation && !attested) {
      return { ok: false, reason: "unverified claim" };
    }
    return { ok: true };
  }

  /** Attestations that are still valid, signed, unexpired and from a current attestor. */
  private activeAttestations(entry: ClaimEntry): Attestation[] {
    const now = this.now();
    const subjectKey = Buffer.from(entry.key, "hex");
    return entry.attestations.filter((attestation) => {
      if (!attestation.signature) return false;
      if (!this.attestors.has(attestation.issuer)) return false;
      if (attestation.issuedAt > now + CLOCK_SKEW_SECONDS) return false;
      if (attestation.expiresAt !== 0 && attestation.expiresAt <= now) {
        return false;
      }
      const record: ClaimRecord = {
        kind: "attest",
        selfId: entry.selfId,
        subjectKey,
        issuerKey: Buffer.from(attestation.issuer, "hex"),
        issuedAt: attestation.issuedAt,
        expiresAt: attestation.expiresAt,
        signature: Buffer.from(attestation.signature, "base64"),
      };
      return verifyClaimSignature(record);
    });
  }

  /** Apply a vessel's own claim (already authenticated by the LiveMessage). */
  applyClaim(record: ClaimRecord): "accepted" | "conflict" | "updated" {
    if (record.kind !== "claim") return "conflict";
    const keyHex = record.subjectKey.toString("hex");
    const entry = this.claims.get(record.selfId);

    if (!entry) {
      this.claims.set(record.selfId, {
        selfId: record.selfId,
        key: keyHex,
        status: "unverified",
        claimedAt: record.issuedAt || this.now(),
        attestations: [],
      });
      this.persist();
      return "accepted";
    }

    if (entry.key === keyHex) {
      if (entry.status === "revoked") entry.status = "unverified";
      entry.claimedAt = Math.min(
        entry.claimedAt,
        record.issuedAt || entry.claimedAt,
      );
      this.persist();
      return "updated";
    }

    if (entry.status === "revoked") {
      entry.key = keyHex;
      entry.status = "unverified";
      entry.claimedAt = record.issuedAt || this.now();
      entry.attestations = [];
      this.persist();
      return "accepted";
    }

    // A different key cannot take over an active claim without an attestation.
    return "conflict";
  }

  applyAttestation(record: ClaimRecord): boolean {
    if (record.kind !== "attest") return false;
    const issuer = record.issuerKey.toString("hex");
    if (!this.attestors.has(issuer)) return false;
    if (!verifyClaimSignature(record)) return false;
    const now = this.now();
    if (record.issuedAt > now + CLOCK_SKEW_SECONDS) return false;
    if (record.expiresAt !== 0 && record.expiresAt <= now) return false;

    const keyHex = record.subjectKey.toString("hex");
    const attestation: Attestation = {
      issuer,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      signature: record.signature?.toString("base64") ?? "",
    };
    const entry = this.claims.get(record.selfId);

    if (!entry) {
      this.claims.set(record.selfId, {
        selfId: record.selfId,
        key: keyHex,
        status: this.attestationThreshold <= 1 ? "attested" : "unverified",
        claimedAt: record.issuedAt || this.now(),
        attestations: [attestation],
      });
      this.persist();
      return true;
    }

    if (entry.key === keyHex) {
      upsertAttestation(entry, attestation);
      entry.status =
        this.activeAttestations(entry).length >= this.attestationThreshold
          ? "attested"
          : "unverified";
      this.persist();
      return true;
    }

    // Resolving a conflicting key needs a single attestation. With a threshold
    // above one, disputes are left for the operator instead of silently flipping.
    if (this.attestationThreshold > 1) {
      return false;
    }

    // A conflicting key. An attested claim overrides an unverified or revoked one.
    if (entry.status !== "attested") {
      this.claims.set(record.selfId, {
        selfId: record.selfId,
        key: keyHex,
        status: "attested",
        claimedAt: record.issuedAt || this.now(),
        attestations: [attestation],
      });
      this.persist();
      return true;
    }

    // Two attested keys: more active attestations wins; tie by lower key.
    const active = this.activeAttestations(entry).length;
    const candidateWins = active < 1 || (active === 1 && keyHex < entry.key);
    if (!candidateWins) {
      return false;
    }
    this.claims.set(record.selfId, {
      selfId: record.selfId,
      key: keyHex,
      status: "attested",
      claimedAt: record.issuedAt || this.now(),
      attestations: [attestation],
    });
    this.persist();
    return true;
  }

  applyRevocation(record: ClaimRecord): boolean {
    if (record.kind !== "revoke") return false;
    const issuer = record.issuerKey.toString("hex");
    if (!this.attestors.has(issuer)) return false;
    if (!verifyClaimSignature(record)) return false;

    const entry = this.claims.get(record.selfId);
    if (!entry || entry.key !== record.subjectKey.toString("hex")) {
      return false;
    }
    entry.status = "revoked";
    this.persist();
    return true;
  }

  get(selfId: string): ClaimEntry | undefined {
    return this.claims.get(selfId);
  }

  snapshot(): ClaimEntry[] {
    return [...this.claims.values()];
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      this.writeNow();
    }
    await this.writeQueue;
  }

  private persist(): void {
    if (!this.loaded || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.writeNow();
    }, 250);
    this.persistTimer.unref?.();
  }

  private writeNow(): void {
    const data = JSON.stringify(this.snapshot(), null, 2);
    const temporary = `${this.path}.tmp`;
    this.writeQueue = this.writeQueue
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(temporary, data, "utf8");
        await rename(temporary, this.path);
      })
      .catch((error) => {
        this.log.error(`claim registry persist failed: ${String(error)}`);
      });
  }
}

function upsertAttestation(entry: ClaimEntry, next: Attestation): void {
  const index = entry.attestations.findIndex(
    (attestation) => attestation.issuer === next.issuer,
  );
  if (index === -1) {
    entry.attestations.push(next);
  } else if (next.issuedAt >= entry.attestations[index].issuedAt) {
    entry.attestations[index] = next;
  }
}

function normalizeEntry(value: unknown): ClaimEntry | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.selfId !== "string" ||
    typeof entry.key !== "string" ||
    (entry.status !== "unverified" &&
      entry.status !== "attested" &&
      entry.status !== "revoked") ||
    typeof entry.claimedAt !== "number" ||
    !Array.isArray(entry.attestations)
  ) {
    return undefined;
  }
  return {
    selfId: entry.selfId,
    key: entry.key,
    status: entry.status,
    claimedAt: entry.claimedAt,
    attestations: entry.attestations.filter(
      (attestation): attestation is Attestation =>
        attestation !== null &&
        typeof attestation === "object" &&
        typeof (attestation as Attestation).issuer === "string" &&
        typeof (attestation as Attestation).issuedAt === "number" &&
        typeof (attestation as Attestation).expiresAt === "number" &&
        typeof (attestation as Attestation).signature === "string",
    ),
  };
}
