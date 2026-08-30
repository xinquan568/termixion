// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-247: the settings-section vocabulary, moved out of the root `surface.ts` so `settings/` can
// read it without importing UP into the root — the last `settings -> <root>` edge.
//
// It belongs in `ipc/` because it is a wire vocabulary, not UI: the shell opens the settings window
// at `index.html?window=settings&section=…` (termixion-tauri's window_manager) and re-uses the same
// strings for the `settings:navigate` event. Root `surface.ts` re-exports both so existing consumers
// — including `surface.test.ts` — keep their import path.

/** The pages the settings window knows; must match the SettingsApp nav. */
export type SettingsSection = "appearance" | "terminal" | "scripts" | "about";

/** Section guard — shared (trmx-53) so the settings:navigate path has one source of truth. */
export function isSection(v: unknown): v is SettingsSection {
  return v === "appearance" || v === "terminal" || v === "scripts" || v === "about";
}
