import NoiseSecretStream from "@hyperswarm/secret-stream";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Hyperswarm from "hyperswarm";
import { generateIdentity, loadOrCreateIdentity } from "../src/identity.js";
import { LiveClient, type LiveLogger } from "../src/live/client.js";
import { encodeLiveMessage, type LiveMessage } from "../src/live/message.js";
import { createLiveMux, openLiveChannel } from "../src/live/protocol.js";

class FakeSwarm {
  private handlers: Array<(connection: unknown) => void> = [];

  on(event: string, handler: (connection: unknown) => void): this {
    if (event === "connection") this.handlers.push(handler);
    return this;
  }

  join(): { flushed(): Promise<void>; destroy(): Promise<void> } {
    return { flushed: async () => {}, destroy: async () => {} };
  }

  async destroy(): Promise<void> {
    // nothing
  }

  emit(connection: unknown): void {
    for (const handler of this.handlers) handler(connection);
  }
}

const quiet: LiveLogger = { info() {}, error() {}, debug() {} };
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signed(
  identity: ReturnType<typeof generateIdentity>,
  selfId: string,
  text: string,
): Buffer {
  return encodeLiveMessage(
    {
      sourceKey: identity.publicKeyRaw,
      selfId,
      records: [Buffer.from(text)],
    },
    { sign: (data) => identity.sign(data) },
  );
}

describe("LiveClient security", () => {
  it("rejects unsigned and tampered messages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skp2p-live-sec-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const identity = await loadOrCreateIdentity(dir);
    const swarm = new FakeSwarm();
    const client = new LiveClient({
      identity,
      selfId: "urn:mrn:signalk:uuid:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      topic: Buffer.alloc(32),
      swarm: swarm as unknown as Hyperswarm,
      batchIntervalMs: 0,
      log: quiet,
    });
    await client.start();
    cleanups.push(() => client.stop());

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

    const manualNoise = new NoiseSecretStream(true, socket);
    await manualNoise.opened;
    const remoteNoise = await serverNoise;
    await remoteNoise.opened;

    swarm.emit(remoteNoise);
    const manualMux = createLiveMux(manualNoise);
    const manual = openLiveChannel(manualMux);
    await wait(250);

    const received: LiveMessage[] = [];
    client.onMessage((message) => received.push(message));

    const owner = generateIdentity();
    const selfId = "urn:mrn:signalk:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    manual.send(signed(owner, selfId, "ok"));
    await wait(200);
    expect(received).toHaveLength(1);

    const tampered = signed(owner, selfId, "tamper");
    const index = tampered.indexOf(Buffer.from("tamper"));
    tampered[index] ^= 0xff;
    manual.send(tampered);
    await wait(200);
    expect(received).toHaveLength(1);

    manual.send(
      encodeLiveMessage({
        sourceKey: owner.publicKeyRaw,
        selfId: "urn:mrn:signalk:uuid:cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        records: [Buffer.from("unsigned")],
      }),
    );
    await wait(200);
    expect(received).toHaveLength(1);
  });
});
