// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-80 (FR-13): the font slice of the terminal's effective options + the live settings:changed
// application (R8: tests first). Mirrors cursorSettings.test.ts.
import { describe, expect, it } from "vitest";
import { applyFontSettingsChange, fontTerminalOptions, type FontOptionsSink } from "./fontSettings";
import { ITERM2_FONT_FAMILY } from "./iterm2Theme";
import { DEFAULT_FONT_FAMILY } from "./fontCatalog";
import { makeSettingsStore, type KeyValueStore } from "../settings/settingsStore";

function fakeStorage(initial: Record<string, string> = {}): KeyValueStore {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("fontTerminalOptions", () => {
  it("defaults to the bundled SauceCodePro face (trmx-204) with the platform stack as fallback, at 12 pt", () => {
    expect(fontTerminalOptions(makeSettingsStore(fakeStorage()))).toEqual({
      fontFamily: `"${DEFAULT_FONT_FAMILY}", ${ITERM2_FONT_FAMILY}`,
      fontSize: 12,
    });
  });

  it("an explicit '' (System default) still resolves to the platform stack", () => {
    const store = makeSettingsStore(fakeStorage({ "termixion.terminal.fontFamily": "" }));
    expect(fontTerminalOptions(store).fontFamily).toBe(ITERM2_FONT_FAMILY);
  });

  it("treats a whitespace-only family as 'use the platform default stack' too", () => {
    const store = makeSettingsStore(fakeStorage({ "termixion.terminal.fontFamily": "   " }));
    expect(fontTerminalOptions(store).fontFamily).toBe(ITERM2_FONT_FAMILY);
  });

  it("a persisted bundled family composes family-first with the platform stack appended", () => {
    const store = makeSettingsStore(
      fakeStorage({ "termixion.terminal.fontFamily": "MesloLGS NF" }),
    );
    expect(fontTerminalOptions(store).fontFamily).toBe(`"MesloLGS NF", ${ITERM2_FONT_FAMILY}`);
  });

  it("prefers the persisted values (a custom family passes through verbatim)", () => {
    const store = makeSettingsStore(
      fakeStorage({
        "termixion.terminal.fontFamily": "JetBrains Mono",
        "termixion.terminal.fontSize": "16",
      }),
    );
    expect(fontTerminalOptions(store)).toEqual({ fontFamily: "JetBrains Mono", fontSize: 16 });
  });
});

describe("applyFontSettingsChange", () => {
  it("applies fontFamily changes to the live terminal (empty → the platform stack)", () => {
    const terminal: FontOptionsSink = { options: {} };
    expect(
      applyFontSettingsChange(terminal, {
        key: "terminal.fontFamily",
        value: "Fira Code",
        source: "settings",
      }),
    ).toBe(true);
    expect(terminal.options.fontFamily).toBe("Fira Code");
    // A System-default broadcast carries "" — the live terminal reverts to the platform stack.
    expect(
      applyFontSettingsChange(terminal, { key: "terminal.fontFamily", value: "", source: "settings" }),
    ).toBe(true);
    expect(terminal.options.fontFamily).toBe(ITERM2_FONT_FAMILY);
    // A bundled-family broadcast (trmx-204) applies the composed family-first stack.
    expect(
      applyFontSettingsChange(terminal, {
        key: "terminal.fontFamily",
        value: "Hack Nerd Font Mono",
        source: "settings",
      }),
    ).toBe(true);
    expect(terminal.options.fontFamily).toBe(`"Hack Nerd Font Mono", ${ITERM2_FONT_FAMILY}`);
  });

  it("applies fontSize changes, clamped into the registry range (untrusted payloads)", () => {
    const terminal: FontOptionsSink = { options: {} };
    expect(
      applyFontSettingsChange(terminal, { key: "terminal.fontSize", value: 18, source: "settings" }),
    ).toBe(true);
    expect(terminal.options.fontSize).toBe(18);
    expect(
      applyFontSettingsChange(terminal, { key: "terminal.fontSize", value: 999, source: "settings" }),
    ).toBe(true);
    expect(terminal.options.fontSize).toBe(72);
  });

  it("ignores other keys and malformed payloads without touching the terminal", () => {
    const terminal: FontOptionsSink = { options: {} };
    expect(applyFontSettingsChange(terminal, { key: "terminal.cursorBlink", value: true })).toBe(false);
    expect(applyFontSettingsChange(terminal, { key: "terminal.fontFamily", value: 12 })).toBe(false);
    expect(applyFontSettingsChange(terminal, { key: "terminal.fontSize", value: "big" })).toBe(false);
    expect(applyFontSettingsChange(terminal, { key: "terminal.fontSize", value: NaN })).toBe(false);
    // Integers only (trmx-80 review R4): a fractional size never reaches the live terminal.
    expect(applyFontSettingsChange(terminal, { key: "terminal.fontSize", value: 12.5 })).toBe(false);
    expect(applyFontSettingsChange(terminal, null)).toBe(false);
    expect(applyFontSettingsChange(terminal, "junk")).toBe(false);
    expect(terminal.options).toEqual({});
  });
});
