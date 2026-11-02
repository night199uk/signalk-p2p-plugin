import { createHash, randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import Hyperswarm from "hyperswarm";
import { verifyDetached, type Identity } from "../identity.js";
import {
  decodeLiveMessages,
  encodeLiveMessage,
  type LiveMessage,
} from "./message.js";
import {
  createLiveMux,
  openLiveChannel,
  type LiveChannel,
} from "./protocol.js";

export interface LiveLogger {
  info(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}

export interface LiveClientOptions {
  identity: Identity;
  selfId: string;
  topic: Buffer;
  batchIntervalMs?: number;
  maxBatchBytes?: number;
  port?: number;
  swarm?: Hyperswarm;
  log?: LiveLogger;
  /** Encrypt/transform a record before it is put on the wire. */
  transformOutgoing?: (record: Buffer) => Buffer;
  /** Decrypt/transform a received record; return undefined to drop it. */
  transformIncoming?: (record: Buffer) => Buffer | undefined;
}

interface Peer {
  id: string;
  channel: LiveChannel;
}

interface SwarmConnection extends Duplex {
  remotePublicKey?: Buffer;
}

const DEFAULT_BATCH_INTERVAL_MS = 2000;
const DEFAULT_MAX_BATCH_BYTES = 64 * 1024;
const SEEN_TTL_MS = 60_000;
const MAX_SEEN = 4096;

const defaultLogger: LiveLogger = {
  info: (message) => console.log(message),
  error: (message) => console.error(message),
};

/**
 * The Signal K side of the live plane.
 *
 * Clients send their batches to the elected aggregator when one is known, and
 * fall back to all connected peers otherwise. Only an elected aggregator
 * forwards batches it receives; every client deduplicates messages so a brief
 * election overlap cannot loop data.
 */
export class LiveClient {
  private readonly identity: Identity;
  private readonly selfId: string;
  private readonly topic: Buffer;
  private readonly batchIntervalMs: number;
  private readonly maxBatchBytes: number;
  private readonly log: LiveLogger;
  private readonly swarm: Hyperswarm;
  private readonly ownsSwarm: boolean;
  private readonly transformOutgoing: ((record: Buffer) => Buffer) | undefined;
  private readonly transformIncoming:
    ((record: Buffer) => Buffer | undefined) | undefined;

  private readonly peers = new Map<string, Peer>();
  private readonly handlers: Array<(message: LiveMessage) => void> = [];
  private readonly sourceToPeer = new Map<string, string>();
  private readonly seen = new Map<string, number>();

  private aggregator = false;
  private preferredPeerKey: string | undefined;
  private queue: Buffer[] = [];
  private queuedBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;

  constructor(options: LiveClientOptions) {
    this.identity = options.identity;
    this.selfId = options.selfId;
    this.topic = options.topic;
    this.batchIntervalMs = options.batchIntervalMs ?? DEFAULT_BATCH_INTERVAL_MS;
    this.maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
    this.log = options.log ?? defaultLogger;
    this.swarm = options.swarm ?? new Hyperswarm({ port: options.port });
    this.ownsSwarm = !options.swarm;
    this.transformOutgoing = options.transformOutgoing;
    this.transformIncoming = options.transformIncoming;
  }

  async start(): Promise<void> {
    this.swarm.on("connection", (connection: SwarmConnection) =>
      this.accept(connection),
    );
    const discovery = this.swarm.join(this.topic, {
      server: true,
      client: true,
    });
    await discovery.flushed();
    this.started = true;
    this.log.info(
      `live client ${this.identity.fingerprint.slice(0, 12)} joined topic ` +
        `${this.topic.toString("hex").slice(0, 16)}…`,
    );
  }

  /** True when this peer is the elected aggregator for the current epoch. */
  setAggregator(enabled: boolean): void {
    this.aggregator = enabled;
  }

  /** Source key (hex) of the elected aggregator, if one is known. */
  setPreferredPeer(key: string | undefined): void {
    this.preferredPeerKey = key;
  }

  private accept(connection: SwarmConnection): void {
    const id = connection.remotePublicKey?.toString("hex") ?? randomUUID();
    try {
      const mux = createLiveMux(connection);
      const channel = openLiveChannel(mux);
      this.peers.set(id, { id, channel });
      channel.onMessage((data) => this.receive(data, id));
      connection.once("close", () => {
        this.peers.delete(id);
        for (const [sourceKey, peerId] of this.sourceToPeer) {
          if (peerId === id) this.sourceToPeer.delete(sourceKey);
        }
        this.log.debug?.(
          `peer ${id.slice(0, 8)} left (${this.peers.size} connected)`,
        );
      });
      connection.on("error", (error: Error) =>
        this.log.debug?.(`connection ${id.slice(0, 8)}: ${error.message}`),
      );
      this.log.debug?.(
        `peer ${id.slice(0, 8)} joined (${this.peers.size} connected)`,
      );
      // A queued static record or recent snapshot can go now.
      this.flush();
    } catch (error) {
      this.log.error(
        `live: could not attach peer ${id.slice(0, 8)}: ${String(error)}`,
      );
      connection.destroy();
    }
  }

  private receive(data: Buffer, peerId: string): void {
    let messages: LiveMessage[];
    try {
      messages = decodeLiveMessages(data);
    } catch (error) {
      this.log.error(`live: dropping malformed batch: ${String(error)}`);
      return;
    }

    const now = Date.now();
    const fresh: LiveMessage[] = [];
    for (const message of messages) {
      const key = messageKey(message);
      const seenAt = this.seen.get(key);
      if (seenAt !== undefined && now - seenAt <= SEEN_TTL_MS) {
        continue;
      }
      this.seen.set(key, now);
      this.sourceToPeer.set(message.sourceKey.toString("hex"), peerId);
      fresh.push(message);
    }
    if (fresh.length === 0) {
      return;
    }

    // Only the elected aggregator forwards; others just consume.
    if (this.aggregator) {
      for (const peer of this.peers.values()) {
        if (peer.id === peerId) continue;
        try {
          peer.channel.send(data);
        } catch (error) {
          this.log.error(
            `live: forward to ${peer.id.slice(0, 8)} failed: ${String(error)}`,
          );
        }
      }
    }

    for (const original of fresh) {
      let message = original;
      if (!message.signature || !message.signedBytes) {
        this.log.error(
          `live: rejected unsigned message from ${message.selfId}`,
        );
        continue;
      }
      if (
        !verifyDetached(
          message.sourceKey,
          message.signedBytes,
          message.signature,
        )
      ) {
        this.log.error(
          `live: rejected a message with a bad signature (${message.selfId})`,
        );
        continue;
      }
      if (message.sourceKey.equals(this.identity.publicKeyRaw)) {
        continue;
      }
      if (this.transformIncoming) {
        const records: Buffer[] = [];
        for (const record of message.records) {
          try {
            const plaintext = this.transformIncoming(record);
            if (plaintext) records.push(plaintext);
          } catch {
            // drop records that fail to decrypt
          }
        }
        if (records.length === 0) continue;
        message = { ...message, records };
      }
      for (const handler of this.handlers) {
        handler(message);
      }
    }

    this.pruneSeen(now);
  }

  private pruneSeen(now: number): void {
    if (this.seen.size <= MAX_SEEN) return;
    for (const [key, at] of this.seen) {
      if (now - at > SEEN_TTL_MS) this.seen.delete(key);
    }
  }

  /** Queue one envelope. It is sent with the next batch. */
  enqueue(record: Buffer): void {
    if (record.length > 0xffff) {
      this.log.error(`live: dropping oversized record (${record.length} B)`);
      return;
    }
    if (this.queuedBytes + record.length > this.maxBatchBytes) {
      if (this.peers.size > 0) {
        this.flush();
      } else {
        // No peers: keep only recent data rather than growing unbounded.
        this.queue = [];
        this.queuedBytes = 0;
      }
    }
    this.queue.push(record);
    this.queuedBytes += record.length;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.timer || this.queue.length === 0) return;
    if (this.batchIntervalMs === 0) {
      this.flush();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.batchIntervalMs);
    this.timer.unref?.();
  }

  private targets(): Peer[] {
    if (this.preferredPeerKey) {
      const peerId = this.sourceToPeer.get(this.preferredPeerKey);
      if (peerId) {
        const peer = this.peers.get(peerId);
        if (peer) return [peer];
      }
    }
    // No known aggregator (or it is not connected): fall back to the mesh.
    return [...this.peers.values()];
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.queue.length === 0) return;
    if (this.peers.size === 0) {
      // Keep the queue; it will be sent when a peer connects.
      return;
    }

    let records = this.queue;
    this.queue = [];
    this.queuedBytes = 0;

    if (this.transformOutgoing) {
      try {
        records = records.map((record) => this.transformOutgoing!(record));
      } catch (error) {
        this.log.error(`live: outgoing transform failed: ${String(error)}`);
        return;
      }
    }

    let batch: Buffer;
    try {
      batch = encodeLiveMessage(
        {
          sourceKey: this.identity.publicKeyRaw,
          selfId: this.selfId,
          records,
        },
        { sign: (data) => this.identity.sign(data) },
      );
    } catch (error) {
      this.log.error(`live: could not encode batch: ${String(error)}`);
      return;
    }

    const targets = this.aggregator ? [...this.peers.values()] : this.targets();
    for (const peer of targets) {
      try {
        peer.channel.send(batch);
      } catch (error) {
        this.log.error(
          `live: send to ${peer.id.slice(0, 8)} failed: ${String(error)}`,
        );
      }
    }
  }

  onMessage(handler: (message: LiveMessage) => void): void {
    this.handlers.push(handler);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.queue = [];
    this.queuedBytes = 0;
    this.peers.clear();
    this.sourceToPeer.clear();
    this.seen.clear();
    this.aggregator = false;
    this.preferredPeerKey = undefined;
    if (this.ownsSwarm) {
      await this.swarm.destroy();
    }
    this.started = false;
  }

  get peerCount(): number {
    return this.peers.size;
  }

  get running(): boolean {
    return this.started;
  }
}

function messageKey(message: LiveMessage): string {
  if (message.signature) {
    return message.signature.toString("hex");
  }
  return createHash("sha256")
    .update(message.signedBytes ?? Buffer.alloc(0))
    .digest("hex");
}
