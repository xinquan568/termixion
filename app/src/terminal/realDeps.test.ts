// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-44/trmx-53 (test-first): the display chokepoint. It is not enough to test the pure option
// values — we must prove that `realDeps.createTerminal` (the one place xterm is constructed)
// actually feeds them into `new Terminal`. Since trmx-53 the COLORS come from the theme catalog
// (the persisted appearance.theme, first-run-derived from the OS: dark → Night, light → Catppuccin Latte),
// overlaying iTerm2's non-color profile facts (font/spacing, trmx-44/46) and the trmx-51 cursor.
// trmx-80 (FR-13): settings are file-backed — persisted values are seeded through
// hydrateSettings into the SHARED SNAPSHOT (no more localStorage), and the scrollback + font
// slices are settings-fed at this same chokepoint. We mock the xterm classes so the constructor
// is a spy, stub `matchMedia`, and assert the captured constructor argument.
import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted by Vitest above the imports below, so `realDeps` sees these mocks at module load.
// trmx-97: each `new Terminal()` returns a fresh instance carrying `loadAddon` + `unicode` so the
// graphemes-addon activation inside createTerminal can be asserted (a bare vi.fn() returns {}, so
// `term.loadAddon`/`term.unicode` would be undefined and activation would throw).
vi.mock("@xterm/xterm", () => ({
  // A regular function (not an arrow) so `new Terminal(...)` constructs; returning the object makes
  // `new` yield it, giving each terminal its own loadAddon spy + unicode slot.
  Terminal: vi.fn(function () {
    return { loadAddon: vi.fn(), unicode: { activeVersion: "" } };
  }),
}));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: vi.fn() }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: vi.fn() }));
vi.mock("@xterm/addon-unicode-graphemes", () => ({ UnicodeGraphemesAddon: vi.fn() }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: vi.fn() }));

import { Terminal } from "@xterm/xterm";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { GRAPHEMES_VERSION } from "./unicodeGraphemes";
import { realDeps } from "./TerminalView";
import { iterm2TerminalOptions } from "./iterm2Theme";
import { emulationTerminalOptions } from "./emulationOptions";
import { scrollbackTerminalOptions } from "./scrollbackSettings";
import { fontTerminalOptions } from "./fontSettings";
import { clipboardTerminalOptions } from "./clipboard";
import { buildXtermTheme } from "../theme/buildXtermTheme";
import { hydrateSettings, makeSettingsStore, __resetSettingsForTest } from "../settings/settingsStore";

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

/** Seed the shared settings snapshot the way boot() does: one faked config_read (trmx-80). */
async function seedSettings(values: Record<string, unknown>): Promise<void> {
  await hydrateSettings({
    invoke: (cmd) =>
      cmd === "config_read"
        ? Promise.resolve({ exists: true, path: "/tmp/config.toml", values, warnings: [] })
        : Promise.resolve(null),
    bus: { listen: () => Promise.resolve(() => {}) },
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
}

describe("realDeps.createTerminal (the display chokepoint)", () => {
  beforeEach(() => {
    vi.mocked(Terminal).mockClear();
    vi.mocked(UnicodeGraphemesAddon).mockClear(); // trmx-97: addon-activation counts are per-test
    // Each test starts from an EMPTY shared snapshot (trmx-80), or a prior test's seeded values
    // would shadow this test's stubbed OS appearance / seeded settings.
    __resetSettingsForTest();
  });

  it("constructs xterm with the NIGHT catalog theme (first-run derivation) when the system prefers dark", () => {
    stubMatchMedia(true);
    realDeps.createTerminal();
    const defaults = makeSettingsStore(); // unseeded snapshot store — the registry defaults
    expect(Terminal).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Terminal).mock.calls[0][0]).toEqual({
      ...iterm2TerminalOptions("dark"),
      theme: buildXtermTheme("night"),
      ...fontTerminalOptions(defaults),
      ...TRMX51_CURSOR,
      ...scrollbackTerminalOptions(defaults),
      ...emulationTerminalOptions(),
      ...clipboardTerminalOptions(),
      linkHandler: expect.anything(),
    });
  });

  it("constructs xterm with the CATPPUCCIN LATTE catalog theme (first-run derivation, trmx-202) when the system prefers light", () => {
    stubMatchMedia(false);
    realDeps.createTerminal();
    const defaults = makeSettingsStore();
    expect(vi.mocked(Terminal).mock.calls[0][0]).toEqual({
      ...iterm2TerminalOptions("light"),
      theme: buildXtermTheme("catppuccin-latte"),
      ...fontTerminalOptions(defaults),
      ...TRMX51_CURSOR,
      ...scrollbackTerminalOptions(defaults),
      ...emulationTerminalOptions(),
      ...clipboardTerminalOptions(),
      linkHandler: expect.anything(),
    });
  });

  it("activates the grapheme-cluster Unicode addon at construction (correct CJK/emoji widths, trmx-97)", () => {
    stubMatchMedia(true);
    realDeps.createTerminal();
    const term = vi.mocked(Terminal).mock.results[0]?.value as {
      loadAddon: ReturnType<typeof vi.fn>;
      unicode: { activeVersion: string };
    };
    expect(vi.mocked(UnicodeGraphemesAddon)).toHaveBeenCalledTimes(1); // the addon was instantiated
    const addonInstance = vi.mocked(UnicodeGraphemesAddon).mock.instances[0];
    expect(term.loadAddon).toHaveBeenCalledTimes(1);
    expect(term.loadAddon).toHaveBeenCalledWith(addonInstance); // THAT instance was loaded onto THIS terminal
    expect(term.unicode.activeVersion).toBe(GRAPHEMES_VERSION); // and made the active Unicode version
  });

  it("uses the PERSISTED theme regardless of the OS appearance (no live OS-following, trmx-53)", async () => {
    stubMatchMedia(true);
    await seedSettings({ "appearance.theme": "solarized" });
    realDeps.createTerminal();
    const opts = vi.mocked(Terminal).mock.calls[0][0];
    expect(opts?.theme).toEqual(buildXtermTheme("solarized"));
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

  it("feeds the emulation slice into xterm: convertEol is FALSE at the chokepoint (trmx-64)", () => {
    // A PTY-backed terminal must not rewrite LF→CRLF inside the emulator: the tty line discipline
    // (ONLCR) owns that conversion in cooked mode, and raw-mode programs (vim, vttest) emit bare LF
    // meaning "index down, keep the column". convertEol:true (the pre-PTY demo leftover) broke
    // that; trmx-64 pins false via the exported emulation slice.
    stubMatchMedia(true);
    realDeps.createTerminal();
    const opts = vi.mocked(Terminal).mock.calls[0][0];
    expect(opts?.convertEol).toBe(false);
    // Round-2 pin: the OSC integrations dereference terminal.parser (proposed API) at mount —
    // without this flag the accessor throws and the app crashes (step-8 blocker).
    expect(opts?.allowProposedApi).toBe(true);
  });

  it("feeds the scrollback slice into xterm: 10k default cap + smooth discrete scrolling (trmx-65)", () => {
    // FR-1.3: the cap is OUR default (not xterm's silent 1000); since trmx-80 it is a SETTING
    // (terminal.scrollbackLines) — the unseeded snapshot serves the registry default here.
    stubMatchMedia(true);
    realDeps.createTerminal();
    const opts = vi.mocked(Terminal).mock.calls[0][0];
    expect(opts?.scrollback).toBe(10_000);
    expect(opts?.smoothScrollDuration).toBe(120);
    // xterm's scroll-on-user-input default (typing snaps to bottom) must not be disabled.
    expect(opts?.scrollOnUserInput).not.toBe(false);
  });

  it("feeds the PERSISTED scrollback + font settings into xterm (trmx-80 FR-13)", async () => {
    stubMatchMedia(true);
    await seedSettings({
      "terminal.scrollbackLines": 5_000,
      "terminal.fontFamily": "JetBrains Mono",
      "terminal.fontSize": 16,
    });
    realDeps.createTerminal();
    const opts = vi.mocked(Terminal).mock.calls[0][0];
    expect(opts?.scrollback).toBe(5_000);
    // The persisted font OVERRIDES the iTerm2 constants (the slice spreads after them).
    expect(opts?.fontFamily).toBe("JetBrains Mono");
    expect(opts?.fontSize).toBe(16);
  });

  it("an EMPTY persisted fontFamily means the platform default stack (trmx-80)", async () => {
    stubMatchMedia(true);
    await seedSettings({ "terminal.fontFamily": "" });
    realDeps.createTerminal();
    const opts = vi.mocked(Terminal).mock.calls[0][0];
    expect(opts?.fontFamily).toBe(iterm2TerminalOptions("dark").fontFamily);
  });

  it("enables Option-drag selection at the chokepoint (trmx-66)", () => {
    // macOptionClickForcesSelection: while a full-screen app owns the mouse (mouse reporting),
    // Option-drag still makes a normal selection — the iTerm2 convention on macOS.
    stubMatchMedia(true);
    realDeps.createTerminal();
    const opts = vi.mocked(Terminal).mock.calls[0][0];
    expect(opts?.macOptionClickForcesSelection).toBe(true);
  });

  it("wires the OSC 8 link policy at the chokepoint (trmx-64)", () => {
    // The policy itself (meta-gating + http/https allowlist) is unit-tested in linkHandler.test.ts;
    // here we pin that the chokepoint actually installs it on the constructed terminal.
    stubMatchMedia(true);
    realDeps.createTerminal();
    const opts = vi.mocked(Terminal).mock.calls[0][0];
    expect(typeof opts?.linkHandler?.activate).toBe("function");
  });

  it("persisted cursor settings override the defaults at the chokepoint", async () => {
    stubMatchMedia(true);
    await seedSettings({ "terminal.cursorStyle": "block", "terminal.cursorBlink": true });
    realDeps.createTerminal();
    const opts = vi.mocked(Terminal).mock.calls[0][0];
    expect(opts?.cursorStyle).toBe("block");
    expect(opts?.cursorBlink).toBe(true);
  });
});
