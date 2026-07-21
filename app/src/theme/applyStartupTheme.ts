// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53: the pre-first-paint theme application (vmark's recipe: static CSS defaults + a
// runtime override before render). Static CSS cannot know the PERSISTED theme, so main.tsx calls
// this from boot() — since trmx-80 (FR-13) immediately AFTER `await hydrateSettings()`, because
// the theme now lives in the backend's config file and needs one IPC read before the themed first
// paint (ordering guarded by main.order.test.ts). It reads through the snapshot-backed settings
// registry (hydration already materialized the first-run derivation: dark OS → Night, light →
// Catppuccin Latte, trmx-202) and applies the theme via applyTxTheme. trmx-173: BOTH surfaces get the --tx-* vars (not
// just the body) — the main/terminal window's chrome is themed only via them, so painting just the
// body left it on the static `:root` fallback. Defensive on every edge: no document (headless) →
// no-op; an unhydrated snapshot (plain browser) → the derived default.
import { makeSettingsStore, type SettingsStore } from "../settings/settingsStore";
import { applyTxTheme } from "./txCssVars";

export interface StartupThemeOptions {
  /** Injection seam for tests; defaults to the real `document` (trmx-173: the location/search seam
   * was retired — both surfaces apply the theme, so there is no surface to resolve). */
  doc?: Document;
  /**
   * The settings store to read appearance.theme through; defaults to a snapshot-backed store
   * (trmx-80 — the old `storage` seam died with the localStorage value backend).
   */
  settings?: SettingsStore;
}

/** Apply the persisted theme (--tx-* vars + body) before first render. Safe to call in any context. */
export function applyStartupTheme(opts: StartupThemeOptions = {}): void {
  const doc = opts.doc ?? (typeof document !== "undefined" ? document : undefined);
  if (!doc) return;
  const id = (opts.settings ?? makeSettingsStore()).get("appearance.theme");
  // trmx-173: BOTH surfaces get the full theme. applyTxTheme writes every --tx-* var on
  // documentElement AND paints the body, so a single call themes any surface — the main/terminal
  // window's chrome (tab bar, borders, …) is themed only via those vars, so painting just the body
  // left it on the static `:root` fallback. resolveTheme's total id-resolution lives inside applyTxTheme.
  applyTxTheme(id, doc);
}
