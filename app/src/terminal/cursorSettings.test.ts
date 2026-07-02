// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the cursor options overlay + the live settings:changed application (R8: tests first).
import { describe, expect, it } from "vitest";
import { applyCursorSettingsChange, cursorTerminalOptions, type CursorOptionsSink } from "./cursorSettings";
import { makeSettingsStore, type KeyValueStore } from "../settings/settingsStore";

function fakeStorage(initial: Record<string, string> = {}): KeyValueStore {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

describe("cursorTerminalOptions", () => {
  it("defaults to the registry cursor: underline, no blink (trmx-55)", () => {
    expect(cursorTerminalOptions(makeSettingsStore(fakeStorage()))).toEqual({
      cursorStyle: "underline",
      cursorBlink: false,
    });
  });

  it("prefers the persisted values", () => {
    const store = makeSettingsStore(
      fakeStorage({
        "termixion.terminal.cursorStyle": "block",
        "termixion.terminal.cursorBlink": "true",
      }),
    );
    expect(cursorTerminalOptions(store)).toEqual({ cursorStyle: "block", cursorBlink: true });
  });
});

describe("applyCursorSettingsChange", () => {
  it("applies cursor style and blink changes to the live terminal", () => {
    const terminal: CursorOptionsSink = { options: {} };
    expect(
      applyCursorSettingsChange(terminal, { key: "terminal.cursorStyle", value: "bar", source: "s" }),
    ).toBe(true);
    expect(terminal.options.cursorStyle).toBe("bar");
    expect(
      applyCursorSettingsChange(terminal, { key: "terminal.cursorBlink", value: false, source: "s" }),
    ).toBe(true);
    expect(terminal.options.cursorBlink).toBe(false);
  });

  it("a reset broadcast (default values) restores underline + no blink live (trmx-55)", () => {
    const terminal: CursorOptionsSink = {
      options: { cursorStyle: "bar", cursorBlink: true },
    };
    applyCursorSettingsChange(terminal, {
      key: "terminal.cursorStyle",
      value: "underline",
      source: "settings",
    });
    applyCursorSettingsChange(terminal, {
      key: "terminal.cursorBlink",
      value: false,
      source: "settings",
    });
    expect(terminal.options).toEqual({ cursorStyle: "underline", cursorBlink: false });
  });

  it("ignores other keys and malformed payloads without touching the terminal", () => {
    const terminal: CursorOptionsSink = { options: {} };
    expect(applyCursorSettingsChange(terminal, { key: "update.autoCheck", value: false })).toBe(false);
    expect(applyCursorSettingsChange(terminal, { key: "terminal.cursorStyle", value: "wavy" })).toBe(false);
    expect(applyCursorSettingsChange(terminal, { key: "terminal.cursorBlink", value: "yes" })).toBe(false);
    expect(applyCursorSettingsChange(terminal, null)).toBe(false);
    expect(applyCursorSettingsChange(terminal, "junk")).toBe(false);
    expect(terminal.options).toEqual({});
  });
});
