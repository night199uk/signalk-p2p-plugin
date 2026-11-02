import NoiseSecretStream from "@hyperswarm/secret-stream";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLiveMux,
  openLiveChannel,
  type LiveChannel,
} from "../src/live/protocol.js";
import { RelayCore, type RelayLogger } from "../src/live/relay.js";

const log: RelayLogger = { info() {}, error() {}, debug() {} };
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createClient(
  port: number,
): Promise<{ channel: LiveChannel; socket: net.Socket }> {
  const socket = net.connect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  const noise = new NoiseSecretStream(true, socket);
  await noise.opened;
  const mux = createLiveMux(noise);
  const channel = openLiveChannel(mux);
  return { channel, socket };
}

describe("Protomux relay", () => {
  it("forwards a batch from one encrypted peer to another", async () => {
    const core = new RelayCore({
      batchIntervalMs: 0,
      maxBatchBytes: 64 * 1024,
      historyBatches: 0,
      log,
    });
    cleanups.push(() => core.stop());

    const server = net.createServer((socket) => {
      const noise = new NoiseSecretStream(false, socket);
      const mux = createLiveMux(noise);
      const channel = openLiveChannel(mux);
      core.addPeer(`peer-${Math.random()}`, channel);
      socket.once("close", () => channel.close());
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

    const sender = await createClient(port);
    const receiver = await createClient(port);
    cleanups.push(() => {
      sender.socket.destroy();
      receiver.socket.destroy();
    });

    const received = new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("receiver did not get the batch")),
        5000,
      );
      receiver.channel.onMessage((data) => {
        clearTimeout(timer);
        resolve(data);
      });
    });

    // Let the SecretStream and Protomux channels pair.
    await wait(250);

    expect(core.peerCount).toBe(2);
    sender.channel.send(Buffer.from("hello-from-a"));

    expect((await received).toString()).toBe("hello-from-a");
  });
});
