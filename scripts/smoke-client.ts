import Hyperswarm from "hyperswarm";
import { randomUUID } from "node:crypto";
import { generateIdentity } from "../src/identity.js";
import { encodeLiveMessage } from "../src/live/message.js";
import { createLiveMux, openLiveChannel } from "../src/live/protocol.js";
import { networkTopic } from "../src/live/topic.js";

const args = process.argv.slice(2);
const listen = args.includes("--listen");
const network =
  args.find((argument) => !argument.startsWith("--")) ??
  "signalk-p2p/all-vessels/v1";
const topic = networkTopic(network);
const message = Buffer.from(`smoke-${randomUUID()}`);
const identity = generateIdentity();
const liveMessage = encodeLiveMessage(
  {
    sourceKey: identity.publicKeyRaw,
    selfId: `urn:mrn:signalk:uuid:${randomUUID()}`,
    records: [message],
  },
  { sign: (data) => identity.sign(data) },
);

const swarm = new Hyperswarm();
let timer: ReturnType<typeof setTimeout> | undefined;
let done = false;
let receivedAny = false;

async function shutdown(code: number): Promise<void> {
  if (done) return;
  done = true;
  if (timer) clearTimeout(timer);
  await swarm.destroy();
  process.exit(code);
}

swarm.on("error", (error: Error) => {
  console.error("swarm error:", error.message);
});

swarm.on("connection", (connection) => {
  const mux = createLiveMux(connection);
  const channel = openLiveChannel(mux);

  channel.onMessage((data) => {
    receivedAny = true;
    if (listen) {
      console.log(
        `received ${data.length} bytes: ` +
          data
            .toString("utf8")
            .replace(/[^\x20-\x7e]/g, ".")
            .slice(0, 80),
      );
      void shutdown(0);
      return;
    }
    if (data.includes(message)) {
      console.log(`received relay echo (${data.length} bytes)`);
      void shutdown(0);
    }
  });

  if (!listen) {
    // Give the remote channel a moment to pair, then publish.
    setTimeout(() => {
      if (!done) {
        console.log("sending smoke message through the relay");
        channel.send(liveMessage);
      }
    }, 500);
  }
});

const discovery = swarm.join(topic, { server: false, client: true });
await discovery.flushed();
console.log(
  `${listen ? "listening on" : "joined"} ${network} ` +
    `(${topic.toString("hex").slice(0, 16)}…); ` +
    `waiting up to ${listen ? 20 : 30}s`,
);

timer = setTimeout(
  () => {
    if (listen && receivedAny) {
      void shutdown(0);
      return;
    }
    console.error("timeout: no relay responded (UDP/DHT may be blocked here)");
    void shutdown(1);
  },
  listen ? 20_000 : 30_000,
);
