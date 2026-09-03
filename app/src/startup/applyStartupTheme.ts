// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53: the pre-first-paint theme application (vmark's recipe: static CSS defaults + a
// runtime override before render). Static CSS cannot know the PERSISTED theme, so main.tsx calls
// this from boot() — since trmx-80 (FR-13) immediately AFTER `await hydrateSettings()`, because
// the theme now lives in the backend's config file and needs one IPC read before the themed first
// paint (ordering executed by boot.test.tsx since trmx-250). It reads through the snapshot-backed settings
// registry (hydration already materialized the first-run derivation: dark OS → Night, light →
// Catppuccin Latte, trmx-202) and applies the theme via applyTxTheme. trmx-173: BOTH surfaces get the --tx-* vars (not
// just the body) — the main/terminal window's chrome is themed only via them, so painting just the
// body left it on the static `:root` fallback. Defensive on every edge: no document (headless) →
// no-op; an unhydrated snapshot (plain browser) → the derived default.
import { type SettingsStore } from "../store/settingsStore";
import { applyTxTheme } from "../theme/txCssVars";

export interface StartupThemeOptions {
  /**
   * The settings store to read appearance.theme through. REQUIRED since trmx-253 (T3.4): it used
   * to default to `makeSettingsStore()`, which resolved to a module-global runtime. With the
   * runtime explicit there is no ambient instance to fall back on, and a lazily created one would
   * be un-hydrated — it would paint the registry default over the user's persisted theme, silently.
   * boot() passes the runtime it just hydrated.
   */
  settings: SettingsStore;
  /** Injection seam for tests; defaults to the real `document` (trmx-173: the location/search seam
   * was retired — both surfaces apply the theme, so there is no surface to resolve). */
  doc?: Document;
}

/** Apply the persisted theme (--tx-* vars + body) before first render. Safe to call in any context. */
export function applyStartupTheme(opts: StartupThemeOptions): void {
  const doc = opts.doc ?? (typeof document !== "undefined" ? document : undefined);
  if (!doc) return;
  const id = opts.settings.get("appearance.theme");
  // trmx-173: BOTH surfaces get the full theme. applyTxTheme writes every --tx-* var on
  // documentElement AND paints the body, so a single call themes any surface — the main/terminal
  // window's chrome (tab bar, borders, …) is themed only via those vars, so painting just the body
  // left it on the static `:root` fallback. resolveTheme's total id-resolution lives inside applyTxTheme.
  applyTxTheme(id, doc);
}
