// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-74: the pure tab keymap — decides whether a keydown is a tab-switching shortcut, with no
// dispatching or DOM listeners of its own (the integration layer binds it to window keydown).
//
// Exactly ⌘1..⌘9 (metaKey + a bare digit, NO ctrl/alt/shift) maps to `select-index` digit-1; the
// reducer turns index 8 (⌘9) into "last tab" per iTerm2. Everything else — extra modifiers,
// non-digits, ⌘C/⌘V/⌘T/⌘W — is never intercepted (null), so reserved shortcuts keep their owners.
//
// Editable-target inertness is scoped to NON-terminal inputs: a digit typed into e.g. a settings
// <input> must stay a digit, so `isEditableTarget && !isTerminalTarget` → null. But xterm's hidden
// helper textarea (class `xterm-helper-textarea`, mounted inside TerminalView's `.terminal-host`)
// is TECHNICALLY editable too — and a focused terminal is exactly where tab switching must work —
// so `isTerminalTarget` overrides the editable veto. `describeTarget` derives both flags from the
// DOM defensively: a non-Element target (null, document, window) classifies as neither.

/** The classification of a keydown's target the keymap decides against. */
export interface KeyTarget {
  /** Inside the terminal host (xterm's helper textarea included) — shortcuts FIRE here. */
  isTerminalTarget: boolean;
  /** A text-accepting element (input/textarea/select/contenteditable) — inert unless terminal. */
  isEditableTarget: boolean;
}

/** The one action this keymap emits; the reducer maps index 8 (⌘9) to the last tab. */
export type TabKeyAction = { kind: "select-index"; index: number };

/** The slice of a KeyboardEvent the keymap reads — structural, so tests need no real events. */
export interface TabKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Classify a keydown: `select-index` for a bare ⌘1..⌘9 on a non-editable or terminal target,
 * null for everything else (the event then propagates untouched).
 */
export function tabKeyAction(ev: TabKeyEvent, target: KeyTarget): TabKeyAction | null {
  // A non-terminal editable owns its keystrokes (digits included); the terminal does not.
  if (target.isEditableTarget && !target.isTerminalTarget) return null;
  // Exactly meta — any extra modifier makes it someone else's chord (e.g. ⌘⇧9 screenshots).
  if (!ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey) return null;
  // Digit keys "1".."9" only ("0", letters, "Enter", multi-char keys all pass through).
  if (!/^[1-9]$/.test(ev.key)) return null;
  return { kind: "select-index", index: Number(ev.key) - 1 };
}

/**
 * Derive a `KeyTarget` from a DOM event target. Terminal-ness is `closest(".terminal-host")` —
 * the host div TerminalView renders, inside which xterm mounts its `xterm-helper-textarea`.
 * Defensive: anything that isn't an Element (null, a Document, window, junk) is neither terminal
 * nor editable, so the keymap treats it like the page body (shortcuts fire).
 */
export function describeTarget(el: unknown): KeyTarget {
  if (typeof Element === "undefined" || !(el instanceof Element)) {
    return { isTerminalTarget: false, isEditableTarget: false };
  }
  const isTerminalTarget = el.closest(".terminal-host") !== null;
  const tag = el.tagName;
  const contentEditable = el.getAttribute("contenteditable");
  const isEditableTarget =
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    // isContentEditable covers inherited editability; the attribute check covers jsdom, where the
    // property may be unimplemented — "" and "true" opt in, "false" opts out.
    (el as { isContentEditable?: boolean }).isContentEditable === true ||
    (contentEditable !== null && contentEditable.toLowerCase() !== "false");
  return { isTerminalTarget, isEditableTarget };
}
