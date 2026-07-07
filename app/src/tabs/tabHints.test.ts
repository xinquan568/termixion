// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-151 (test-first): the positional ⌘N-hint reverse lookup over the EFFECTIVE merged keymap
// (chord → command id, the shape App maintains via mergeKeymap). Pins the deterministic many-to-one
// rule: shipped default `cmd+N` wins while still bound (alias case); otherwise the lexicographically
// smallest chord bound to `tab.select-N` (rebind case); unbound → null. Positional: index is the
// RENDER slot 0..8, so only integer 0..8 is ever hintable.
import { describe, expect, it } from "vitest";
import { FULL_DEFAULT_KEYS } from "../commands/keymapDispatch";
import { tabHintChordFor } from "./tabHints";

describe("tabHintChordFor", () => {
  it("shipped default map → cmd+N for every hintable slot 0..8", () => {
    for (let index = 0; index < 9; index++) {
      expect(tabHintChordFor(index, FULL_DEFAULT_KEYS as Record<string, string>)).toBe(
        `cmd+${index + 1}`,
      );
    }
  });

  it.each([[9], [-1], [1.5]])("index %s is outside the first-nine slots → null", (index) => {
    expect(tabHintChordFor(index, { ...FULL_DEFAULT_KEYS })).toBeNull();
  });

  it("alias: the default chord still bound + an extra user chord → the default wins", () => {
    const keymap = { "cmd+3": "tab.select-3", "cmd+shift+3": "tab.select-3" };
    expect(tabHintChordFor(2, keymap)).toBe("cmd+3");
  });

  it("rebind: default → 'none' (deleted by mergeKeymap) + a new chord → the new chord", () => {
    // The "none" tombstone never appears in the merged keymap — the default key is simply absent.
    const keymap = { "cmd+alt+3": "tab.select-3" };
    expect(tabHintChordFor(2, keymap)).toBe("cmd+alt+3");
  });

  it("fully unbound command → null (the strip renders no hint)", () => {
    expect(tabHintChordFor(2, {})).toBeNull();
    // The default chord stolen by ANOTHER command doesn't count as a binding for select-3.
    expect(tabHintChordFor(2, { "cmd+3": "pane.close" })).toBeNull();
  });

  it("two non-default chords → the lexicographically smallest (deterministic)", () => {
    const keymap = { "cmd+shift+3": "tab.select-3", "cmd+alt+3": "tab.select-3" };
    expect(tabHintChordFor(2, keymap)).toBe("cmd+alt+3"); // "cmd+alt+…" < "cmd+shift+…"
  });
});
