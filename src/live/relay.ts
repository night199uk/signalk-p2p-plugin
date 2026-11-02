import { createHash, randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import Hyperswarm from "hyperswarm";
import { decodeEnvelope, encodeEnvelope } from "../data/envelope.js";
import type { Identity } from "../identity.js";
import { decodeCapability, encodeCapability } from "./capability.js";
import { PeerDirectory } from "./directory.js";
import { decodeLiveMessages, encodeLiveMessage } from "./message.js";
import {
  createLiveMux,
  openLiveChannel,
  type LiveChannel,
} from "./protocol.js";

export interface RelayLogger {
  info(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
}

export interface RelayCoreOptions {
  /** Coalesce forwarded batches for this long. 0 flushes immediately. */
  batchIntervalMs?: number;
  /** Flush early when the pending queue reaches this size. */
  maxBatchBytes?: number;
  /** Keep this many recent batches for peers that join late. */
  historyBatches?: number;
  log?: RelayLogger;
  /** Called for every incoming buffer before it is queued for forwarding. */
  onData?: (data: Buffer, peerId: string) => void;
}

export interface RelayHubOptions extends RelayCoreOptions {
  identity: Identity;
  /** The 32-byte network topic. */
  topic: Buffer;
  /** Optional DHT port, useful for a VPS firewall. */
  port?: number;
  /** Relative election capacity; defaults to 10 for an always-on peer. */
  capacity?: number;
  /** How often to advertise capabilities. Default 30 s. */
  advertiseIntervalMs?: number;
  /** Election epoch length. Default 600 s. */
  epochSeconds?: number;
  /** Minimum uptime to be elected. Default 600 s. */
  minUptimeSeconds?: number;
  /** Injected for tests; otherwise a Hyperswarm is created. */
  swarm?: Hyperswarm;
}

interface Peer {
  id: string;
  channel: LiveChannel;
}

const DEFAULT_BATCH_INTERVAL_MS = 2000;
const DEFAULT_MAX_BATCH_BYTES = 64 * 1024;
const DEFAULT_HISTORY_BATCHES = 10;
const SEEN_TTL_MS = 60_000;
const MAX_SEEN = 4096;

const defaultLogger: RelayLogger = {
  info: (message) => console.log(message),
  error: (message) => console.error(message),
};

/**
 * The transport-independent relay/aggregator.
 *
 * It treats each incoming buffer as opaque — a batch of signed envelopes — and
 * forwards a coalesced batch to every connected peer. It cannot forge a record;
 * at most it can drop or delay one.
 */
export class RelayCore {
  private readonly peers = new Map<string, Peer>();
  private queue: Buffer[] = [];
  private queuedBytes = 0;
  private history: Buffer[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  private readonly batchIntervalMs: number;
  private readonly maxBatchBytes: number;
  private readonly historyBatches: number;
  private readonly log: RelayLogger;
  private readonly onData: ((data: Buffer, peerId: string) => void) | undefined;
  private readonly seen = new Map<string, number>();
  private forwarding = true;

  forwardedBatches = 0;
  forwardedBytes = 0;

  /** Send a control message to every connected peer. */
  broadcast(data: Buffer): void {
    for (const peer of this.peers.values()) {
      try {
        peer.channel.send(data);
      } catch (error) {
        this.log.error(
          `relay: broadcast to ${peer.id.slice(0, 8)} failed: ${String(error)}`,
        );
      }
    }
  }

  constructor(options: RelayCoreOptions = {}) {
    this.batchIntervalMs = options.batchIntervalMs ?? DEFAULT_BATCH_INTERVAL_MS;
    this.maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
    this.historyBatches = options.historyBatches ?? DEFAULT_HISTORY_BATCHES;
    this.log = options.log ?? defaultLogger;
    this.onData = options.onData;

    if (this.batchIntervalMs < 0) {
      throw new Error("relay: batchIntervalMs must be >= 0");
    }
    if (this.maxBatchBytes <= 0) {
      throw new Error("relay: maxBatchBytes must be > 0");
    }
    if (this.historyBatches < 0) {
      throw new Error("relay: historyBatches must be >= 0");
    }
  }

  addPeer(id: string, channel: LiveChannel): void {
    this.peers.set(id, { id, channel });
    channel.onMessage((data) => {
      this.onData?.(data, id);
      this.receive(data);
    });
    for (const batch of this.history) {
      channel.send(batch);
    }
    this.log.debug?.(
      `peer ${id.slice(0, 8)} joined (${this.peers.size} connected)`,
    );
  }

  removePeer(id: string): void {
    if (this.peers.delete(id)) {
      this.log.debug?.(
        `peer ${id.slice(0, 8)} left (${this.peers.size} connected)`,
      );
    }
  }

  /** Only the elected aggregator forwards batches. */
  setForwarding(enabled: boolean): void {
    this.forwarding = enabled;
    if (!enabled) {
      this.queue = [];
      this.queuedBytes = 0;
    }
  }

  receive(data: Buffer): void {
    if (!this.forwarding || data.length === 0) return;
    const digest = createHash("sha256").update(data).digest("hex");
    const now = Date.now();
    const seenAt = this.seen.get(digest);
    if (seenAt !== undefined && now - seenAt <= SEEN_TTL_MS) {
      return;
    }
    this.seen.set(digest, now);
    if (this.seen.size > MAX_SEEN) {
      for (const [key, at] of this.seen) {
        if (now - at > SEEN_TTL_MS) this.seen.delete(key);
      }
    }
    if (data.length > this.maxBatchBytes) {
      this.log.error(
        `relay: dropping ${data.length} B batch (limit ${this.maxBatchBytes} B)`,
      );
      return;
    }
    if (this.queuedBytes + data.length > this.maxBatchBytes) {
      this.flush();
    }
    this.queue.push(data);
    this.queuedBytes += data.length;
    if (this.queuedBytes >= this.maxBatchBytes) {
      this.flush();
    } else {
      this.scheduleFlush();
    }
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
    // The swarm keeps the process alive; the batch timer should not.
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.queue.length === 0) return;

    const batch = Buffer.concat(this.queue);
    this.queue = [];
    this.queuedBytes = 0;

    this.history.push(batch);
    while (this.history.length > this.historyBatches) {
      this.history.shift();
    }

    this.forwardedBatches += 1;
    this.forwardedBytes += batch.length;
    this.log.debug?.(
      `forwarded ${batch.length} B to ${this.peers.size} peer(s)`,
    );

    for (const peer of this.peers.values()) {
      try {
        peer.channel.send(batch);
      } catch (error) {
        this.log.error(
          `relay: send to ${peer.id.slice(0, 8)} failed: ${String(error)}`,
        );
      }
    }
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.queue = [];
    this.queuedBytes = 0;
    this.peers.clear();
    this.seen.clear();
  }

  get peerCount(): number {
    return this.peers.size;
  }
}

interface SwarmConnection extends Duplex {
  remotePublicKey?: Buffer;
}

/**
 * Wires the relay to Hyperswarm. A VPS peer joins the public topic as a server
 * so boats behind CGNAT can dial it; it is still just a peer, replaceable by
 * election once enough reachable peers exist.
 */
export class RelayHub {
  private readonly core: RelayCore;
  private readonly swarm: Hyperswarm;
  private readonly ownsSwarm: boolean;
  private readonly log: RelayLogger;
  private readonly startedAt = Math.floor(Date.now() / 1000);
  private readonly peerSelfId: string;
  private readonly directory: PeerDirectory;
  private readonly ownKey: string;
  private advertiseTimer: ReturnType<typeof setInterval> | undefined;
  private electionTimer: ReturnType<typeof setInterval> | undefined;
  private forwarding = true;
  private started = false;

  constructor(private readonly options: RelayHubOptions) {
    this.swarm = options.swarm ?? new Hyperswarm({ port: options.port });
    this.ownsSwarm = !options.swarm;
    this.directory = new PeerDirectory(options.topic);
    this.ownKey = options.identity.publicKeyRaw.toString("hex");
    this.core = new RelayCore({
      ...options,
      onData: (data, peerId) => this.handleData(data, peerId),
    });
    this.log = options.log ?? defaultLogger;
    this.peerSelfId = `urn:mrn:signalk:p2p:peer:${options.identity.fingerprint}`;
  }

  async start(): Promise<void> {
    this.swarm.on("connection", (connection: SwarmConnection) =>
      this.accept(connection),
    );
    const discovery = this.swarm.join(this.options.topic, {
      server: true,
      client: true,
    });
    await discovery.flushed();
    this.started = true;
    this.advertise();
    this.updateElection();
    this.advertiseTimer = setInterval(
      () => this.advertise(),
      this.options.advertiseIntervalMs ?? 30_000,
    );
    this.advertiseTimer.unref?.();
    this.electionTimer = setInterval(() => this.updateElection(), 5000);
    this.electionTimer.unref?.();
    this.log.info(
      `relay ${this.options.identity.fingerprint.slice(0, 12)} joined topic ` +
        `${this.options.topic.toString("hex").slice(0, 16)}…`,
    );
  }

  private advertise(): void {
    const now = Math.floor(Date.now() / 1000);
    const capability = {
      topic: this.options.topic,
      selfId: this.peerSelfId,
      updatedAt: now,
      uptimeSince: this.startedAt,
      relayConsent: true,
      reachable: true,
      unmetered: true,
      capacity: this.options.capacity ?? 10,
      load: 0,
    };
    this.directory.update(capability, this.options.identity.publicKeyRaw, now);
    try {
      const message = encodeLiveMessage(
        {
          sourceKey: this.options.identity.publicKeyRaw,
          selfId: this.peerSelfId,
          records: [encodeEnvelope("capability", encodeCapability(capability))],
        },
        { sign: (data) => this.options.identity.sign(data) },
      );
      this.core.broadcast(message);
    } catch (error) {
      this.log.error(`relay: capability encode failed: ${String(error)}`);
    }
  }

  private handleData(data: Buffer, _peerId: string): void {
    let messages;
    try {
      messages = decodeLiveMessages(data);
    } catch {
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    for (const message of messages) {
      for (const record of message.records) {
        try {
          const envelope = decodeEnvelope(record);
          if (envelope.type !== "capability") continue;
          const capability = decodeCapability(envelope.payload);
          this.directory.update(capability, message.sourceKey, now);
        } catch {
          // ignore malformed control messages
        }
      }
    }
  }

  private updateElection(): void {
    const now = Math.floor(Date.now() / 1000);
    const elected = this.directory.elected({
      now,
      epochSeconds: this.options.epochSeconds ?? 600,
      minUptimeSeconds: this.options.minUptimeSeconds ?? 600,
    });
    // With no eligible peer, keep forwarding as the bootstrap fallback.
    const forwarding = elected ? elected.key === this.ownKey : true;
    this.core.setForwarding(forwarding);
    if (forwarding !== this.forwarding) {
      this.forwarding = forwarding;
      this.log.info(
        `relay election: elected=${elected?.selfId ?? "none"} ` +
          `forwarding=${forwarding}`,
      );
    }
  }

  private accept(connection: SwarmConnection): void {
    const id = connection.remotePublicKey?.toString("hex") ?? randomUUID();
    try {
      const mux = createLiveMux(connection);
      const channel = openLiveChannel(mux);
      this.core.addPeer(id, channel);
      connection.once("close", () => this.core.removePeer(id));
      connection.on("error", (error: Error) =>
        this.log.debug?.(`connection ${id.slice(0, 8)}: ${error.message}`),
      );
    } catch (error) {
      this.log.error(
        `relay: could not attach peer ${id.slice(0, 8)}: ${String(error)}`,
      );
      connection.destroy();
    }
  }

  async stop(): Promise<void> {
    if (this.advertiseTimer) {
      clearInterval(this.advertiseTimer);
      this.advertiseTimer = undefined;
    }
    if (this.electionTimer) {
      clearInterval(this.electionTimer);
      this.electionTimer = undefined;
    }
    this.core.stop();
    if (this.ownsSwarm) {
      await this.swarm.destroy();
    }
    this.started = false;
  }

  get peerCount(): number {
    return this.core.peerCount;
  }

  get forwardedBatches(): number {
    return this.core.forwardedBatches;
  }

  get forwardedBytes(): number {
    return this.core.forwardedBytes;
  }

  get running(): boolean {
    return this.started;
  }
}
