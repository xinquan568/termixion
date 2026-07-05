// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53: the pre-first-paint theme application (vmark's recipe: static CSS defaults + a
// runtime override before render). Static CSS cannot know the PERSISTED theme, so main.tsx calls
// this from boot() — since trmx-80 (FR-13) immediately AFTER `await hydrateSettings()`, because
// the theme now lives in the backend's config file and needs one IPC read before the themed first
// paint (ordering guarded by main.order.test.ts). It reads through the snapshot-backed settings
// registry (hydration already materialized the first-run derivation: dark OS → Night, light →
// White) and paints the body. The settings surface additionally gets its --tx-* vars so the
// window's first frame is already themed. Defensive on every edge: no document (headless) →
// no-op; an unhydrated snapshot (plain browser) → the derived default.
import { makeSettingsStore, type SettingsStore } from "../settings/settingsStore";
import { resolveSurface } from "../surface";
import { resolveTheme } from "./registry";
import { applyTxTheme } from "./txCssVars";

export interface StartupThemeOptions {
  /** Injection seams for tests; default to the real document/location. */
  doc?: Document;
  /**
   * The settings store to read appearance.theme through; defaults to a snapshot-backed store
   * (trmx-80 — the old `storage` seam died with the localStorage value backend).
   */
  settings?: SettingsStore;
  search?: string;
}

/** Paint the persisted theme before first render. Safe to call in any context. */
export function applyStartupTheme(opts: StartupThemeOptions = {}): void {
  const doc = opts.doc ?? (typeof document !== "undefined" ? document : undefined);
  if (!doc) return;
  const search = opts.search ?? doc.defaultView?.location.search ?? "";

  const id = (opts.settings ?? makeSettingsStore()).get("appearance.theme");

  if (resolveSurface(search).kind === "settings") {
    applyTxTheme(id, doc); // vars + body
  } else {
    // trmx-89 (D): resolve via the registry (built-in or user id), White fallback for junk.
    doc.body.style.background = resolveTheme(id).color.bg.primary;
  }
}
