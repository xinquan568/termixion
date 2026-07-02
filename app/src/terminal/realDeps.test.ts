// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-44/trmx-53 (test-first): the display chokepoint. It is not enough to test the pure option
// values — we must prove that `realDeps.createTerminal` (the one place xterm is constructed)
// actually feeds them into `new Terminal`. Since trmx-53 the COLORS come from the theme catalog
// (the persisted appearance.theme, first-run-derived from the OS: dark → Night, light → White),
// overlaying iTerm2's non-color profile facts (font/spacing, trmx-44/46) and the trmx-51 cursor.
// We mock the xterm classes so the constructor is a spy, stub `matchMedia`, and assert the
// captured constructor argument.
import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted by Vitest above the imports below, so `realDeps` sees these mocks at module load.
vi.mock("@xterm/xterm", () => ({ Terminal: vi.fn() }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: vi.fn() }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: vi.fn() }));

import { Terminal } from "@xterm/xterm";
import { realDeps } from "./TerminalView";
import { iterm2TerminalOptions } from "./iterm2Theme";
import { buildXtermTheme } from "../theme/buildXtermTheme";

// The registry cursor defaults: trmx-51's underline, with blink turned off by trmx-55 (iTerm2
// parity — only the style still supersedes the iTerm2 block cursor).
const TRMX51_CURSOR = { cursorStyle: "underline", cursorBlink: false } as const;

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
    // The first-run derivation MATERIALIZES (trmx-53): each test must start unpersisted, or a
    // prior test's derived value would shadow this test's stubbed OS appearance.
    localStorage.removeItem("termixion.appearance.theme");
  });

  it("constructs xterm with the NIGHT catalog theme (first-run derivation) when the system prefers dark", () => {
    stubMatchMedia(true);
    realDeps.createTerminal();
    expect(Terminal).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Terminal).mock.calls[0][0]).toEqual({
      ...iterm2TerminalOptions("dark"),
      theme: buildXtermTheme("night"),
      ...TRMX51_CURSOR,
    });
  });

  it("constructs xterm with the WHITE catalog theme (first-run derivation) when the system prefers light", () => {
    stubMatchMedia(false);
    realDeps.createTerminal();
    expect(vi.mocked(Terminal).mock.calls[0][0]).toEqual({
      ...iterm2TerminalOptions("light"),
      theme: buildXtermTheme("white"),
      ...TRMX51_CURSOR,
    });
  });

  it("uses the PERSISTED theme regardless of the OS appearance (no live OS-following, trmx-53)", () => {
    stubMatchMedia(true);
    localStorage.setItem("termixion.appearance.theme", "sepia");
    try {
      realDeps.createTerminal();
      const opts = vi.mocked(Terminal).mock.calls[0][0];
      expect(opts?.theme).toEqual(buildXtermTheme("sepia"));
    } finally {
      localStorage.removeItem("termixion.appearance.theme");
    }
  });

  it("keeps the iTerm2 non-color profile facts and the trmx-51 cursor at the chokepoint", () => {
    stubMatchMedia(true);
    realDeps.createTerminal();
    const opts = vi.mocked(Terminal).mock.calls[0][0];
    expect(opts?.fontFamily).not.toBe("monospace");
    expect(opts?.fontSize).toBe(iterm2TerminalOptions("dark").fontSize);
    // trmx-44 pinned block/non-blinking (iTerm2 parity); trmx-51 superseded the style, and trmx-55
    // realigned blink with iTerm2 — so only the underline style still diverges.
    expect(opts?.cursorStyle).toBe("underline");
    expect(opts?.cursorBlink).toBe(false);
  });

  it("persisted cursor settings override the defaults at the chokepoint", () => {
    stubMatchMedia(true);
    localStorage.setItem("termixion.terminal.cursorStyle", "block");
    localStorage.setItem("termixion.terminal.cursorBlink", "true");
    try {
      realDeps.createTerminal();
      const opts = vi.mocked(Terminal).mock.calls[0][0];
      expect(opts?.cursorStyle).toBe("block");
      expect(opts?.cursorBlink).toBe(true);
    } finally {
      localStorage.removeItem("termixion.terminal.cursorStyle");
      localStorage.removeItem("termixion.terminal.cursorBlink");
    }
  });
});
