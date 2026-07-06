// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-94 (FR-9.3): the data-driven keymap — generalizes trmx-74's hard-coded `tabKeymap.ts` into a
// chord→command-id resolver over the effective `[keys]` map (defaults ⊕ user overrides). Pure; the
// editable/terminal-target guard reuses `tabKeymap.describeTarget` (unchanged).
//
// TWO enforcement surfaces (trmx-94 plan decision 5b), so `[keys]` is one source of truth:
// - `FULL_DEFAULT_KEYS` — the COMPLETE default chord→id map INCLUDING native-menu shortcuts (⌘T, ⌘W,
//   ⌘, …). This is what the config template + `keys_read` express and what the native menu builds its
//   accelerators from.
// - `WEBVIEW_COMMANDS` — the subset the WEBVIEW enforces here (the trmx-74 fallback set + the palette).
//   A chord bound to a native-menu-owned command resolves to **null** in the webview (the menu's
//   accelerator is its enforcer) — so ⌘T/⌘W/⌘C/⌘V stay non-intercepted exactly as `tabKeymap` pins.
import { canonicalChord, canonicalChordFromEvent, parseChord, validateBinding, type ChordEvent } from "./keychord";
import { describeTarget, type KeyTarget } from "../tabs/tabKeymap";

export { describeTarget, type KeyTarget };

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
  "cmd+shift+p": "app.command-palette",
  "cmd+shift+]": "tab.next",
  "cmd+shift+[": "tab.prev",
  "cmd+]": "pane.next",
  "cmd+[": "pane.prev",
  "cmd+alt+left": "pane.focus-left",
  "cmd+alt+right": "pane.focus-right",
  "cmd+alt+up": "pane.focus-up",
  "cmd+alt+down": "pane.focus-down",
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

/** Parameterized commands are only reachable through the palette's two-level page (a bare chord would
 * run them with no argument — a no-op), so the webview keymap does not resolve them. */
export const PALETTE_ONLY_COMMANDS: ReadonlySet<string> = new Set(["theme.select", "script.run"]);

/**
 * Whether the WEBVIEW keymap enforces a command id. Every command EXCEPT the palette-parameterized
 * ones is webview-enforceable — so a user `[keys]` binding for ANY of them (incl. those with no native
 * menu accelerator: pane.grow-*, terminal.clear-scrollback, tab.rename, app.check-updates, …) actually
 * fires. ⌘C/⌘V are safe because `validateBinding` refuses them, so they never enter the keymap. A
 * command that ALSO has a native menu accelerator (⌘T/⌘D/⇧⌘P/…) is arbitrated by macOS in the packaged
 * build (the menu consumes its chord before the webview); in dev/e2e/tests there is no menu, so the
 * webview is the single enforcer — which is exactly what the keyboard-only e2e needs.
 */
export function isWebviewOwned(id: string): boolean {
  return !PALETTE_ONLY_COMMANDS.has(id);
}

export interface MergedKeymap {
  /** The effective canonical-chord → command-id map. */
  keymap: Record<string, string>;
  /** Non-fatal problems (invalid chord, refused binding, conflict) — surfaced, never fatal. */
  warnings: string[];
}

/**
 * Build the effective keymap from the defaults and the user `[keys]` overrides. Each user entry is a
 * raw `chord → command-id` (or `"none"` to unbind). Invalid chords and refused bindings (⌘C/⌘V,
 * non-cmd) warn and are skipped; a chord already assigned (default or an earlier user entry) is
 * overwritten, last-wins, with a conflict warning. Deterministic (BTreeMap order from the backend).
 */
export function mergeKeymap(
  defaults: Readonly<Record<string, string>>,
  userEntries: ReadonlyArray<readonly [string, string]>,
): MergedKeymap {
  const keymap: Record<string, string> = { ...defaults };
  const warnings: string[] = [];
  const userCanonical = new Set<string>();
  for (const [rawChord, command] of userEntries) {
    const parsed = parseChord(rawChord);
    if ("error" in parsed) {
      warnings.push(`[keys]: ${parsed.error}; ignored`);
      continue;
    }
    const canonical = canonicalChord(parsed);
    if (command === "none") {
      delete keymap[canonical];
      userCanonical.add(canonical);
      continue;
    }
    const check = validateBinding(parsed);
    if (!check.ok) {
      warnings.push(`[keys]: ${check.reason}; ignored`);
      continue;
    }
    if (userCanonical.has(canonical)) {
      warnings.push(`[keys]: chord "${canonical}" bound more than once; last wins ("${command}")`);
    }
    keymap[canonical] = command;
    userCanonical.add(canonical);
  }
  return { keymap, warnings };
}

/**
 * Resolve a keydown to a WEBVIEW-owned command id, or null (propagate untouched). A non-terminal
 * editable target owns its keystrokes (settings inputs, the rename/badge/palette fields); the
 * terminal does not (shortcuts fire in it). A chord bound to a native-menu-owned command → null.
 */
export function resolve(ev: ChordEvent, target: KeyTarget, keymap: Record<string, string>): string | null {
  if (target.isEditableTarget && !target.isTerminalTarget) return null;
  const id = keymap[canonicalChordFromEvent(ev)];
  if (!id) return null;
  if (!isWebviewOwned(id)) return null; // the native menu / palette enforces this command
  return id;
}
