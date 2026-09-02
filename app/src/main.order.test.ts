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
  // trmx-237: the invocation gained a .catch — a rejected boot mounts the H3 recovery surface, since no
  // component (and therefore no error boundary) exists yet at that point. The pinned ORDER is unchanged.
  const bootInvoke = source.indexOf("boot().catch(");
  // trmx-253 (T3.3): the hydration call is now a METHOD on the boot runtime, so the anchor
  // moved with it (`hydrateSettings()` no longer appears in main.tsx at all). The pinned
  // ORDER is unchanged — this is a deliberate re-anchor, not a relaxation.
  const hydrateIndex = source.indexOf("settingsRuntime.hydrate(");
  // trmx-253 (T3.3): the composition root itself — the ONE runtime construction per boot.
  const runtimeIndex = source.indexOf("createSettingsRuntime(");
  // trmx-89: the user-theme registry hydration, between the settings read and the themed paint.
  const hydrateThemesIndex = source.indexOf("hydrateUserThemes(");
  const themeIndex = source.indexOf("applyStartupTheme(");
  const smokeIndex = source.indexOf('realInvoke("smoke_config")');
  const perfIndex = source.indexOf('realInvoke("perf_config")');
  const mountIndex = source.indexOf("createRoot(");
  // trmx-204: the bundled-font boot gate — the effective bundled face must be loadable before any
  // terminal measures its cell grid (mountTerminal is fully synchronous once React mounts).
  const fontGateIndex = source.indexOf("ensureStartupFontLoaded(");

  it("has boot() and every pinned step present", () => {
    for (const index of [bootStart, bootInvoke, runtimeIndex, hydrateIndex, hydrateThemesIndex, themeIndex, smokeIndex, perfIndex, mountIndex, fontGateIndex]) {
      expect(index).toBeGreaterThan(-1);
    }
  });

  it("awaits the trmx-204 font gate AFTER the theme paint and BEFORE the smoke/perf gates and mount", () => {
    expect(fontGateIndex).toBeGreaterThan(bootStart);
    expect(fontGateIndex).toBeLessThan(bootInvoke);
    // Awaited: the face must be ready (or timed out into the fallback stack) before first render.
    expect(source.slice(fontGateIndex - 20, fontGateIndex)).toContain("await ");
    // After the theme paint (the themed first frame stays as early as possible), before the gates.
    expect(fontGateIndex).toBeGreaterThan(themeIndex);
    expect(fontGateIndex).toBeLessThan(smokeIndex);
    expect(fontGateIndex).toBeLessThan(mountIndex);
    // Exactly one invocation — the pinned one inside boot().
    expect(source.match(/ensureStartupFontLoaded\(/g)).toHaveLength(1);
  });

  it("awaits the settings hydration FIRST inside boot(), before the theme registry and the theme paint", () => {
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

  it("both gates RETURN before createRoot, so App never mounts under --smoke/--perf (trmx-93: the startup script only runs on the normal terminal launch)", () => {
    // Each gate's early `return` lands before the React mount — App (and its scripts.startup trigger)
    // is unreachable on a deterministic smoke/perf launch, keeping those runs script-free.
    expect(source.indexOf("return", smokeIndex)).toBeLessThan(mountIndex);
    expect(source.indexOf("return", perfIndex)).toBeLessThan(mountIndex);
  });

  it("has NO module-level applyStartupTheme call outside boot() (one code path for all launches)", () => {
    // Exactly one invocation in the whole file — the one inside boot() pinned above.
    expect(source.match(/applyStartupTheme\(/g)).toHaveLength(1);
  });
});

describe("main.tsx service cold-launch pre-fetch (trmx-224: take BEFORE mount, main surface only)", () => {
  const bootStart = source.indexOf("async function boot");
  const perfIndex = source.indexOf('realInvoke("perf_config")');
  const mountIndex = source.indexOf("createRoot(");
  const takeIndex = source.indexOf("takePendingOpenPaths(");

  it("awaits the pending-paths take inside boot(), after the smoke/perf gates and BEFORE the mount", () => {
    // The frozen contract: the service decision lands before ANY tab or startup script can
    // exist, and plain boot stays fully synchronous inside App (the take happened pre-mount).
    expect(takeIndex).toBeGreaterThan(bootStart);
    expect(takeIndex).toBeGreaterThan(perfIndex);
    expect(takeIndex).toBeLessThan(mountIndex);
    expect(source.slice(takeIndex - 80, takeIndex)).toContain("await ");
  });

  it("only the MAIN surface drains — the settings window must never steal queued paths", () => {
    const guard = source.indexOf(
      'surface.kind === "settings" ? [] : await takePendingOpenPaths()',
    );
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(mountIndex);
  });

  it("feeds App via the serviceBootPaths prop, from exactly one take call site", () => {
    expect(source.match(/takePendingOpenPaths\(/g)).toHaveLength(1);
    // trmx-254 (T12): the 22 flat props became one `deps` object. Same wiring, new syntax.
    expect(source.indexOf("deps={{ serviceBootPaths }}")).toBeGreaterThan(takeIndex);
  });
});

// ------------------------------------------------------------------------------------------------
// trmx-253 (T3.3): the settings COMPOSITION ROOT. Before this, main.order.test.ts constrained none
// of it — it only ordered `hydrateSettings(`, a free function over module-global state, which said
// nothing about how many runtimes exist or who gets which one. The three properties that make the
// M8 extraction real are pinned here: ONE construction per boot, BEFORE hydration, and the SAME
// instance reaching both surfaces. Source-text indices again (main.tsx boots the real app and
// cannot be imported under jsdom); the behavioural coverage is settingsRuntime.isolation.test.ts.
// ------------------------------------------------------------------------------------------------
describe("main.tsx settings composition root (trmx-253: one runtime per boot, shared by both surfaces)", () => {
  const bootStart = source.indexOf("async function boot");
  const bootInvoke = source.indexOf("boot().catch(");
  const runtimeIndex = source.indexOf("createSettingsRuntime(");
  const hydrateIndex = source.indexOf("settingsRuntime.hydrate(");
  const providerOpen = source.indexOf("<SettingsRuntimeProvider");
  const providerClose = source.indexOf("</SettingsRuntimeProvider>");
  const settingsHostIndex = source.indexOf("<SettingsWindowHost");
  const appIndex = source.indexOf("<App ");

  it("constructs EXACTLY ONE settings runtime, inside boot()", () => {
    // The whole point of M8: no second runtime can appear without this failing. A module-scope
    // construction (the shape UpdateAuthorityHost/SettingsWindowHost used to have) fails the
    // bootStart bound; a second one anywhere fails the count.
    expect(source.match(/createSettingsRuntime\(/g)).toHaveLength(1);
    expect(runtimeIndex).toBeGreaterThan(bootStart);
    expect(runtimeIndex).toBeLessThan(bootInvoke);
  });

  it("constructs the runtime BEFORE hydrating it, and hydrates exactly that instance", () => {
    expect(runtimeIndex).toBeLessThan(hydrateIndex);
    expect(source.slice(hydrateIndex - 20, hydrateIndex)).toContain("await ");
    // Hydration is a method on the boot runtime, not a free function over module state.
    expect(source).not.toContain("hydrateSettings(");
    expect(source.match(/settingsRuntime\.hydrate\(/g)).toHaveLength(1);
  });

  it("keeps NO ambient bridge — the provider is the only route into the tree (trmx-253 T3.5)", () => {
    // T3.3 parked a transitional `adoptSettingsRuntime(createSettingsRuntime())` here so the
    // not-yet-threaded call sites resolved to the boot runtime. T3.4 threaded them and T3.5 deleted
    // the bridge; this pins that it does not come back. Without it, a consumer outside the provider
    // throws at mount instead of silently reading an un-hydrated second runtime's defaults.
    expect(source).not.toContain("adoptSettingsRuntime");
    expect(source).not.toContain("ambientSettingsRuntime");
  });

  it("feeds the boot-time consumers from that runtime rather than the free-function facade", () => {
    // The font gate, the startup theme paint and the perf harness read settings; all take the
    // runtime's store, so none can drift onto a different snapshot than the one hydration filled.
    expect(source).toContain("ensureStartupFontLoaded(settingsRuntime.makeStore())");
    expect(source).toContain("applyStartupTheme({ settings: settingsRuntime.makeStore() })");
    expect(source).toContain("realPerfDeps(settingsRuntime.makeStore())");
    // No production call site in main.tsx reaches for the pre-M8 free function any more.
    expect(source).not.toContain("makeSettingsStore(");
  });

  it("supplies BOTH host paths from that one instance (a single provider above both branches)", () => {
    // This is the property that made the module-evaluation-time stores impossible to remove: the
    // settings window's host and the main window's UpdateAuthorityHost (deep inside AppView) must
    // see the SAME runtime. One provider, wrapping both branches of the surface ternary.
    expect(source.match(/<SettingsRuntimeProvider/g)).toHaveLength(1);
    expect(source).toContain("<SettingsRuntimeProvider runtime={settingsRuntime}>");
    expect(providerOpen).toBeGreaterThan(-1);
    expect(providerClose).toBeGreaterThan(providerOpen);
    for (const hostIndex of [settingsHostIndex, appIndex]) {
      expect(hostIndex).toBeGreaterThan(providerOpen);
      expect(hostIndex).toBeLessThan(providerClose);
    }
  });

  it("provides the runtime INSIDE the mount, after it was hydrated", () => {
    const mountIndex = source.indexOf("createRoot(");
    expect(providerOpen).toBeGreaterThan(mountIndex);
    expect(providerOpen).toBeGreaterThan(hydrateIndex);
  });
});
