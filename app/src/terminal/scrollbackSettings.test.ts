// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-80 (FR-13): scrollback capacity is a USER SETTING now — the slice reads
// terminal.scrollbackLines from the registry, and settings:changed broadcasts reassign a live
// terminal's options.scrollback (R8: tests first). The buffer-level cap/viewport semantics stay
// pinned by scrollbackBehavior.test.ts over a real headless emulator.
import { describe, expect, it } from "vitest";
import {
  applyScrollbackSettingsChange,
  scrollbackTerminalOptions,
  SCROLLBACK_LINES,
  SMOOTH_SCROLL_DURATION_MS,
  type ScrollbackOptionsSink,
} from "./scrollbackSettings";
import { makeSettingsStore, SETTING_DEFAULTS, type KeyValueStore } from "../settings/settingsStore";

function fakeStorage(initial: Record<string, string> = {}): KeyValueStore {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("scrollbackTerminalOptions", () => {
  it("defaults to the registry's 10k cap with smooth discrete scrolling (trmx-65)", () => {
    expect(scrollbackTerminalOptions(makeSettingsStore(fakeStorage()))).toEqual({
      scrollback: 10_000,
      smoothScrollDuration: SMOOTH_SCROLL_DURATION_MS,
    });
  });

  it("prefers the persisted capacity", () => {
    const store = makeSettingsStore(fakeStorage({ "termixion.terminal.scrollbackLines": "50000" }));
    expect(scrollbackTerminalOptions(store).scrollback).toBe(50_000);
  });

  it("keeps SCROLLBACK_LINES as the one source of truth for the default (the registry's value)", () => {
    expect(SCROLLBACK_LINES).toBe(SETTING_DEFAULTS["terminal.scrollbackLines"]);
    expect(SCROLLBACK_LINES).toBe(10_000);
  });
});

describe("applyScrollbackSettingsChange", () => {
  it("reassigns options.scrollback on a scrollbackLines broadcast (clamped, untrusted input)", () => {
    const terminal: ScrollbackOptionsSink = { options: {} };
    expect(
      applyScrollbackSettingsChange(terminal, {
        key: "terminal.scrollbackLines",
        value: 25_000,
        source: "settings",
      }),
    ).toBe(true);
    expect(terminal.options.scrollback).toBe(25_000);
    expect(
      applyScrollbackSettingsChange(terminal, {
        key: "terminal.scrollbackLines",
        value: 999_999,
        source: "settings",
      }),
    ).toBe(true);
    expect(terminal.options.scrollback).toBe(200_000);
  });

  it("ignores other keys and malformed payloads without touching the terminal", () => {
    const terminal: ScrollbackOptionsSink = { options: {} };
    expect(applyScrollbackSettingsChange(terminal, { key: "terminal.fontSize", value: 14 })).toBe(false);
    expect(
      applyScrollbackSettingsChange(terminal, { key: "terminal.scrollbackLines", value: "lots" }),
    ).toBe(false);
    expect(
      applyScrollbackSettingsChange(terminal, { key: "terminal.scrollbackLines", value: NaN }),
    ).toBe(false);
    // Integers only (trmx-80 review R4): a fractional cap never reaches the live terminal.
    expect(
      applyScrollbackSettingsChange(terminal, { key: "terminal.scrollbackLines", value: 100.5 }),
    ).toBe(false);
    expect(applyScrollbackSettingsChange(terminal, null)).toBe(false);
    expect(applyScrollbackSettingsChange(terminal, "junk")).toBe(false);
    expect(terminal.options).toEqual({});
  });
});
