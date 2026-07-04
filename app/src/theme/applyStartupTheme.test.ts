// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53 (test-first): the pre-first-paint theme application. Static CSS cannot know the
// persisted theme, so startup reads it through the settings registry and paints the body — plus
// the settings surface's --tx-* vars — before anything renders. trmx-80 (FR-13): settings are
// file-backed now, so the read goes through the snapshot-backed store (seeded by hydrateSettings
// in boot(), BEFORE this runs — ordering guarded by main.order.test.ts); the old `storage` seam
// is meaningless for the theme value and became an injectable settings store. Theme
// materialization also moved into hydrateSettings (settingsStore.test.ts covers it) — this spec
// covers the paint only.
import { beforeEach, describe, expect, it } from "vitest";
import { applyStartupTheme } from "./applyStartupTheme";
import { themes, type ThemeId } from "./themes";
import {
  __resetSettingsForTest,
  hydrateSettings,
  SETTING_DEFAULTS,
  type SettingKey,
  type SettingsStore,
  type SettingsValues,
} from "../settings/settingsStore";

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
  __resetSettingsForTest();
});

describe("applyStartupTheme", () => {
  it("paints the terminal surface's body from the store's theme", () => {
    applyStartupTheme({ settings: stubSettings("solarized"), doc: document, search: "" });
    expect(document.body.style.background).toBe(probe(themes.solarized.color.bg.primary));
    // The terminal surface needs no --tx-* vars; the settings surface writes them (below).
  });

  it("derives the first-run default when the snapshot is empty (jsdom → night)", () => {
    // No injected store: the DEFAULT snapshot-backed store serves defaultFor() pre-hydration.
    applyStartupTheme({ doc: document, search: "" });
    expect(document.body.style.background).toBe(probe(themes.night.color.bg.primary));
  });

  it("paints the theme hydrateSettings seeded into the shared snapshot (the boot path)", async () => {
    await hydrateSettings({
      invoke: (cmd) =>
        cmd === "config_read"
          ? Promise.resolve({
              exists: true,
              path: "/tmp/config.toml",
              values: { "appearance.theme": "sepia" },
              warnings: [],
            })
          : Promise.resolve(null),
      bus: { listen: () => Promise.resolve(() => {}) },
      storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    });
    applyStartupTheme({ doc: document, search: "" });
    expect(document.body.style.background).toBe(probe(themes.sepia.color.bg.primary));
  });

  it("also writes the --tx-* vars for the settings surface", () => {
    applyStartupTheme({
      settings: stubSettings("paper"),
      doc: document,
      search: "?window=settings&section=appearance",
    });
    expect(document.documentElement.style.getPropertyValue("--tx-bg")).toBe("#EEEDED");
    expect(document.body.style.background).toBe(probe(themes.paper.color.bg.primary));
  });
});
