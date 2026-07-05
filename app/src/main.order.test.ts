// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-80 (FR-13): the pinned startup order is hydrate → theme → gates → mount. Settings are
// FILE-BACKED now, so boot() must await ONE config_read (hydrateSettings) before the themed first
// paint — the persisted theme lives in the config file, not localStorage, and painting before
// hydration would flash the wrong theme. applyStartupTheme therefore moved INSIDE boot() (it can
// no longer run at module evaluation, superseding the trmx-53 D7 ordering), immediately after the
// hydrate and strictly before the smoke_config/perf_config gates and the React mount. main.tsx
// cannot be imported under jsdom (it boots the real app), so this is a source-order guard over
// the raw text: the behavioral coverage lives in settingsStore.test.ts + applyStartupTheme.test.ts.
import { describe, expect, it } from "vitest";
// Vite ?raw import (typed by vite/client): the file's TEXT, not its module — main.tsx is never
// executed here (it boots the real app), and no node:fs types are needed under the app tsconfig.
import source from "./main.tsx?raw";

describe("main.tsx startup ordering (trmx-80/89: hydrate → hydrateUserThemes → theme → gates → mount)", () => {
  const bootStart = source.indexOf("async function boot");
  const bootInvoke = source.indexOf("void boot()");
  const hydrateIndex = source.indexOf("hydrateSettings(");
  // trmx-89: the user-theme registry hydration, between the settings read and the themed paint.
  const hydrateThemesIndex = source.indexOf("hydrateUserThemes(");
  const themeIndex = source.indexOf("applyStartupTheme(");
  const smokeIndex = source.indexOf('realInvoke("smoke_config")');
  const perfIndex = source.indexOf('realInvoke("perf_config")');
  const mountIndex = source.indexOf("createRoot(");

  it("has boot() and every pinned step present", () => {
    for (const index of [bootStart, bootInvoke, hydrateIndex, hydrateThemesIndex, themeIndex, smokeIndex, perfIndex, mountIndex]) {
      expect(index).toBeGreaterThan(-1);
    }
  });

  it("awaits hydrateSettings FIRST inside boot(), before the theme registry and the theme paint", () => {
    expect(hydrateIndex).toBeGreaterThan(bootStart);
    expect(hydrateIndex).toBeLessThan(bootInvoke);
    expect(source.slice(hydrateIndex - 20, hydrateIndex)).toContain("await ");
    expect(hydrateIndex).toBeLessThan(hydrateThemesIndex);
    expect(hydrateIndex).toBeLessThan(themeIndex);
  });

  it("awaits hydrateUserThemes AFTER settings and BEFORE the theme paint (trmx-89: a user:<stem> id must resolve)", () => {
    expect(hydrateThemesIndex).toBeGreaterThan(bootStart);
    expect(hydrateThemesIndex).toBeLessThan(bootInvoke);
    // It is awaited — the registry must be populated before applyStartupTheme resolves the id.
    expect(source.slice(hydrateThemesIndex - 20, hydrateThemesIndex)).toContain("await ");
    expect(hydrateThemesIndex).toBeGreaterThan(hydrateIndex);
    expect(hydrateThemesIndex).toBeLessThan(themeIndex);
  });

  it("paints the theme INSIDE boot(), after hydration and before the smoke/perf gates", () => {
    expect(themeIndex).toBeGreaterThan(bootStart);
    expect(themeIndex).toBeLessThan(bootInvoke);
    expect(themeIndex).toBeLessThan(smokeIndex);
    expect(themeIndex).toBeLessThan(perfIndex);
  });

  it("mounts React last: gates precede createRoot", () => {
    expect(smokeIndex).toBeLessThan(mountIndex);
    expect(perfIndex).toBeLessThan(mountIndex);
  });

  it("has NO module-level applyStartupTheme call outside boot() (one code path for all launches)", () => {
    // Exactly one invocation in the whole file — the one inside boot() pinned above.
    expect(source.match(/applyStartupTheme\(/g)).toHaveLength(1);
  });
});
