// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-44 (test-first): the display chokepoint. It is not enough to test the pure option value — we must
// prove that `realDeps.createTerminal` (the one place xterm is constructed) actually feeds those iTerm2
// options into `new Terminal` and selects the palette from the system appearance. We mock the xterm
// classes so the constructor is a spy, stub `matchMedia`, and assert the captured constructor argument.
import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted by Vitest above the imports below, so `realDeps` sees these mocks at module load.
vi.mock("@xterm/xterm", () => ({ Terminal: vi.fn() }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: vi.fn() }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: vi.fn() }));

import { Terminal } from "@xterm/xterm";
import { realDeps } from "./TerminalView";
import { iterm2TerminalOptions } from "./iterm2Theme";

const TRMX51_CURSOR = { cursorStyle: "underline", cursorBlink: true } as const;

function stubMatchMedia(prefersDark: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: query.includes("dark") ? prefersDark : false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

describe("realDeps.createTerminal (the display chokepoint)", () => {
  beforeEach(() => {
    vi.mocked(Terminal).mockClear();
  });

  it("constructs xterm with the iTerm2 DARK options plus the trmx-51 cursor when the system prefers dark", () => {
    stubMatchMedia(true);
    realDeps.createTerminal();
    expect(Terminal).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Terminal).mock.calls[0][0]).toEqual({
      ...iterm2TerminalOptions("dark"),
      ...TRMX51_CURSOR,
    });
  });

  it("constructs xterm with the iTerm2 LIGHT options plus the trmx-51 cursor when the system prefers light", () => {
    stubMatchMedia(false);
    realDeps.createTerminal();
    expect(vi.mocked(Terminal).mock.calls[0][0]).toEqual({
      ...iterm2TerminalOptions("light"),
      ...TRMX51_CURSOR,
    });
  });

  it("no longer uses the bare xterm defaults, and the trmx-51 cursor supersedes the iTerm2 one", () => {
    stubMatchMedia(true);
    realDeps.createTerminal();
    const opts = vi.mocked(Terminal).mock.calls[0][0];
    expect(opts?.fontFamily).not.toBe("monospace");
    // trmx-44 pinned block/non-blinking (iTerm2 parity); trmx-51 consciously supersedes it.
    expect(opts?.cursorStyle).toBe("underline");
    expect(opts?.cursorBlink).toBe(true);
  });

  it("persisted cursor settings override the defaults at the chokepoint", () => {
    stubMatchMedia(true);
    localStorage.setItem("termixion.terminal.cursorStyle", "block");
    localStorage.setItem("termixion.terminal.cursorBlink", "false");
    try {
      realDeps.createTerminal();
      const opts = vi.mocked(Terminal).mock.calls[0][0];
      expect(opts?.cursorStyle).toBe("block");
      expect(opts?.cursorBlink).toBe(false);
    } finally {
      localStorage.removeItem("termixion.terminal.cursorStyle");
      localStorage.removeItem("termixion.terminal.cursorBlink");
    }
  });
});
