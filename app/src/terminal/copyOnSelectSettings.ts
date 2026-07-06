// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-95: the settings glue for auto-copy-on-select — read the initial `terminal.copyOnSelect` value
// and interpret a live `settings:changed` payload for it. Unlike the cursor/font/scrollback options
// (assigned onto the live terminal), copy-on-select ATTACHES/DETACHES a listener set, so TerminalView
// consumes these as a boolean gate rather than an ITerminalOptions slice. Pure + payload-guarded
// (events are untrusted input — junk is inert).
import type { SettingsStore } from "../settings/settingsStore";

/** The persisted copy-on-select gate (default on — iTerm2 parity). */
export function copyOnSelectEnabled(settings: SettingsStore): boolean {
  return settings.get("terminal.copyOnSelect");
}

/**
 * Interpret a `settings:changed` payload: the new boolean when it targets `terminal.copyOnSelect`,
 * else `null` (so TerminalView only re-syncs on a real copy-on-select change).
 */
export function copyOnSelectSettingChange(payload: unknown): boolean | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { key, value } = payload as { key?: unknown; value?: unknown };
  if (key !== "terminal.copyOnSelect") return null;
  return typeof value === "boolean" ? value : null;
}
