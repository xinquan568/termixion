// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { realInvoke } from "./ipc/backend";
import { runSmoke, realSmokeDeps } from "./smoke/runSmoke";
import "./index.css";

// On boot, ask the backend whether this is a `--smoke` launch (C-3). If so, drive the deterministic
// sentinel sequence over the production channel and let the backend exit 0/1 — no UI. Otherwise render
// the normal terminal app. A plain browser (`pnpm dev`) has no backend, so smoke_config rejects → app.
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

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void boot();
