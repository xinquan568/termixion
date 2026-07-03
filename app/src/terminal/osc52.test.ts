// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-64 (test-first): OSC 52 app-driven clipboard, exercised against a REAL emulator
// (@xterm/headless) — we write actual escape sequences, not calls into a fake parser. The security
// invariant under test is WRITE-ONLY: a program running in the terminal may SET the clipboard
// (tmux / nvim yank), but a query (`Pd === "?"`) must be consumed without an answer — answering
// would let any program that can print an escape sequence read the user's clipboard.
import { describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/headless";
import { attachOsc52, realWriteClipboard } from "./osc52";

const BEL = "\x07";
const ST = "\x1b\\";
const HELLO_B64 = "aGVsbG8="; // base64("hello")

function writeSeq(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

async function withTerminal(run: (term: Terminal) => Promise<void>): Promise<void> {
  const term = new Terminal({ allowProposedApi: true });
  try {
    await run(term);
  } finally {
    term.dispose();
  }
}

describe("attachOsc52", () => {
  it("writes the decoded payload for a BEL-terminated set request", async () => {
    await withTerminal(async (term) => {
      const writeClipboard = vi.fn();
      attachOsc52(term, writeClipboard);
      await writeSeq(term, `\x1b]52;c;${HELLO_B64}${BEL}`);
      expect(writeClipboard).toHaveBeenCalledTimes(1);
      expect(writeClipboard).toHaveBeenCalledWith("hello");
    });
  });

  it("accepts the ST terminator too", async () => {
    await withTerminal(async (term) => {
      const writeClipboard = vi.fn();
      attachOsc52(term, writeClipboard);
      await writeSeq(term, `\x1b]52;c;${HELLO_B64}${ST}`);
      expect(writeClipboard).toHaveBeenCalledTimes(1);
      expect(writeClipboard).toHaveBeenCalledWith("hello");
    });
  });

  it("ignores the selection parameter: an empty Pc still writes", async () => {
    await withTerminal(async (term) => {
      const writeClipboard = vi.fn();
      attachOsc52(term, writeClipboard);
      await writeSeq(term, `\x1b]52;;${HELLO_B64}${BEL}`);
      expect(writeClipboard).toHaveBeenCalledWith("hello");
    });
  });

  it("decodes multi-byte UTF-8 through the byte path (atob is latin1)", async () => {
    await withTerminal(async (term) => {
      const writeClipboard = vi.fn();
      attachOsc52(term, writeClipboard);
      const b64 = btoa(String.fromCharCode(...new TextEncoder().encode("héllo — 你好")));
      await writeSeq(term, `\x1b]52;c;${b64}${BEL}`);
      expect(writeClipboard).toHaveBeenCalledWith("héllo — 你好");
    });
  });

  it("consumes a query without answering it (WRITE-ONLY invariant)", async () => {
    await withTerminal(async (term) => {
      const writeClipboard = vi.fn();
      const emitted: string[] = [];
      term.onData((d) => emitted.push(d)); // recorder subscribed BEFORE the query is written
      attachOsc52(term, writeClipboard);
      await writeSeq(term, `\x1b]52;c;?${BEL}`);
      expect(writeClipboard).not.toHaveBeenCalled();
      expect(emitted).toEqual([]); // no OSC 52 response — nothing at all — went back to the app
    });
  });

  it("drops an invalid base64 payload without throwing", async () => {
    await withTerminal(async (term) => {
      const writeClipboard = vi.fn();
      attachOsc52(term, writeClipboard);
      await writeSeq(term, `\x1b]52;c;%%not-base64%%${BEL}`);
      expect(writeClipboard).not.toHaveBeenCalled();
    });
  });

  it("drops a payload over 1 MiB before decoding", async () => {
    await withTerminal(async (term) => {
      const writeClipboard = vi.fn();
      attachOsc52(term, writeClipboard);
      // Valid base64 (would decode fine), rejected purely by the pre-decode length guard.
      const oversized = "A".repeat(1024 * 1024 + 4);
      await writeSeq(term, `\x1b]52;c;${oversized}${BEL}`);
      expect(writeClipboard).not.toHaveBeenCalled();
    });
  });

  it("stops handling OSC 52 after the returned teardown runs", async () => {
    await withTerminal(async (term) => {
      const writeClipboard = vi.fn();
      const detach = attachOsc52(term, writeClipboard);
      await writeSeq(term, `\x1b]52;c;${HELLO_B64}${BEL}`);
      expect(writeClipboard).toHaveBeenCalledTimes(1);
      detach();
      await writeSeq(term, `\x1b]52;c;${HELLO_B64}${BEL}`);
      expect(writeClipboard).toHaveBeenCalledTimes(1); // unchanged — handler is gone
    });
  });
});

describe("realWriteClipboard", () => {
  it("does not throw in jsdom, where navigator.clipboard is absent", () => {
    expect(navigator.clipboard).toBeUndefined(); // jsdom precondition this case relies on
    expect(() => realWriteClipboard("hello")).not.toThrow();
  });

  it("swallows a rejecting Clipboard API instead of surfacing it", async () => {
    const writeText = vi.fn(() => Promise.reject(new Error("denied")));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      expect(() => realWriteClipboard("hello")).not.toThrow();
      expect(writeText).toHaveBeenCalledWith("hello");
      // Let the rejection settle: an unswallowed one would surface as an unhandled error here.
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });
});
