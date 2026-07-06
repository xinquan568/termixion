// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { SettingsWindowHost } from "./settings/SettingsWindowHost";
import { resolveSurface } from "./surface";
import { realInvoke } from "./ipc/backend";
import { runPerf, runPerfMultipane, realPerfDeps, type PerfLaunchConfig } from "./perf/runPerf";
import { runSmoke, realSmokeDeps } from "./smoke/runSmoke";
import { hydrateSettings } from "./settings/settingsStore";
import { hydrateUserThemes } from "./theme/themesBackend";
import { applyStartupTheme } from "./theme/applyStartupTheme";
import "./index.css";

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
  // paints as the White fallback on the very first frame. A no-op without a backend (the read
  // rejects and nothing registers), so it stays safe on every launch surface.
  await hydrateUserThemes();
  applyStartupTheme();

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
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      {surface.kind === "settings" ? (
        <SettingsWindowHost initialSection={surface.section} />
      ) : (
        <App />
      )}
    </React.StrictMode>,
  );
}

void boot();
