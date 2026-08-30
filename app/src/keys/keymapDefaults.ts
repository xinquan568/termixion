// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-247: the default chord->command map, moved out of `commands/` so `tabs/` can read it without
// importing upward. `keys/` is a LEAF zone (see app/eslint.config.js's no-restricted-paths zones):
// it holds keyboard data and formatting with no dependency on any feature directory.
//
// `commands/keymapDispatch.ts` re-exports this, so every existing consumer keeps its import path.

/** The full default keymap (canonical chord → command id) — the shipped `[keys]` defaults. */
export const FULL_DEFAULT_KEYS: Readonly<Record<string, string>> = {
  // Primary shortcuts that also carry a native menu accelerator (macOS arbitrates in packaged).
  "cmd+t": "tab.new",
  "cmd+w": "pane.close", // ⌘W closes the FOCUSED PANE (pane precedence); the last pane closes the tab
  "cmd+shift+w": "window.close",
  "cmd+,": "app.settings",
  // webview-enforced fallback set (trmx-74/84/90) + the palette
  "cmd+shift+t": "tab.new-with-script",
  "cmd+d": "pane.split-right",
  "cmd+shift+d": "pane.split-below",
  "cmd+shift+b": "pane.set-badge",
  "cmd+shift+a": "pane.toggle-activity", // trmx-191: the manual activity-bar escape hatch
  "cmd+shift+p": "app.command-palette",
  // trmx-98 (FR-1.5): in-pane search. ⌘G/⇧⌘G fire globally when the TERMINAL is focused; while the find
  // input is focused the FindBar handles them locally (the global keymap skips editable targets).
  "cmd+f": "search.open",
  "cmd+g": "search.next",
  "cmd+shift+g": "search.prev",
  "cmd+shift+]": "tab.next",
  "cmd+shift+[": "tab.prev",
  "cmd+]": "pane.next",
  "cmd+[": "pane.prev",
  "cmd+alt+left": "pane.focus-left",
  "cmd+alt+right": "pane.focus-right",
  "cmd+alt+up": "pane.focus-up",
  "cmd+alt+down": "pane.focus-down",
  // trmx-100 (FR-3.4): re-dock the focused pane (⌃⌥⌘-arrows). Canonical modifier order (cmd, ctrl, alt).
  "cmd+ctrl+alt+left": "pane.move-left",
  "cmd+ctrl+alt+right": "pane.move-right",
  "cmd+ctrl+alt+up": "pane.move-up",
  "cmd+ctrl+alt+down": "pane.move-down",
  "cmd+1": "tab.select-1",
  "cmd+2": "tab.select-2",
  "cmd+3": "tab.select-3",
  "cmd+4": "tab.select-4",
  "cmd+5": "tab.select-5",
  "cmd+6": "tab.select-6",
  "cmd+7": "tab.select-7",
  "cmd+8": "tab.select-8",
  "cmd+9": "tab.select-9",
};
