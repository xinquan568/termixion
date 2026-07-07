// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-145 (test-first): the ONE native clipboard write sink. The bug: WKWebView's own pasteboard
// writes (clipboardData.setData / navigator.clipboard.writeText) reach other apps with the UTF-8
// bytes re-decoded as Mac OS Roman ("—" pastes as "‚Äî"), so every copy path must instead write over
// Tauri IPC via the clipboard-manager plugin. These tests pin the sink's contract: exact-string
// delegation to the plugin, both failure tolerances (rejection AND synchronous throw — the plugin
// module throws synchronously when there is no Tauri runtime at all), and the identity invariant
// that `realWriteClipboard` — the sink OSC 52, auto-copy-on-select, and the ⌘C guard all share —
// IS this function (one sink, not three lookalikes; the trmx-95 byte-identical guarantee now
// includes the write, not just the extraction).
import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted above the imports (realDeps.test.ts pattern) so nativeClipboard sees the mock at load.
const writeTextMock = vi.hoisted(() => vi.fn<(text: string) => Promise<void>>());
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: writeTextMock }));

import { writeClipboardText } from "./nativeClipboard";
import { realWriteClipboard } from "./osc52";
import { realAttachClipboard } from "./TerminalView";

beforeEach(() => {
  writeTextMock.mockReset();
  writeTextMock.mockResolvedValue(undefined);
});

describe("writeClipboardText (the native IPC sink)", () => {
  it("delegates the exact string to the plugin's writeText", () => {
    writeClipboardText("héllo — 你好 🚀");
    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(writeTextMock).toHaveBeenCalledWith("héllo — 你好 🚀");
  });

  it("swallows a rejected write instead of surfacing it", async () => {
    writeTextMock.mockRejectedValue(new Error("denied"));
    expect(() => writeClipboardText("x")).not.toThrow();
    // Let the rejection settle: an unswallowed one would surface as an unhandled error here.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("swallows a synchronous throw (no Tauri runtime) — the no-runtime tolerance contract", () => {
    writeTextMock.mockImplementation(() => {
      throw new Error("window.__TAURI_INTERNALS__ is undefined");
    });
    expect(() => writeClipboardText("x")).not.toThrow();
  });
});

describe("one-sink identity (trmx-95 invariant, write side)", () => {
  it("realWriteClipboard IS writeClipboardText — OSC 52, auto-copy, and ⌘C share the object", () => {
    expect(realWriteClipboard).toBe(writeClipboardText);
  });

  it("production ⌘C wiring: TerminalView's realAttachClipboard drives the native plugin write", () => {
    // The REAL attach seam TerminalView mounts (not an injected spy): a copy event through
    // realAttachClipboard must land in the plugin IPC — pinning that the guard's default sink is
    // the native write in the exact wiring production uses (step-8 finding 1).
    const host = document.createElement("div");
    document.body.appendChild(host);
    const term = { hasSelection: () => true, getSelection: () => "wired-sel", paste: () => {} };
    const dispose = realAttachClipboard(
      host,
      term as unknown as Parameters<typeof realAttachClipboard>[1],
    );
    writeTextMock.mockClear();
    const ev = new Event("copy", { bubbles: true, cancelable: true }) as Event & {
      clipboardData: { getData: (t: string) => string; setData: (t: string, v: string) => void };
    };
    ev.clipboardData = { getData: () => "", setData: () => {} };
    host.dispatchEvent(ev);
    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(writeTextMock).toHaveBeenCalledWith("wired-sel");
    dispose();
    host.remove();
  });
});
