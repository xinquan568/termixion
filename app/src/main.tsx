// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { SettingsWindowHost } from "./settings/SettingsWindowHost";
import { resolveSurface } from "./surface";
import { realInvoke } from "./ipc/backend";
import { runSmoke, realSmokeDeps } from "./smoke/runSmoke";
import { applyStartupTheme } from "./theme/applyStartupTheme";
import "./index.css";

// trmx-53: paint the PERSISTED theme before anything else — synchronously at module evaluation,
// strictly before boot()'s smoke_config await opens an async gap in which index.css's static
// fallback would show (no-flash startup; ordering guarded by main.order.test.ts). Harmless on a
// --smoke launch (no UI renders).
applyStartupTheme();

// On boot, ask the backend whether this is a `--smoke` launch (C-3). If so, drive the deterministic
// sentinel sequence over the production channel and let the backend exit 0/1 — no UI. Otherwise render
// the surface this window is for (trmx-51): the shell opens the settings window at
// `?window=settings[&section=…]`; everything else — the main window, `pnpm dev` in a plain browser —
// is the terminal. A plain browser has no backend, so smoke_config rejects → app.
async function boot() {
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
