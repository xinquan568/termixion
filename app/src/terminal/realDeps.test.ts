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

  it("constructs xterm with the iTerm2 DARK options when the system prefers dark", () => {
    stubMatchMedia(true);
    realDeps.createTerminal();
    expect(Terminal).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Terminal).mock.calls[0][0]).toEqual(iterm2TerminalOptions("dark"));
  });

  it("constructs xterm with the iTerm2 LIGHT options when the system prefers light", () => {
    stubMatchMedia(false);
    realDeps.createTerminal();
    expect(vi.mocked(Terminal).mock.calls[0][0]).toEqual(iterm2TerminalOptions("light"));
  });

  it("no longer uses the bare xterm defaults (monospace / blinking cursor)", () => {
    stubMatchMedia(true);
    realDeps.createTerminal();
    const opts = vi.mocked(Terminal).mock.calls[0][0];
    expect(opts?.fontFamily).not.toBe("monospace");
    expect(opts?.cursorBlink).toBe(false);
  });
});
