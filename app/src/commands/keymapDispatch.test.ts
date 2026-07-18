// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-94: keymapDispatch generalizes tabKeymap. These tests PORT the tabKeymap behavior (same chord
// → same command) and pin the two-surface split: native-menu chords (⌘T/⌘W/⌘C/⌘V) resolve NULL in the
// webview; the trmx-74 fallback chords (⌘D/⌘1-9/⌥⌘-arrows/⌘]/⌘[) resolve their ids; plus override/
// unbind/conflict and the editable/terminal-target guard.
import { describe, expect, it } from "vitest";
import { FULL_DEFAULT_KEYS, isWebviewOwned, mergeKeymap, resolve } from "./keymapDispatch";
import type { KeyTarget } from "../tabs/tabKeymap";
import type { ChordEvent } from "./keychord";

const PAGE: KeyTarget = { isTerminalTarget: false, isEditableTarget: false };
const TERMINAL: KeyTarget = { isTerminalTarget: true, isEditableTarget: true };
const EDITABLE: KeyTarget = { isTerminalTarget: false, isEditableTarget: true };

const ev = (key: string, mods: Partial<ChordEvent> = {}): ChordEvent => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});
const cmd = (key: string, mods: Partial<ChordEvent> = {}) => ev(key, { metaKey: true, ...mods });

const DEFAULTS = mergeKeymap(FULL_DEFAULT_KEYS, []).keymap;

describe("resolve — ported tabKeymap webview cases", () => {
  it("⌘1..⌘9 → tab.select-N (on page + terminal)", () => {
    expect(resolve(cmd("1"), PAGE, DEFAULTS)).toBe("tab.select-1");
    expect(resolve(cmd("9"), TERMINAL, DEFAULTS)).toBe("tab.select-9");
  });
  it("⌘D → pane.split-right, ⇧⌘D → pane.split-below, ⇧⌘B → pane.set-badge", () => {
    expect(resolve(cmd("d"), PAGE, DEFAULTS)).toBe("pane.split-right");
    expect(resolve(cmd("d", { shiftKey: true }), TERMINAL, DEFAULTS)).toBe("pane.split-below");
    expect(resolve(cmd("b", { shiftKey: true }), PAGE, DEFAULTS)).toBe("pane.set-badge");
  });
  it("⌥⌘arrows → pane.focus-*, ⌘]/⌘[ → pane.next/prev, ⇧⌘]/[ → tab.next/prev", () => {
    expect(resolve(cmd("ArrowLeft", { altKey: true }), PAGE, DEFAULTS)).toBe("pane.focus-left");
    expect(resolve(cmd("]"), PAGE, DEFAULTS)).toBe("pane.next");
    expect(resolve(cmd("[", { shiftKey: true }), PAGE, DEFAULTS)).toBe("tab.prev");
  });
  it("⌃⌥⌘arrows → pane.move-* (trmx-100; canonical chord order resolves)", () => {
    expect(resolve(cmd("ArrowLeft", { ctrlKey: true, altKey: true }), PAGE, DEFAULTS)).toBe("pane.move-left");
    expect(resolve(cmd("ArrowRight", { ctrlKey: true, altKey: true }), PAGE, DEFAULTS)).toBe("pane.move-right");
    expect(resolve(cmd("ArrowUp", { ctrlKey: true, altKey: true }), TERMINAL, DEFAULTS)).toBe("pane.move-up");
    expect(resolve(cmd("ArrowDown", { ctrlKey: true, altKey: true }), TERMINAL, DEFAULTS)).toBe("pane.move-down");
  });
  it("⇧⌘P → app.command-palette", () => {
    expect(resolve(cmd("p", { shiftKey: true }), PAGE, DEFAULTS)).toBe("app.command-palette");
  });
});

describe("resolve — the webview enforces all non-palette commands (macOS arbitrates native accels)", () => {
  it("⌘T / ⌘W / ⌘, resolve their commands (they also have native accelerators; the OS arbitrates)", () => {
    expect(resolve(cmd("t"), PAGE, DEFAULTS)).toBe("tab.new");
    expect(resolve(cmd("w"), PAGE, DEFAULTS)).toBe("pane.close"); // ⌘W = close focused pane
    expect(resolve(cmd(","), PAGE, DEFAULTS)).toBe("app.settings");
  });
  it("a user binding for a NON-native command (pane.grow-*) resolves (finding 1)", () => {
    const { keymap } = mergeKeymap(FULL_DEFAULT_KEYS, [["cmd+alt+shift+right", "pane.grow-right"]]);
    expect(resolve(cmd("ArrowRight", { altKey: true, shiftKey: true }), PAGE, keymap)).toBe("pane.grow-right");
  });
  it("⌘C / ⌘V are never in the keymap (refused at bind) → null (clipboard, trmx-66)", () => {
    expect(resolve(cmd("c"), PAGE, DEFAULTS)).toBeNull();
    expect(resolve(cmd("v"), TERMINAL, DEFAULTS)).toBeNull();
  });
  it("palette-parameterized commands are NOT webview-resolved", () => {
    const { keymap } = mergeKeymap(FULL_DEFAULT_KEYS, [["cmd+shift+k", "theme.select"]]);
    expect(resolve(cmd("k", { shiftKey: true }), PAGE, keymap)).toBeNull();
    expect(isWebviewOwned("theme.select")).toBe(false);
    expect(isWebviewOwned("pane.grow-right")).toBe(true);
  });
  it("bare digits / ctrl-digits / unmapped chords → null", () => {
    expect(resolve(ev("1"), PAGE, DEFAULTS)).toBeNull();
    expect(resolve(ev("1", { ctrlKey: true }), PAGE, DEFAULTS)).toBeNull();
    expect(resolve(cmd("z"), PAGE, DEFAULTS)).toBeNull();
  });
});

describe("resolve — target guard (unchanged from tabKeymap)", () => {
  it("fires on the terminal target, inert on a non-terminal editable", () => {
    expect(resolve(cmd("1"), TERMINAL, DEFAULTS)).toBe("tab.select-1");
    expect(resolve(cmd("1"), EDITABLE, DEFAULTS)).toBeNull();
    expect(resolve(cmd("d"), EDITABLE, DEFAULTS)).toBeNull();
  });
});

describe("mergeKeymap — user [keys] overrides", () => {
  it("rebinds a webview command to a new chord (live)", () => {
    const { keymap } = mergeKeymap(FULL_DEFAULT_KEYS, [["cmd+shift+enter", "pane.split-below"]]);
    expect(resolve(cmd("Enter", { shiftKey: true }), PAGE, keymap)).toBe("pane.split-below");
  });
  it('unbinds a default with "none"', () => {
    const { keymap } = mergeKeymap(FULL_DEFAULT_KEYS, [["cmd+d", "none"]]);
    expect(resolve(cmd("d"), PAGE, keymap)).toBeNull();
    expect(keymap["cmd+d"]).toBeUndefined();
  });
  it("refuses ⌘C/⌘V and non-cmd bindings with a warning, skips them", () => {
    const { keymap, warnings } = mergeKeymap(FULL_DEFAULT_KEYS, [
      ["cmd+c", "pane.close"],
      ["a", "tab.new"],
    ]);
    expect(keymap["cmd+c"]).toBeUndefined();
    expect(keymap["a"]).toBeUndefined();
    expect(warnings.length).toBe(2);
  });
  it("warns on an invalid chord and on a duplicate (last wins)", () => {
    const { keymap, warnings } = mergeKeymap(FULL_DEFAULT_KEYS, [
      ["cmd+nope", "tab.new"],
      ["cmd+shift+enter", "pane.split-right"],
      ["cmd+shift+enter", "pane.split-below"],
    ]);
    expect(keymap["cmd+shift+enter"]).toBe("pane.split-below");
    expect(warnings.some((w) => w.includes("nope"))).toBe(true);
    expect(warnings.some((w) => w.includes("more than once"))).toBe(true);
  });
});

describe("keymap wiring invariants", () => {
  it("the default keymap targets only palette-excluded commands the webview can enforce", () => {
    for (const id of Object.values(FULL_DEFAULT_KEYS)) expect(isWebviewOwned(id)).toBe(true);
  });

  it("⌘⇧A resolves to the activity toggle (trmx-191)", () => {
    expect(FULL_DEFAULT_KEYS["cmd+shift+a"]).toBe("pane.toggle-activity");
    expect(resolve(cmd("a", { shiftKey: true }), PAGE, DEFAULTS)).toBe("pane.toggle-activity");
  });
});
