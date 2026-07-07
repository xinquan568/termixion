// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-151 (test-first): the pure chord→display formatter behind the tab strip's ⌘N hints. Pins the
// macOS glyph mapping (⌃⌥⇧⌘, fixed display order regardless of input order, key uppercased) and the
// matching `aria-keyshortcuts` spelling (Control+Alt+Shift+Meta — the SAME canonical order). Table-
// driven, no DOM; junk input must degrade sensibly, never throw.
import { describe, expect, it } from "vitest";
import { formatAriaKeyshortcuts, formatChordGlyphs } from "./chordGlyphs";

describe("formatChordGlyphs — canonical chord → macOS glyph string", () => {
  it.each([
    ["cmd+1", "⌘1"],
    ["cmd+9", "⌘9"],
    ["cmd+shift+3", "⇧⌘3"],
    ["ctrl+alt+k", "⌃⌥K"], // final key uppercased
    ["shift+cmd+ctrl+alt+x", "⌃⌥⇧⌘X"], // input order irrelevant — always emitted ⌃⌥⇧⌘
    ["f5", "F5"], // bare (modifier-less) key still formats
  ])("%s → %s", (chord, glyphs) => {
    expect(formatChordGlyphs(chord)).toBe(glyphs);
  });

  it("never throws — empty / dangling / unknown parts pass through sensibly", () => {
    expect(formatChordGlyphs("")).toBe(""); // absent chord → empty display
    expect(formatChordGlyphs("cmd+")).toBe("⌘"); // dangling separator → just the modifier
    expect(formatChordGlyphs("bogus")).toBe("BOGUS"); // unknown token is treated as the key
  });
});

describe("formatAriaKeyshortcuts — same parse → aria-keyshortcuts value", () => {
  it.each([
    ["cmd+1", "Meta+1"],
    // Pinned canonical order: the glyph order ⌃⌥⇧⌘ maps to Control+Alt+Shift+Meta — never
    // "Meta+Shift+3" (one spelling, so snapshot-y a11y assertions stay stable).
    ["cmd+shift+3", "Shift+Meta+3"],
    ["ctrl+alt+k", "Control+Alt+K"],
    ["shift+cmd+ctrl+alt+x", "Control+Alt+Shift+Meta+X"],
    ["f5", "F5"],
  ])("%s → %s", (chord, aria) => {
    expect(formatAriaKeyshortcuts(chord)).toBe(aria);
  });
});
