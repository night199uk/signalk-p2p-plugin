import NoiseSecretStream from "@hyperswarm/secret-stream";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Hyperswarm from "hyperswarm";
import { loadOrCreateIdentity } from "../src/identity.js";
import { LiveClient, type LiveLogger } from "../src/live/client.js";
import type { LiveMessage } from "../src/live/message.js";

class FakeSwarm {
  private handlers: Array<(connection: unknown) => void> = [];

  on(event: string, handler: (connection: unknown) => void): this {
    if (event === "connection") this.handlers.push(handler);
    return this;
  }

  join(): { flushed(): Promise<void>; destroy(): Promise<void> } {
    return {
      flushed: async () => {},
      destroy: async () => {},
    };
  }

  async destroy(): Promise<void> {
    // nothing
  }

  emit(connection: unknown): void {
    for (const handler of this.handlers) {
      handler(connection);
    }
  }
}

const quiet: LiveLogger = {
  info() {},
  error() {},
  debug() {},
};

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("LiveClient", () => {
  it("sends a batch to another client over an encrypted stream", async () => {
    const dirA = await mkdtemp(join(tmpdir(), "skp2p-live-a-"));
    const dirB = await mkdtemp(join(tmpdir(), "skp2p-live-b-"));
    cleanups.push(() => rm(dirA, { recursive: true, force: true }));
    cleanups.push(() => rm(dirB, { recursive: true, force: true }));

    const identityA = await loadOrCreateIdentity(dirA);
    const identityB = await loadOrCreateIdentity(dirB);
    const swarmA = new FakeSwarm();
    const swarmB = new FakeSwarm();

    const clientA = new LiveClient({
      identity: identityA,
      selfId: "urn:mrn:signalk:uuid:a",
      topic: Buffer.alloc(32),
      swarm: swarmA as unknown as Hyperswarm,
      batchIntervalMs: 0,
      log: quiet,
    });
    const clientB = new LiveClient({
      identity: identityB,
      selfId: "urn:mrn:signalk:uuid:b",
      topic: Buffer.alloc(32),
      swarm: swarmB as unknown as Hyperswarm,
      batchIntervalMs: 0,
      log: quiet,
    });
    await clientA.start();
    await clientB.start();
    cleanups.push(() => clientA.stop());
    cleanups.push(() => clientB.stop());

    let resolveServerNoise!: (noise: NoiseSecretStream) => void;
    const serverNoise = new Promise<NoiseSecretStream>((resolve) => {
      resolveServerNoise = resolve;
    });
    const server = net.createServer((socket) => {
      resolveServerNoise(new NoiseSecretStream(false, socket));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    );
    const port = (server.address() as net.AddressInfo).port;
    const socket = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    cleanups.push(() => socket.destroy());

    const clientNoise = new NoiseSecretStream(true, socket);
    await clientNoise.opened;
    const remoteNoise = await serverNoise;
    await remoteNoise.opened;

    swarmA.emit(clientNoise);
    swarmB.emit(remoteNoise);
    await wait(250);

    const received = new Promise<LiveMessage>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("receiver got no live message")),
        5000,
      );
      clientB.onMessage((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });

    clientA.enqueue(Buffer.from("hello"));
    clientA.flush();

    const message = await received;
    expect(message.selfId).toBe("urn:mrn:signalk:uuid:a");
    expect(message.records.map(String)).toEqual(["hello"]);
  });
});
