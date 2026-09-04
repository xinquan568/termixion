// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-250 (L10): the boot path, EXECUTABLE.
//
// This used to be the body of main.tsx, which cannot be imported under jsdom (it boots the real
// app), so the startup order, the composition root and the global failure handlers were pinned by
// index arithmetic over its raw text. Every external effect is a member of `BootDeps` now: main.tsx
// supplies the real ones and calls `start(realBootDeps)` once; boot.test.tsx supplies a recorder and
// asserts the same facts by running the code. Nothing in this module reaches for `document`, the
// backend or ReactDOM directly — that is what makes it importable; the one `window` use is the two
// global listeners in installGlobalHandlers, which jsdom provides and boot.test.tsx dispatches into.
//
// The pinned startup order (trmx-80): create the settings runtime → hydrate → theme → gates →
// mount — ONE code path for all launches. Settings are file-backed (FR-13), so exactly one
// config_read must land before the themed first paint: the boot runtime's hydrate step seeds that
// runtime's snapshot (and runs the one-time legacy-localStorage migration), then applyStartupTheme
// paints the persisted theme from it, superseding trmx-53's module-evaluation paint (which could
// read localStorage synchronously — a file-backed theme cannot be read without the IPC round-trip).
// index.css's static fallback covers the hydrate await; hydrate() never throws (a plain browser
// falls back to the registry defaults). trmx-253 (T3.3/T3.5) made the runtime explicit — see the
// composition-root note in boot().
//
// This order is a WEBVIEW concern — the themed first paint and the font gate need the hydrated
// store. It is not what makes the Rust side correct any more: since trmx-246 the shell hydrates
// its own config cache in setup() before any command can run, so a PTY spawn sees the configured
// shell whether or not the webview has read the file yet.
//
// After the paint, boot() asks the backend whether this is a `--smoke` launch (C-3). If so, drive
// the deterministic sentinel sequence over the production channel and let the backend exit 0/1 —
// no UI. Otherwise render the surface this window is for (trmx-51): the shell opens the settings
// window at `?window=settings[&section=…]`; everything else — the main window, `pnpm dev` in a
// plain browser — is the terminal. A plain browser has no backend, so smoke_config rejects → app.
import React, { type ReactElement } from "react";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { SettingsWindowHost } from "./settings/SettingsWindowHost";
import type { InvokeFn } from "./ipc/backend";
import type { LogSink } from "./ipc/logSink";
import type { PerfLaunchConfig } from "./perf/runPerf";
import type { SettingsRuntime, SettingsStore } from "./store/settingsStore";
import { SettingsRuntimeProvider } from "./store/settingsRuntimeContext";
import type { Surface } from "./surface";

/** Every external effect of the boot path. main.tsx wires the real ones; tests wire a recorder. */
export interface BootDeps {
  /** The composition root's ONE runtime per boot — the FULL interface, since the provider requires it. */
  createSettingsRuntime(): SettingsRuntime;
  /** trmx-89: populate the user-theme registry (themes_read → registerUserThemes). */
  hydrateUserThemes(): Promise<void>;
  /** The themed first paint, from the hydrated runtime's store. */
  applyStartupTheme(args: { settings: SettingsStore }): void;
  /** trmx-204: the bundled-font gate. */
  ensureStartupFontLoaded(settings: SettingsStore): Promise<void>;
  /** The backend channel for the `smoke_config` / `perf_config` launch gates. */
  invoke: InvokeFn;
  /** C-3: drive the smoke sequence over `dir`; the backend exits via smoke_done. */
  runSmoke(dir: string): Promise<void>;
  /** trmx-78: the single-pane NFR-1 perf driver; the backend exits via perf_done. */
  runPerf(config: PerfLaunchConfig, settings: SettingsStore): Promise<void>;
  /** trmx-103: the multi-pane perf driver, selected by `scenario === "multipane"`. */
  runPerfMultipane(config: PerfLaunchConfig, settings: SettingsStore): Promise<void>;
  /** trmx-51: which surface this window renders, from the location search. */
  resolveSurface(search: string): Surface;
  /** `window.location.search` in production. */
  locationSearch(): string;
  /** trmx-224: drain the service cold-launch queue (main surface only). */
  takePendingOpenPaths(): Promise<string[]>;
  /** `document.getElementById("root")` in production. */
  root(): HTMLElement | null;
  /** `ReactDOM.createRoot(root).render(tree)` in production. */
  render(root: HTMLElement, tree: ReactElement): void;
  /** trmx-237 (H3): the recovery actions handed to the error boundaries. */
  reload(): void;
  quit(): void;
  closeWindow(): void;
  /** The diagnostic sink — the app log (console + backend log file, trmx-236). */
  log: Pick<LogSink, "error">;
}

export async function boot(deps: BootDeps): Promise<void> {
  // trmx-253 (T3.3): THE COMPOSITION ROOT. Exactly one settings runtime exists per boot and this
  // is where it is made — before hydration, because hydration is a method ON it. Everything that
  // reads settings is fed from this one instance, by two routes and no hidden third:
  //
  //   1. DIRECT INJECTION for what boot() itself calls (the font gate, the startup theme paint).
  //   2. A REACT CONTEXT wrapping BOTH surfaces below, so UpdateAuthorityHost (deep inside AppView)
  //      and SettingsWindowHost build their stores per mount instead of at module-evaluation time.
  //      That was the blocker: a module-evaluation-time store can only close over state that
  //      already exists, which is why the ten pieces had to be module-global to begin with.
  //
  // T3.5 removed the third route. A transitional bridge used to publish this object to the pre-M8
  // free functions for the call sites not yet threaded; they are threaded now, those functions are
  // gone, and `useSettingsRuntime()` THROWS without a provider — so a component outside this tree
  // fails loudly instead of silently reading an un-hydrated second runtime's registry defaults.
  // (trmx-250: the trmx-253 module-state audit in settingsRuntime.moduleState.test.ts now parses
  // THIS file too, and fails on ANY module-scoped value binding here — `let`, `var` or `const`,
  // whatever it is named or initialised with — because a runtime singleton such as
  // `export const shared = createSettingsRuntime()` is a const the module never writes through,
  // which the mutable-state rule alone cannot see. This module's scope is imports, an interface
  // and function declarations, and the audit keeps it that way.)
  const settingsRuntime = deps.createSettingsRuntime();
  await settingsRuntime.hydrate();
  // trmx-89: the persisted `appearance.theme` can be a `user:<stem>` id, so the runtime theme
  // registry must be populated (themes_read → registerUserThemes) BEFORE the startup theme paint
  // resolves that id — otherwise resolveTheme can't find a valid persisted user theme yet and it
  // paints as the derived-default fallback on the very first frame (trmx-202). A no-op without a backend (the read
  // rejects and nothing registers), so it stays safe on every launch surface.
  await deps.hydrateUserThemes();
  deps.applyStartupTheme({ settings: settingsRuntime.makeStore() });
  // trmx-204: the bundled-font gate, AFTER the themed paint (first frame stays fast) and BEFORE
  // anything can mount a terminal — mountTerminal measures the cell grid synchronously, so the
  // effective bundled face must be ready (or timed out into the fallback stack) by first render.
  // A no-op for the System default ("") and custom families. Executed by boot.test.tsx.
  await deps.ensureStartupFontLoaded(settingsRuntime.makeStore());

  let smokeDir: string | null = null;
  try {
    smokeDir = (await deps.invoke("smoke_config")) as string | null;
  } catch {
    // Two causes now, both benign: no backend (plain browser / jsdom), OR — since trmx-252 made
    // smoke_config/perf_config main-only — a capability rejection in the settings window,
    // because boot() invokes these before it resolves the surface. Either way: normal path.
  }

  if (smokeDir) {
    await deps.runSmoke(smokeDir);
    return; // the backend exits via smoke_done
  }

  // trmx-78: the NFR-1 perf harness gate, directly beside the smoke gate (smoke wins if both are
  // somehow set — the backend's launch_modes already enforces that). A perf launch mounts the real
  // terminal pipeline into #root (no React tree) and the backend exits via perf_done.
  let perfConfig: PerfLaunchConfig | null = null;
  try {
    perfConfig = (await deps.invoke("perf_config")) as PerfLaunchConfig | null;
  } catch {
    // Two causes now, both benign: no backend (plain browser / jsdom), OR — since trmx-252 made
    // smoke_config/perf_config main-only — a capability rejection in the settings window,
    // because boot() invokes these before it resolves the surface. Either way: normal path.
  }
  if (perfConfig) {
    // trmx-103: the backend's `scenario` picks the driver — `multipane` runs the v0.0.9
    // Beta-hardening multi-pane load; anything else keeps the unchanged single-pane default.
    if (perfConfig.scenario === "multipane") {
      await deps.runPerfMultipane(perfConfig, settingsRuntime.makeStore());
    } else {
      await deps.runPerf(perfConfig, settingsRuntime.makeStore());
    }
    return; // the backend exits via perf_done
  }

  const surface = deps.resolveSurface(deps.locationSearch());
  // trmx-224: pre-fetch cold-launch service dirs BEFORE mounting App, so plain boot stays
  // fully synchronous (the boot contract) while a service-triggered launch opens the
  // requested dirs as the initial tabs. Fail-soft: no runtime / junk payload ⇒ []. Only the
  // MAIN surface may drain the queue — the settings window must never steal queued paths.
  const serviceBootPaths = surface.kind === "settings" ? [] : await deps.takePendingOpenPaths();
  const root = deps.root();
  if (!root) throw new Error("boot: #root is missing");
  deps.render(
    root,
    <React.StrictMode>
      {/* trmx-253 (T3.3): ONE provider above BOTH branches — the same runtime instance supplies
          the settings window's host and the main window's UpdateAuthorityHost. */}
      <SettingsRuntimeProvider runtime={settingsRuntime}>
        {surface.kind === "settings" ? (
          // trmx-237 (H3): the settings boundary offers "Close window", never Quit — `quit_confirmed`
          // refuses non-PTY-owner callers, so a Quit button here would be inert while the main window's
          // shells stayed alive.
          <ErrorBoundary
            surface="settings"
            onReload={deps.reload}
            onCloseWindow={deps.closeWindow}
            onError={(error, componentStack) => reportFatal(deps, error, componentStack)}
          >
            <SettingsWindowHost initialSection={surface.section} />
          </ErrorBoundary>
        ) : (
          <ErrorBoundary
            surface="main"
            onReload={deps.reload}
            onQuit={deps.quit}
            onError={(error, componentStack) => reportFatal(deps, error, componentStack)}
          >
            <App deps={{ serviceBootPaths }} />
          </ErrorBoundary>
        )}
      </SettingsRuntimeProvider>
    </React.StrictMode>,
  );
}

// trmx-237 (H3): the recovery actions live in main.tsx as `realBootDeps` (reload / quit /
// closeWindow); what stays here is the surface of last resort for failures a React boundary
// cannot see — a rejected boot() (which runs BEFORE any component exists) and the asynchronous
// errors that never pass through render: `error` and `unhandledrejection`. Without these the
// window is blank with no explanation while the PTY children keep running in Rust.
function reportFatal(deps: BootDeps, error: unknown, componentStack?: string): void {
  deps.log.error("webview fatal", componentStack ? `${formatError(error)} ${componentStack}` : error);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Render the recovery surface for a failure that never reached a component (boot / global handlers). */
export function renderFatalSurface(deps: BootDeps, error: unknown): void {
  const root = deps.root();
  if (!root) return;
  const surface = deps.resolveSurface(deps.locationSearch());
  const Throw = (): never => {
    throw error instanceof Error ? error : new Error(String(error));
  };
  const onError = (err: unknown, componentStack?: string): void => reportFatal(deps, err, componentStack);
  deps.render(
    root,
    surface.kind === "settings" ? (
      <ErrorBoundary surface="settings" onReload={deps.reload} onCloseWindow={deps.closeWindow} onError={onError}>
        <Throw />
      </ErrorBoundary>
    ) : (
      <ErrorBoundary surface="main" onReload={deps.reload} onQuit={deps.quit} onError={onError}>
        <Throw />
      </ErrorBoundary>
    ),
  );
}

/**
 * Registered before boot() so a failure during startup is caught too. Separate registrations,
 * separately tested: `error` covers a synchronous throw outside React, `unhandledrejection` an
 * un-caught promise.
 */
export function installGlobalHandlers(deps: BootDeps): void {
  window.addEventListener("error", (event) => {
    deps.log.error("webview uncaught error", event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    deps.log.error("webview unhandled rejection", event.reason);
  });
}

/** The production wiring, executable: handlers first, then the boot, then the surface of last resort. */
export function start(deps: BootDeps): Promise<void> {
  installGlobalHandlers(deps);
  return boot(deps).catch((err: unknown) => {
    // The pinned startup chain rejected: no component ever mounted, so no boundary can be holding
    // the screen. Report, then render the same surface directly.
    deps.log.error("boot failed", err);
    renderFatalSurface(deps, err);
  });
}
