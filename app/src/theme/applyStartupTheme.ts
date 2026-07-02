// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53: the pre-first-paint theme application (vmark's recipe: static CSS defaults + a
// runtime override before render). Static CSS cannot know the PERSISTED theme, so main.tsx
// calls this synchronously at module evaluation — before boot()'s first await (plan D7; guarded
// by main.order.test.ts) — reading the theme through the registry (which materializes the
// first-run derivation: dark OS → Night, light → White) and painting the body. The settings
// surface additionally gets its --tx-* vars so the window's first frame is already themed.
// Defensive on every edge: no document (headless) → no-op; junk/absent storage → derived default.
import { makeSettingsStore, type KeyValueStore } from "../settings/settingsStore";
import { resolveSurface } from "../surface";
import { themes } from "./themes";
import { applyTxTheme } from "./txCssVars";

export interface StartupThemeOptions {
  /** Injection seams for tests; default to the real document/localStorage/location. */
  doc?: Document;
  storage?: KeyValueStore;
  search?: string;
}

/** Paint the persisted theme before first render. Safe to call in any context. */
export function applyStartupTheme(opts: StartupThemeOptions = {}): void {
  const doc = opts.doc ?? (typeof document !== "undefined" ? document : undefined);
  if (!doc) return;
  const search = opts.search ?? doc.defaultView?.location.search ?? "";

  // makeSettingsStore(undefined) falls back to the real localStorage (its default parameter).
  const id = makeSettingsStore(opts.storage).get("appearance.theme");

  if (resolveSurface(search).kind === "settings") {
    applyTxTheme(id, doc); // vars + body
  } else {
    doc.body.style.background = themes[id].color.bg.primary;
  }
}
