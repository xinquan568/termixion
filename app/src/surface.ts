// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: which surface does this webview render? The shell opens the settings window at
// `index.html?window=settings[&section=…]` (see termixion-tauri's window_manager); everything else
// — the main window, `pnpm dev`, jsdom — is the terminal. Pure so it behaves identically in all
// three contexts and never throws on junk.

// trmx-247: SettingsSection / isSection live in `ipc/surface` so `settings/` reads them without
// importing the root. Re-exported here so every existing consumer keeps its path.
export type { SettingsSection } from "./ipc/surface";
export { isSection } from "./ipc/surface";
import type { SettingsSection } from "./ipc/surface";
import { isSection } from "./ipc/surface";

export type Surface =
  | { kind: "terminal" }
  | { kind: "settings"; section: SettingsSection | null };

/** Resolve the surface from a `window.location.search` string. */
export function resolveSurface(search: string): Surface {
  try {
    const params = new URLSearchParams(search);
    if (params.get("window") === "settings") {
      const section = params.get("section");
      return { kind: "settings", section: isSection(section) ? section : null };
    }
  } catch {
    // Unparseable query — fall through to the terminal surface.
  }
  return { kind: "terminal" };
}
