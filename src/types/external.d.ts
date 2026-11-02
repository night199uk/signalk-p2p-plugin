declare module "protomux" {
  import type { Duplex } from "node:stream";

  export interface ProtomuxMessage {
    send(data: Uint8Array): boolean;
  }

  export interface ProtomuxChannel {
    addMessage(options: {
      encoding?: unknown;
      onmessage?: (data: unknown) => void;
      autoBatch?: boolean;
    }): ProtomuxMessage;
    open(handshake?: Uint8Array): void;
    close(): void;
  }

  export default class Protomux {
    constructor(stream: Duplex);
    createChannel(options: {
      protocol: string;
      id?: Uint8Array | null;
      unique?: boolean;
      messages?: unknown[];
      onopen?: () => void;
      onclose?: () => void;
      ondestroy?: () => void;
      ondrain?: () => void;
    }): ProtomuxChannel | null;
  }
}

declare module "hyperswarm" {
  import { EventEmitter } from "node:events";

  export interface HyperswarmDiscovery {
    flushed(): Promise<void>;
    destroy(): Promise<void>;
  }

  export interface HyperswarmOptions {
    bootstrap?: unknown[];
    dht?: unknown;
    port?: number;
    maxPeers?: number;
  }

  export default class Hyperswarm extends EventEmitter {
    constructor(options?: HyperswarmOptions);
    readonly keyPair: { publicKey: Buffer; secretKey: Buffer };
    readonly peers: Set<unknown>;
    join(
      topic: Buffer,
      options?: { server?: boolean; client?: boolean },
    ): HyperswarmDiscovery;
    leave(topic: Buffer): Promise<void>;
    destroy(): Promise<void>;
  }
}

declare module "sodium-universal" {
  interface Sodium {
    crypto_box_PUBLICKEYBYTES: number;
    crypto_box_SECRETKEYBYTES: number;
    crypto_box_SEALBYTES: number;
    crypto_box_SEEDBYTES: number;
    crypto_box_keypair(publicKey: Uint8Array, secretKey: Uint8Array): void;
    crypto_box_seed_keypair(
      publicKey: Uint8Array,
      secretKey: Uint8Array,
      seed: Uint8Array,
    ): void;
    crypto_box_seal(
      ciphertext: Uint8Array,
      message: Uint8Array,
      recipientPublicKey: Uint8Array,
    ): void;
    crypto_box_seal_open(
      message: Uint8Array,
      ciphertext: Uint8Array,
      recipientPublicKey: Uint8Array,
      recipientSecretKey: Uint8Array,
    ): boolean;
  }
  const sodium: Sodium;
  export default sodium;
}
