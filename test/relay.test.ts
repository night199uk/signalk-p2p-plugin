import { describe, expect, it } from "vitest";
import type { LiveChannel } from "../src/live/protocol.js";
import {
  RelayCore,
  type RelayCoreOptions,
  type RelayLogger,
} from "../src/live/relay.js";

class FakeChannel implements LiveChannel {
  readonly sent: Buffer[] = [];
  private handler?: (data: Buffer) => void;

  send(data: Buffer): void {
    this.sent.push(Buffer.from(data));
  }

  close(): void {
    // nothing
  }

  onMessage(handler: (data: Buffer) => void): void {
    this.handler = handler;
  }

  receive(data: Buffer): void {
    this.handler?.(data);
  }
}

const log: RelayLogger = {
  info() {},
  error() {},
  debug() {},
};

function makeCore(options: RelayCoreOptions = {}): RelayCore {
  return new RelayCore({
    batchIntervalMs: 0,
    maxBatchBytes: 1024,
    historyBatches: 2,
    log,
    ...options,
  });
}

describe("RelayCore", () => {
  it("forwards a batch to the other peers", () => {
    const core = makeCore();
    const a = new FakeChannel();
    const b = new FakeChannel();
    core.addPeer("a", a);
    core.addPeer("b", b);

    a.receive(Buffer.from("hello"));

    expect(b.sent.map(String)).toContain("hello");
    core.stop();
  });

  it("coalesces queued messages into one forwarded batch", () => {
    const core = makeCore({ batchIntervalMs: 60_000 });
    const a = new FakeChannel();
    const b = new FakeChannel();
    core.addPeer("a", a);
    core.addPeer("b", b);

    a.receive(Buffer.from("one"));
    a.receive(Buffer.from("two"));
    expect(b.sent).toHaveLength(0);

    core.flush();
    expect(b.sent).toHaveLength(1);
    expect(b.sent[0].toString()).toBe("onetwo");
    core.stop();
  });

  it("replays recent history to a late peer", () => {
    const core = makeCore();
    const a = new FakeChannel();
    core.addPeer("a", a);

    a.receive(Buffer.from("first"));
    a.receive(Buffer.from("second"));

    const c = new FakeChannel();
    core.addPeer("c", c);
    expect(c.sent.map(String)).toEqual(["first", "second"]);
    core.stop();
  });

  it("stops forwarding when it is not the elected aggregator", () => {
    const core = makeCore();
    const a = new FakeChannel();
    const b = new FakeChannel();
    core.addPeer("a", a);
    core.addPeer("b", b);

    core.setForwarding(false);
    a.receive(Buffer.from("while-disabled"));
    expect(b.sent).toHaveLength(0);

    core.setForwarding(true);
    a.receive(Buffer.from("while-enabled"));
    expect(b.sent.map(String)).toContain("while-enabled");
    core.stop();
  });

  it("deduplicates identical batches", () => {
    const core = makeCore();
    const a = new FakeChannel();
    const b = new FakeChannel();
    core.addPeer("a", a);
    core.addPeer("b", b);

    a.receive(Buffer.from("same"));
    a.receive(Buffer.from("same"));
    expect(b.sent.map(String)).toEqual(["same"]);
    core.stop();
  });

  it("drops a batch over the size limit", () => {
    const core = makeCore({ maxBatchBytes: 4 });
    const a = new FakeChannel();
    const b = new FakeChannel();
    core.addPeer("a", a);
    core.addPeer("b", b);

    a.receive(Buffer.from("too large"));
    expect(b.sent).toHaveLength(0);
    core.stop();
  });
});
