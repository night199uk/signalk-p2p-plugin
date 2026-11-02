import { buffer as bufferCodec } from "compact-encoding";
import Protomux from "protomux";
import type { Duplex } from "node:stream";

/**
 * The live channel carries opaque batches of envelopes. A relay does not need
 * to understand the records, so it can forward signed data without the ability
 * to forge it.
 */
export const LIVE_PROTOCOL = "signalk-p2p/live/1";

export interface LiveChannel {
  send(data: Buffer): void;
  close(): void;
  onMessage(handler: (data: Buffer) => void): void;
}

export function createLiveMux(stream: Duplex): Protomux {
  return new Protomux(stream);
}

export function openLiveChannel(mux: Protomux): LiveChannel {
  let handler: ((data: Buffer) => void) | undefined;

  const channel = mux.createChannel({ protocol: LIVE_PROTOCOL });
  if (!channel) {
    throw new Error("live: could not open channel");
  }

  const message = channel.addMessage({
    encoding: bufferCodec,
    onmessage: (data: unknown) => {
      if (data instanceof Uint8Array) {
        handler?.(Buffer.from(data));
      }
    },
  });

  channel.open();

  return {
    send: (data: Buffer) => {
      message.send(data);
    },
    close: () => {
      channel.close();
    },
    onMessage: (next: (data: Buffer) => void) => {
      handler = next;
    },
  };
}
