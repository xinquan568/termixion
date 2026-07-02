// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53 (test-first): the theme slice of the terminal's effective options — construction from
// the persisted setting, and live application of settings:changed broadcasts. Events are
// untrusted input: junk must be inert (same discipline as cursorSettings).
import { describe, expect, it } from "vitest";
import { buildXtermTheme } from "../theme/buildXtermTheme";
import { makeSettingsStore, type KeyValueStore } from "../settings/settingsStore";
import { applyThemeSettingsChange, themeTerminalOptions, type ThemeOptionsSink } from "./themeSettings";

function fakeStorage(initial: Record<string, string> = {}): KeyValueStore {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("themeTerminalOptions", () => {
  it("builds the xterm theme from the persisted setting", () => {
    const settings = makeSettingsStore(fakeStorage({ "termixion.appearance.theme": "sepia" }));
    expect(themeTerminalOptions(settings)).toEqual({ theme: buildXtermTheme("sepia") });
  });

  it("falls back to the derived default when nothing is persisted (jsdom → night)", () => {
    const settings = makeSettingsStore(fakeStorage());
    expect(themeTerminalOptions(settings)).toEqual({ theme: buildXtermTheme("night") });
  });
});

describe("applyThemeSettingsChange", () => {
  const sink = (): ThemeOptionsSink => ({ options: {} });

  it("applies a valid appearance.theme payload wholesale and returns the id", () => {
    const terminal = sink();
    const applied = applyThemeSettingsChange(terminal, {
      key: "appearance.theme",
      value: "solarized",
      source: "settings",
    });
    expect(applied).toBe("solarized");
    expect(terminal.options.theme).toEqual(buildXtermTheme("solarized"));
  });

  it("ignores other settings keys", () => {
    const terminal = sink();
    expect(
      applyThemeSettingsChange(terminal, { key: "terminal.cursorBlink", value: true }),
    ).toBeNull();
    expect(terminal.options.theme).toBeUndefined();
  });

  it("ignores junk values and malformed payloads (untrusted input)", () => {
    const terminal = sink();
    expect(applyThemeSettingsChange(terminal, { key: "appearance.theme", value: "neon" })).toBeNull();
    expect(applyThemeSettingsChange(terminal, { key: "appearance.theme", value: 7 })).toBeNull();
    expect(
      applyThemeSettingsChange(terminal, { key: "appearance.theme", value: "__proto__" }),
    ).toBeNull();
    expect(applyThemeSettingsChange(terminal, null)).toBeNull();
    expect(applyThemeSettingsChange(terminal, "appearance.theme")).toBeNull();
    expect(terminal.options.theme).toBeUndefined();
  });
});
