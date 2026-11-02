export interface MergeEntry {
  value: unknown;
  timestamp: number;
  source: string;
  priority: number;
}

export interface MergeOptions {
  /** Consistent units across callers; snapshots use Unix seconds. */
  timestamp: number;
  source: string;
  /**
   * Higher wins when timestamps are equal. Local data uses 1, remote data 0,
   * so local wins an exact tie.
   */
  priority?: number;
}

/**
 * Last-writer-wins register per `(context, path)`.
 *
 * Remote data merges by timestamp; ties break deterministically by writer key
 * so every peer converges on the same value. Local data can be given a higher
 * priority so it wins an exact tie.
 */
export class LastWriterWins {
  private readonly entries = new Map<string, MergeEntry>();

  private static key(context: string, path: string): string {
    return `${context}\u0000${path}`;
  }

  /** Returns true when the value was applied. */
  apply(
    context: string,
    path: string,
    value: unknown,
    options: MergeOptions,
  ): boolean {
    const key = LastWriterWins.key(context, path);
    const existing = this.entries.get(key);
    const next: MergeEntry = {
      value,
      timestamp: options.timestamp,
      source: options.source,
      priority: options.priority ?? 0,
    };
    if (existing && !isNewer(next, existing)) {
      return false;
    }
    this.entries.set(key, next);
    return true;
  }

  get(context: string, path: string): MergeEntry | undefined {
    return this.entries.get(LastWriterWins.key(context, path));
  }

  /** All entries for a context, keyed by path. */
  values(context: string): Map<string, MergeEntry> {
    const prefix = `${context}\u0000`;
    const values = new Map<string, MergeEntry>();
    for (const [key, entry] of this.entries) {
      if (key.startsWith(prefix)) {
        values.set(key.slice(prefix.length), entry);
      }
    }
    return values;
  }

  contexts(): string[] {
    const contexts = new Set<string>();
    for (const key of this.entries.keys()) {
      contexts.add(key.slice(0, key.indexOf("\u0000")));
    }
    return [...contexts];
  }

  deleteContext(context: string): void {
    const prefix = `${context}\u0000`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

function isNewer(next: MergeEntry, current: MergeEntry): boolean {
  if (next.timestamp !== current.timestamp) {
    return next.timestamp > current.timestamp;
  }
  if (next.priority !== current.priority) {
    return next.priority > current.priority;
  }
  // Deterministic tie-break: the lexicographically lower source wins.
  return next.source < current.source;
}
