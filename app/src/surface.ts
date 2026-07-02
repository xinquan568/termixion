// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: which surface does this webview render? The shell opens the settings window at
// `index.html?window=settings[&section=…]` (see termixion-tauri's window_manager); everything else
// — the main window, `pnpm dev`, jsdom — is the terminal. Pure so it behaves identically in all
// three contexts and never throws on junk.

/** The pages the settings window knows; must match the SettingsApp nav. */
export type SettingsSection = "terminal" | "about";

export type Surface =
  | { kind: "terminal" }
  | { kind: "settings"; section: SettingsSection | null };

function isSection(v: string | null): v is SettingsSection {
  return v === "terminal" || v === "about";
}

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
