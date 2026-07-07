// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-151: the reverse chord lookup behind the tab strip's ⌘N number hints. POSITIONAL: the caller
// passes the tab's RENDER index (0..8), so a drag-reorder renumbers hints automatically — a hint
// belongs to the slot, not the tab identity. The lookup runs over the EFFECTIVE merged chord →
// command-id map App maintains via mergeKeymap (commands/keymapDispatch.ts); mergeKeymap DELETES a
// chord on the `"none"` unbind, so the tombstone never appears here — an unbound default is simply
// an absent key.
//
// Alias vs rebind (the deterministic many-to-one rule):
// - alias (default `cmd+N` still bound + extra user chords) → show the shipped default `cmd+N`;
// - rebind (default unbound via "none", a new chord added) → the default key is absent, so show the
//   lexicographically smallest chord still bound to the command (stable across map iteration order);
// - fully unbound → null (the strip renders no hint for that slot).

/** The chord to hint for the tab at render `index` (0-based), or null (no hint). Only integer
 * indexes 0..8 are hintable — the trmx-151 numbering feature is strictly first-nine. */
export function tabHintChordFor(index: number, keymap: Record<string, string>): string | null {
  if (!Number.isInteger(index) || index < 0 || index > 8) return null;
  const command = `tab.select-${index + 1}`;
  const preferred = `cmd+${index + 1}`; // the shipped default (FULL_DEFAULT_KEYS)
  if (keymap[preferred] === command) return preferred;
  const bound = Object.keys(keymap)
    .filter((chord) => keymap[chord] === command)
    .sort();
  return bound[0] ?? null;
}
