// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-64: OSC 7 working-directory retention, tested against the real emulator (R8: tests first).
// A real @xterm/headless Terminal parses genuine escape sequences, so these tests cover the whole
// path: raw bytes in → xterm's OSC dispatch → our handler → the retained cwd. Retention only —
// nothing here renders; the value is consumed by later new-tab-inherits-cwd work (v0.0.3+).
import { afterEach, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/headless";
import { attachOsc7, currentCwd, makeCwdStore } from "./osc7";

const terminals: Terminal[] = [];

afterEach(() => {
  for (const terminal of terminals.splice(0)) terminal.dispose();
});

/** A real headless emulator; `parser` is proposed API, so it must be allowed explicitly. */
function makeTerminal(): Terminal {
  const terminal = new Terminal({ allowProposedApi: true });
  terminals.push(terminal);
  return terminal;
}

/** Feed a raw byte sequence and wait for xterm's asynchronous write buffer to finish parsing it. */
function feed(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

describe("attachOsc7", () => {
  it("retains the path of a BEL-terminated file:// report (hostname ignored)", async () => {
    const terminal = makeTerminal();
    const store = makeCwdStore();
    attachOsc7(terminal, store);
    expect(store.get()).toBeNull();
    await feed(terminal, "\x1b]7;file://Mac.local/Users/me/project\x07");
    expect(store.get()).toBe("/Users/me/project");
  });

  it("decodes percent-encoded characters in the path", async () => {
    const terminal = makeTerminal();
    const store = makeCwdStore();
    attachOsc7(terminal, store);
    await feed(terminal, "\x1b]7;file://Mac.local/Users/me/My%20Dir\x07");
    expect(store.get()).toBe("/Users/me/My Dir");
  });

  it("accepts the ST-terminated variant", async () => {
    const terminal = makeTerminal();
    const store = makeCwdStore();
    attachOsc7(terminal, store);
    await feed(terminal, "\x1b]7;file://Mac.local/Users/me/st-dir\x1b\\");
    expect(store.get()).toBe("/Users/me/st-dir");
  });

  it("consumes a junk payload without touching the retained value", async () => {
    const terminal = makeTerminal();
    const store = makeCwdStore();
    attachOsc7(terminal, store);
    await feed(terminal, "\x1b]7;file://Mac.local/Users/me/kept\x07");
    await feed(terminal, "\x1b]7;not-a-url\x07");
    expect(store.get()).toBe("/Users/me/kept");
  });

  it("ignores non-file schemes", async () => {
    const terminal = makeTerminal();
    const store = makeCwdStore();
    attachOsc7(terminal, store);
    await feed(terminal, "\x1b]7;file://Mac.local/Users/me/kept\x07");
    await feed(terminal, "\x1b]7;https://x/y\x07");
    expect(store.get()).toBe("/Users/me/kept");
  });

  it("the latest report wins (an empty hostname is valid too)", async () => {
    const terminal = makeTerminal();
    const store = makeCwdStore();
    attachOsc7(terminal, store);
    await feed(terminal, "\x1b]7;file://Mac.local/Users/me/first\x07");
    await feed(terminal, "\x1b]7;file:///Users/me/second\x07");
    expect(store.get()).toBe("/Users/me/second");
  });

  it("teardown stops updates", async () => {
    const terminal = makeTerminal();
    const store = makeCwdStore();
    const detach = attachOsc7(terminal, store);
    await feed(terminal, "\x1b]7;file://Mac.local/Users/me/kept\x07");
    detach();
    await feed(terminal, "\x1b]7;file://Mac.local/Users/me/after-detach\x07");
    expect(store.get()).toBe("/Users/me/kept");
  });
});

describe("module-default store", () => {
  it("currentCwd() reads what attachOsc7 retained when no store is passed", async () => {
    const terminal = makeTerminal();
    const detach = attachOsc7(terminal);
    await feed(terminal, "\x1b]7;file://Mac.local/Users/me/default-store\x07");
    expect(currentCwd()).toBe("/Users/me/default-store");
    detach();
  });
});
