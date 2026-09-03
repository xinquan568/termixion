// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// The webview entry: WIRING ONLY (trmx-250, L10). The boot path itself — the pinned startup
// order, the settings composition root, the smoke/perf gates, the surface mount, the global
// failure handlers and the surface of last resort — lives in boot.tsx, where it is executed by
// boot.test.tsx against a recorder. This file binds each `BootDeps` member to its real
// implementation and hands the object to `start` once. It cannot be imported under jsdom (it
// boots the real app), so main.shim.test.ts pins the one fact that matters here textually: a
// single `start` call, receiving `realBootDeps`.
import ReactDOM from "react-dom/client";
import { start, type BootDeps } from "./boot";
import { realInvoke, takePendingOpenPaths } from "./ipc/backend";
import { log } from "./ipc/logSink";
import { runPerf, runPerfMultipane, realPerfDeps } from "./perf/runPerf";
import { runSmoke, realSmokeDeps } from "./smoke/runSmoke";
import { createSettingsRuntime } from "./store/settingsStore";
import { resolveSurface } from "./surface";
import { hydrateUserThemes } from "./theme/themesBackend";
import { applyStartupTheme } from "./startup/applyStartupTheme";
import { ensureStartupFontLoaded } from "./terminal/fontCatalog";
import "./index.css";
import "./fonts.css";

const realBootDeps: BootDeps = {
  createSettingsRuntime,
  // The registry hydration resolves the entries it registered; the boot only needs it awaited.
  hydrateUserThemes: async () => {
    await hydrateUserThemes();
  },
  applyStartupTheme,
  ensureStartupFontLoaded,
  invoke: realInvoke,
  runSmoke: async (dir) => {
    await runSmoke(dir, realSmokeDeps);
  },
  runPerf: async (config, settings) => {
    await runPerf(config, realPerfDeps(settings));
  },
  runPerfMultipane: async (config, settings) => {
    await runPerfMultipane(config, realPerfDeps(settings));
  },
  resolveSurface,
  locationSearch: () => window.location.search,
  takePendingOpenPaths,
  root: () => document.getElementById("root"),
  render: (root, tree) => ReactDOM.createRoot(root).render(tree),
  // trmx-237 (H3): the recovery actions the error boundaries offer. Each is injected so the
  // boundary performs no IPC and imports no Tauri API itself.
  reload: () => {
    window.location.reload();
  },
  quit: () => {
    realInvoke("quit_confirmed").catch(() => {
      /* no runtime — a plain browser tab owns its own lifecycle */
    });
  },
  closeWindow: () => {
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().close())
      .catch(() => {
        /* no runtime */
      });
  },
  log,
};

void start(realBootDeps);
