// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53: the theme slice of the terminal's effective options — the catalog's answer at the
// display chokepoint (realDeps.createTerminal), and live application of `settings:changed`
// broadcasts to a running xterm by wholesale `options.theme` reassignment (the same no-remount
// mechanism cursorSettings uses). Pure + payload-guarded: events are untrusted input, junk must
// be inert. Supersedes trmx-44's OS-appearance-driven palette selection.
import type { ITheme } from "@xterm/xterm";
import { buildXtermTheme } from "../theme/buildXtermTheme";
import { normalizeLegacyThemeId } from "../theme/defaultTheme";
import { isRegisteredThemeId } from "../theme/registry";
import type { ThemeId } from "../theme/themes";
import type { SettingsStore } from "../settings/settingsStore";

/** The persisted (or first-run-derived) theme's xterm options for construction. */
export function themeTerminalOptions(settings: SettingsStore): { theme: ITheme } {
  return { theme: buildXtermTheme(settings.get("appearance.theme")) };
}

/** The slice of a live xterm we reassign (xterm repaints on theme assignment, no remount). */
export interface ThemeOptionsSink {
  options: { theme?: ITheme };
}

/**
 * Apply a `settings:changed` payload to a live terminal. Returns the applied `ThemeId` when the
 * payload was a valid theme change, else null (other keys, malformed values — ignored). The
 * caller uses the returned id to sync the host/body backgrounds and recompute the scrollbar.
 */
export function applyThemeSettingsChange(
  terminal: ThemeOptionsSink,
  payload: unknown,
): ThemeId | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { key, value } = payload as { key?: unknown; value?: unknown };
  if (key !== "appearance.theme") return null;
  // trmx-202: a REMOVED built-in (a live config edit, or the Rust watcher's default "white")
  // normalizes to the derived default so running terminals re-theme instead of ignoring it.
  const applied = normalizeLegacyThemeId(value) ?? value;
  // trmx-89 (D): registry-aware — accepts a built-in OR a registered user id; junk stays inert.
  if (!isRegisteredThemeId(applied)) return null;
  terminal.options.theme = buildXtermTheme(applied);
  return applied;
}
