// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { SettingsWindowHost } from "./settings/SettingsWindowHost";
import { resolveSurface } from "./surface";
import { realInvoke, takePendingOpenPaths } from "./ipc/backend";
import { log } from "./ipc/logSink";
import { runPerf, runPerfMultipane, realPerfDeps, type PerfLaunchConfig } from "./perf/runPerf";
import { runSmoke, realSmokeDeps } from "./smoke/runSmoke";
import { hydrateSettings, makeSettingsStore } from "./settings/settingsStore";
import { hydrateUserThemes } from "./theme/themesBackend";
import { applyStartupTheme } from "./theme/applyStartupTheme";
import { ensureStartupFontLoaded } from "./terminal/fontCatalog";
import "./index.css";
import "./fonts.css";

// The pinned startup order (trmx-80, guarded by main.order.test.ts): hydrate → theme → gates →
// mount — ONE code path for all launches. Settings are file-backed (FR-13), so exactly one
// config_read must land before the themed first paint: hydrateSettings seeds the shared settings
// snapshot (and runs the one-time legacy-localStorage migration), then applyStartupTheme paints
// the persisted theme from it, superseding trmx-53's module-evaluation paint (which could read
// localStorage synchronously — a file-backed theme cannot be read without the IPC round-trip).
// index.css's static fallback covers the hydrate await; hydrateSettings never throws (a plain
// browser falls back to the registry defaults).
//
// After the paint, boot() asks the backend whether this is a `--smoke` launch (C-3). If so, drive
// the deterministic sentinel sequence over the production channel and let the backend exit 0/1 —
// no UI. Otherwise render the surface this window is for (trmx-51): the shell opens the settings
// window at `?window=settings[&section=…]`; everything else — the main window, `pnpm dev` in a
// plain browser — is the terminal. A plain browser has no backend, so smoke_config rejects → app.
async function boot() {
  await hydrateSettings();
  // trmx-89: the persisted `appearance.theme` can be a `user:<stem>` id, so the runtime theme
  // registry must be populated (themes_read → registerUserThemes) BEFORE the startup theme paint
  // resolves that id — otherwise resolveTheme can't find a valid persisted user theme yet and it
  // paints as the derived-default fallback on the very first frame (trmx-202). A no-op without a backend (the read
  // rejects and nothing registers), so it stays safe on every launch surface.
  await hydrateUserThemes();
  applyStartupTheme();
  // trmx-204: the bundled-font gate, AFTER the themed paint (first frame stays fast) and BEFORE
  // anything can mount a terminal — mountTerminal measures the cell grid synchronously, so the
  // effective bundled face must be ready (or timed out into the fallback stack) by first render.
  // A no-op for the System default ("") and custom families. Guarded by main.order.test.ts.
  await ensureStartupFontLoaded(makeSettingsStore());

  let smokeDir: string | null = null;
  try {
    smokeDir = (await realInvoke("smoke_config")) as string | null;
  } catch {
    smokeDir = null;
  }

  if (smokeDir) {
    await runSmoke(smokeDir, realSmokeDeps);
    return; // the backend exits via smoke_done
  }

  // trmx-78: the NFR-1 perf harness gate, directly beside the smoke gate (smoke wins if both are
  // somehow set — the backend's launch_modes already enforces that). A perf launch mounts the real
  // terminal pipeline into #root (no React tree) and the backend exits via perf_done.
  let perfConfig: PerfLaunchConfig | null = null;
  try {
    perfConfig = (await realInvoke("perf_config")) as PerfLaunchConfig | null;
  } catch {
    perfConfig = null;
  }
  if (perfConfig) {
    // trmx-103: the backend's `scenario` picks the driver — `multipane` runs the v0.0.9
    // Beta-hardening multi-pane load; anything else keeps the unchanged single-pane default.
    if (perfConfig.scenario === "multipane") {
      await runPerfMultipane(perfConfig, realPerfDeps());
    } else {
      await runPerf(perfConfig, realPerfDeps());
    }
    return; // the backend exits via perf_done
  }

  const surface = resolveSurface(window.location.search);
  // trmx-224: pre-fetch cold-launch service dirs BEFORE mounting App, so plain boot stays
  // fully synchronous (the boot contract) while a service-triggered launch opens the
  // requested dirs as the initial tabs. Fail-soft: no runtime / junk payload ⇒ []. Only the
  // MAIN surface may drain the queue — the settings window must never steal queued paths.
  const serviceBootPaths = surface.kind === "settings" ? [] : await takePendingOpenPaths();
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      {surface.kind === "settings" ? (
        // trmx-237 (H3): the settings boundary offers "Close window", never Quit — `quit_confirmed`
        // refuses non-PTY-owner callers, so a Quit button here would be inert while the main window's
        // shells stayed alive.
        <ErrorBoundary surface="settings" onReload={reloadWebview} onCloseWindow={closeThisWindow} onError={reportFatal}>
          <SettingsWindowHost initialSection={surface.section} />
        </ErrorBoundary>
      ) : (
        <ErrorBoundary surface="main" onReload={reloadWebview} onQuit={quitApp} onError={reportFatal}>
          <App serviceBootPaths={serviceBootPaths} />
        </ErrorBoundary>
      )}
    </React.StrictMode>,
  );
}

// trmx-237 (H3): the recovery actions, and the surface of last resort for failures a React boundary
// cannot see — a rejected boot() (which runs BEFORE any component exists) and the asynchronous errors
// that never pass through render: `error` and `unhandledrejection`. Without these the window is blank
// with no explanation while the PTY children keep running in Rust.
function reloadWebview(): void {
  window.location.reload();
}

function quitApp(): void {
  realInvoke("quit_confirmed").catch(() => {
    /* no runtime — a plain browser tab owns its own lifecycle */
  });
}

function closeThisWindow(): void {
  void import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().close())
    .catch(() => {
      /* no runtime */
    });
}

function reportFatal(error: unknown, componentStack?: string): void {
  log.error("webview fatal", componentStack ? `${formatError(error)} ${componentStack}` : error);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Render the recovery surface for a failure that never reached a component (boot / global handlers). */
function renderFatalSurface(error: unknown): void {
  const root = document.getElementById("root");
  if (!root) return;
  const surface = resolveSurface(window.location.search);
  const Throw = (): never => {
    throw error instanceof Error ? error : new Error(String(error));
  };
  ReactDOM.createRoot(root).render(
    surface.kind === "settings" ? (
      <ErrorBoundary surface="settings" onReload={reloadWebview} onCloseWindow={closeThisWindow} onError={reportFatal}>
        <Throw />
      </ErrorBoundary>
    ) : (
      <ErrorBoundary surface="main" onReload={reloadWebview} onQuit={quitApp} onError={reportFatal}>
        <Throw />
      </ErrorBoundary>
    ),
  );
}

// Registered before boot() so a failure during startup is caught too. Separate registrations, separately
// tested: `error` covers a synchronous throw outside React, `unhandledrejection` an un-caught promise.
window.addEventListener("error", (event) => {
  log.error("webview uncaught error", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  log.error("webview unhandled rejection", event.reason);
});

boot().catch((err: unknown) => {
  // The pinned startup chain rejected: no component ever mounted, so no boundary can be holding the
  // screen. Report, then render the same surface directly.
  log.error("boot failed", err);
  renderFatalSurface(err);
});
