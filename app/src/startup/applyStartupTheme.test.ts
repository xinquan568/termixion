// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53 (test-first): the pre-first-paint theme application. Static CSS cannot know the
// persisted theme, so startup reads it through the settings registry and paints the body — plus
// the settings surface's --tx-* vars — before anything renders. trmx-80 (FR-13): settings are
// file-backed now, so the read goes through the snapshot-backed store (seeded by the runtime's
// hydrate() in boot(), BEFORE this runs — ordering guarded by main.order.test.ts); the old
// `storage` seam is meaningless for the theme value and became an injectable settings store. Theme
// materialization also moved into hydration (settingsStore.test.ts covers it) — this spec covers
// the paint only. trmx-253 (T3.4): the store is a REQUIRED option, so every case here names the
// store it paints from instead of leaning on a module-global one.
import { beforeEach, describe, expect, it } from "vitest";
import { applyStartupTheme } from "./applyStartupTheme";
import { themes, type ThemeId } from "../theme/themes";
import { freshSettingsRuntime, freshSettingsStore } from "../test/settingsRuntime";
import {
  SETTING_DEFAULTS,
  type SettingKey,
  type SettingsStore,
  type SettingsValues,
} from "../store/settingsStore";

/** A minimal store stub: the theme under test, registry defaults for everything else. */
function stubSettings(theme: ThemeId): SettingsStore {
  return {
    get: <K extends SettingKey>(key: K) =>
      (key === "appearance.theme" ? theme : SETTING_DEFAULTS[key]) as SettingsValues[K],
    set: () => {},
    loadLastCheckAt: () => null,
    saveLastCheckAt: () => {},
    resetAll: () => {},
  };
}

const probe = (color: string) => {
  const el = document.createElement("div");
  el.style.background = color;
  return el.style.background;
};

beforeEach(() => {
  // trmx-173: the vars/body live on documentElement/body inline style — clear between tests so the
  // --tx-* assertions never read a value bled from a prior test.
  document.documentElement.style.cssText = "";
  document.body.style.cssText = "";
});

describe("applyStartupTheme", () => {
  it("paints the terminal surface's body AND writes its --tx-* vars from the store's theme (trmx-173)", () => {
    applyStartupTheme({ settings: stubSettings("solarized"), doc: document });
    expect(document.body.style.background).toBe(probe(themes.solarized.color.bg.primary));
    // trmx-173: the main (terminal) surface now ALSO gets the --tx-* vars (the tab bar / chrome are
    // themed only via them) — previously it painted only the body, leaving them on the :root fallback.
    expect(document.documentElement.style.getPropertyValue("--tx-bg")).toBe(themes.solarized.color.bg.primary);
    expect(document.documentElement.style.getPropertyValue("--tx-bg-sunken")).not.toBe("");
  });

  it("derives the first-run default when the snapshot is empty (jsdom → night)", () => {
    // An un-hydrated runtime's store: nothing in the snapshot, so the read derives via defaultFor().
    // trmx-253 (T3.4): `settings` is REQUIRED now — there is no ambient store to omit it in favour
    // of — so the empty-snapshot contract is expressed with an explicit fresh store.
    applyStartupTheme({ settings: freshSettingsStore(), doc: document });
    expect(document.body.style.background).toBe(probe(themes.night.color.bg.primary));
  });

  it("paints the theme hydration seeded into the runtime's snapshot (the boot path)", async () => {
    // The boot ordering, on ONE runtime: hydrate() seeds the snapshot, then the store built over
    // that same runtime is what applyStartupTheme reads — exactly what main.tsx does.
    const runtime = freshSettingsRuntime();
    await runtime.hydrate({
      invoke: (cmd) =>
        cmd === "config_read"
          ? Promise.resolve({
              exists: true,
              path: "/tmp/config.toml",
              values: { "appearance.theme": "solarized" },
              warnings: [],
            })
          : Promise.resolve(null),
      bus: { listen: () => Promise.resolve(() => {}) },
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    });
    applyStartupTheme({ settings: runtime.makeStore(), doc: document });
    expect(document.body.style.background).toBe(probe(themes.solarized.color.bg.primary));
  });

  it("writes the --tx-* vars + body for any surface (trmx-173: no surface branch)", () => {
    applyStartupTheme({ settings: stubSettings("catppuccin-latte"), doc: document });
    expect(document.documentElement.style.getPropertyValue("--tx-bg")).toBe("#eff1f5");
    expect(document.body.style.background).toBe(probe(themes["catppuccin-latte"].color.bg.primary));
  });
});
