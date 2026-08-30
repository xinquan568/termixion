// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-151: chord → DISPLAY formatting for the tab strip's ⌘N number hints (CommandPalette may
// adopt it later). Pure and dependency-free; input is a canonical keychord.ts chord string
// ("cmd+shift+3"). macOS-glyph-ONLY by design — this module is the single place a platform switch
// (e.g. "Ctrl+3" text on Linux/Windows) would later land, so callers never branch on platform.
// Junk input degrades sensibly (unknown tokens become the key, empty → ""), never a throw.

const MODS = ["ctrl", "alt", "shift", "cmd"] as const; // the macOS display order ⌃⌥⇧⌘
type Mod = (typeof MODS)[number];

const MOD_GLYPHS: Record<Mod, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘" };
// ⌘ is "Meta" in aria-keyshortcuts (https://w3c.github.io/aria/#aria-keyshortcuts).
const MOD_ARIA: Record<Mod, string> = { ctrl: "Control", alt: "Alt", shift: "Shift", cmd: "Meta" };

function isMod(token: string): token is Mod {
  return (MODS as readonly string[]).includes(token);
}

// Split a chord into its modifier flags + the remaining (non-modifier) tokens uppercased. Both
// formatters share this parse so glyphs and aria can never disagree on order or key spelling.
// Duplicate modifiers collapse; every non-modifier token lands in `keys` (a well-formed canonical
// chord has exactly one — junk with more still formats, in order, rather than throwing).
function parseParts(chord: string): { mods: Record<Mod, boolean>; keys: string[] } {
  const mods: Record<Mod, boolean> = { ctrl: false, alt: false, shift: false, cmd: false };
  const keys: string[] = [];
  for (const raw of chord.split("+")) {
    const token = raw.trim().toLowerCase();
    if (token.length === 0) continue; // dangling "+" / empty input
    if (isMod(token)) mods[token] = true;
    else keys.push(token.toUpperCase()); // "k"→"K", "3"→"3", "f5"→"F5"
  }
  return { mods, keys };
}

/** Canonical chord ("cmd+shift+3") → macOS glyph string ("⇧⌘3"): modifiers in ⌃⌥⇧⌘ order
 * regardless of input order, then the key uppercased. Never throws. */
export function formatChordGlyphs(chord: string): string {
  const { mods, keys } = parseParts(chord);
  return MODS.filter((m) => mods[m]).map((m) => MOD_GLYPHS[m]).join("") + keys.join("");
}

/** The same parse → an `aria-keyshortcuts` value ("Meta+1"): cmd→Meta, ctrl→Control, alt→Alt,
 * shift→Shift, in the SAME ⌃⌥⇧⌘ (→ Control+Alt+Shift+Meta) order, "+"-joined, key uppercased. */
export function formatAriaKeyshortcuts(chord: string): string {
  const { mods, keys } = parseParts(chord);
  return [...MODS.filter((m) => mods[m]).map((m) => MOD_ARIA[m]), ...keys].join("+");
}
