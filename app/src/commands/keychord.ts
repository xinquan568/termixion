// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-94 (FR-9.3): the pure keychord module — parse/normalize/validate the chord strings the
// `[keys]` config maps to command ids ("cmd+shift+p"), and derive a chord from a KeyboardEvent so
// the keymap can match. Pure and dependency-free (unit-tested hard); no DOM, no throws — malformed
// input returns a typed error. Modifier order is insensitive; `cmd`≡`meta`; key names follow a
// documented table keyed to `KeyboardEvent.key`.

/** A normalized chord: the four modifiers + a single normalized key token (lowercase). */
export interface Chord {
  cmd: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** The normalized key: a lowercase letter/digit, a punctuation char, or a special name
   * ("left"/"right"/"up"/"down"/"enter"/"space"/"tab"/"escape"). */
  key: string;
}

/** The modifier aliases accepted in a chord string (all lowercased first). */
const MODIFIERS: Record<string, keyof Omit<Chord, "key"> | undefined> = {
  cmd: "cmd",
  meta: "cmd",
  command: "cmd",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
};

/** Special key-name aliases → the canonical token (also what `normalizeEventKey` emits). */
const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  escape: "escape",
  enter: "enter",
  return: "enter",
  space: "space",
  spacebar: "space",
  tab: "tab",
  left: "left",
  right: "right",
  up: "up",
  down: "down",
  arrowleft: "left",
  arrowright: "right",
  arrowup: "up",
  arrowdown: "down",
};

/** Normalize a single key token from a chord string; null if it isn't a valid key. */
function normalizeKeyToken(token: string): string | null {
  if (token in KEY_ALIASES) return KEY_ALIASES[token];
  // A single visible character (letter, digit, punctuation) is its own key, lowercased.
  if ([...token].length === 1) return token.toLowerCase();
  return null;
}

/**
 * Parse a chord string ("cmd+shift+p", modifier order insensitive) into a normalized [`Chord`], or
 * `{ error }` if it is malformed (no key, two keys, an unknown token, an empty part). Never throws.
 */
export function parseChord(input: string): Chord | { error: string } {
  const parts = input
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return { error: `empty chord "${input}"` };
  const chord: Chord = { cmd: false, ctrl: false, alt: false, shift: false, key: "" };
  let keySet = false;
  for (const part of parts) {
    const mod = MODIFIERS[part];
    if (mod) {
      chord[mod] = true;
      continue;
    }
    const key = normalizeKeyToken(part);
    if (key === null) return { error: `unknown key "${part}" in chord "${input}"` };
    if (keySet) return { error: `chord "${input}" has more than one key` };
    chord.key = key;
    keySet = true;
  }
  if (!keySet) return { error: `chord "${input}" has no key (only modifiers)` };
  return chord;
}

/** The canonical string for a chord: modifiers in fixed order (cmd, ctrl, alt, shift) then the key.
 * A stable map key — `parseChord` of any equivalent spelling produces the same canonical form. */
export function canonicalChord(chord: Chord): string {
  const parts: string[] = [];
  if (chord.cmd) parts.push("cmd");
  if (chord.ctrl) parts.push("ctrl");
  if (chord.alt) parts.push("alt");
  if (chord.shift) parts.push("shift");
  parts.push(chord.key);
  return parts.join("+");
}

/** The key slice of a KeyboardEvent the chord matcher reads (structural — tests need no real event). */
export interface ChordEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Normalize a `KeyboardEvent.key` to a chord key token (arrows/space/named keys → canonical). */
function normalizeEventKey(key: string): string {
  if (key in KEY_ALIASES) return KEY_ALIASES[key.toLowerCase()] ?? key.toLowerCase();
  const lower = key.toLowerCase();
  if (lower in KEY_ALIASES) return KEY_ALIASES[lower];
  if (key === " ") return "space";
  if ([...key].length === 1) return lower;
  return lower; // multi-char unknown → lowercased (won't match a single-char binding)
}

/** Derive a normalized [`Chord`] from a keydown event. */
export function chordFromEvent(ev: ChordEvent): Chord {
  return {
    cmd: ev.metaKey,
    ctrl: ev.ctrlKey,
    alt: ev.altKey,
    shift: ev.shiftKey,
    key: normalizeEventKey(ev.key),
  };
}

/** The canonical chord string for a keydown event (the map lookup key). */
export function canonicalChordFromEvent(ev: ChordEvent): string {
  return canonicalChord(chordFromEvent(ev));
}

/**
 * Whether a chord is bindable in `[keys]`. Rules (each a typed refusal, never a throw):
 * - must carry `cmd` (or `ctrl+shift`, reserved for a future Linux port) — plain chars and lone
 *   ctrl-codes belong to the PTY and are never bindable;
 * - ⌘C / ⌘V are reserved for copy/paste (trmx-66) and refused.
 */
export function validateBinding(chord: Chord): { ok: true } | { ok: false; reason: string } {
  const hasCmd = chord.cmd;
  const hasCtrlShift = chord.ctrl && chord.shift;
  if (!hasCmd && !hasCtrlShift) {
    return {
      ok: false,
      reason: `chord "${canonicalChord(chord)}" must include cmd (or ctrl+shift) — terminal keys are not bindable`,
    };
  }
  if (chord.cmd && !chord.ctrl && !chord.alt && !chord.shift && (chord.key === "c" || chord.key === "v")) {
    return {
      ok: false,
      reason: `chord "${canonicalChord(chord)}" is reserved for copy/paste and cannot be rebound`,
    };
  }
  return { ok: true };
}
