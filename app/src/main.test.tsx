// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-250 (L10, Step-9 finding 1): main.tsx EXECUTED.
//
// "main.tsx cannot be imported under jsdom" was true only because importing it booted the app.
// With `./boot`'s `start` mocked, the module evaluates like any other, and what it does at import
// becomes observable — which is what the deleted main.order.test.ts pinned by counting substrings:
// exactly one runtime construction, no module-level theme paint, one font gate. Those file-level
// facts are executed here as ONE fact: the only startup action main.tsx takes at import is a single
// `start(realBootDeps)` call — every startup-work module it imports is wrapped in a spy and must be
// uncalled after evaluation. Then each `realBootDeps` member is shown to be the real edge: the
// identity of the real export where main.tsx passes one through, and the observable call where it
// wraps one (the perf/smoke drivers, the recovery actions, the React root).
//
// Mutation-checked: a top-level `createSettingsRuntime();` added to main.tsx fails the first test.
//
// Module-registry note: the mocks below are created with `vi.hoisted` and the file imports main.tsx
// exactly ONCE (in `beforeAll`), because module evaluation is the act under test and a re-import
// would not re-run it.
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BootDeps } from "./boot";

const h = vi.hoisted(() => ({
  // Typed by call signature (not by an unused parameter): `mock.calls[0][0]` must be a BootDeps.
  start: vi.fn<(deps: BootDeps) => Promise<void>>(() => Promise.resolve()),
  render: vi.fn(),
  createRoot: vi.fn(),
  close: vi.fn(() => Promise.resolve()),
  invoke: vi.fn(() => Promise.reject(new Error("no runtime"))),
  hydrateUserThemes: vi.fn(() => Promise.resolve([])),
  runSmoke: vi.fn(() => Promise.resolve()),
  runPerf: vi.fn(() => Promise.resolve({ pass: true })),
  runPerfMultipane: vi.fn(() => Promise.resolve({ pass: true })),
  realPerfDeps: vi.fn(() => ({ perfDeps: true })),
}));

vi.mock("./boot", () => ({ start: h.start }));
vi.mock("react-dom/client", () => ({
  default: {
    createRoot: (root: unknown) => {
      h.createRoot(root);
      return { render: h.render };
    },
  },
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ close: h.close }) }));
vi.mock("./ipc/backend", async (importOriginal) => {
  const real = await importOriginal<typeof import("./ipc/backend")>();
  return { ...real, realInvoke: h.invoke, takePendingOpenPaths: vi.fn(real.takePendingOpenPaths) };
});
vi.mock("./store/settingsStore", async (importOriginal) => {
  const real = await importOriginal<typeof import("./store/settingsStore")>();
  return { ...real, createSettingsRuntime: vi.fn(real.createSettingsRuntime) };
});
vi.mock("./startup/applyStartupTheme", async (importOriginal) => {
  const real = await importOriginal<typeof import("./startup/applyStartupTheme")>();
  return { ...real, applyStartupTheme: vi.fn(real.applyStartupTheme) };
});
vi.mock("./terminal/fontCatalog", async (importOriginal) => {
  const real = await importOriginal<typeof import("./terminal/fontCatalog")>();
  return { ...real, ensureStartupFontLoaded: vi.fn(real.ensureStartupFontLoaded) };
});
vi.mock("./theme/themesBackend", async (importOriginal) => {
  const real = await importOriginal<typeof import("./theme/themesBackend")>();
  return { ...real, hydrateUserThemes: h.hydrateUserThemes };
});
vi.mock("./smoke/runSmoke", async (importOriginal) => {
  const real = await importOriginal<typeof import("./smoke/runSmoke")>();
  return { ...real, runSmoke: h.runSmoke };
});
vi.mock("./perf/runPerf", async (importOriginal) => {
  const real = await importOriginal<typeof import("./perf/runPerf")>();
  return { ...real, runPerf: h.runPerf, runPerfMultipane: h.runPerfMultipane, realPerfDeps: h.realPerfDeps };
});

import { realInvoke, takePendingOpenPaths } from "./ipc/backend";
import { log } from "./ipc/logSink";
import { createSettingsRuntime } from "./store/settingsStore";
import { applyStartupTheme } from "./startup/applyStartupTheme";
import { ensureStartupFontLoaded } from "./terminal/fontCatalog";
import { resolveSurface } from "./surface";
import { realSmokeDeps } from "./smoke/runSmoke";
import type { PerfLaunchConfig } from "./perf/runPerf";
import { freshSettingsStore } from "./test/settingsRuntime";

/** Drain the microtask queue a few turns — the wrappers under test are one-await promise chains. */
const drain = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

let deps: BootDeps;

beforeAll(async () => {
  await import("./main");
  expect(h.start).toHaveBeenCalledTimes(1);
  deps = h.start.mock.calls[0][0];
});

describe("main.tsx at import (trmx-250 L10): the ONLY startup action is one start(realBootDeps)", () => {
  it("calls start exactly once, with an object that has every BootDeps member", () => {
    expect(h.start).toHaveBeenCalledTimes(1);
    expect(Object.keys(deps).sort()).toEqual(
      [
        "applyStartupTheme",
        "closeWindow",
        "createSettingsRuntime",
        "ensureStartupFontLoaded",
        "hydrateUserThemes",
        "invoke",
        "locationSearch",
        "log",
        "quit",
        "reload",
        "render",
        "resolveSurface",
        "root",
        "runPerf",
        "runPerfMultipane",
        "runSmoke",
        "takePendingOpenPaths",
      ].sort(),
    );
  });

  it("does NO startup work of its own at module load: no runtime, no theme paint, no font gate, no themes, no IPC, no React root", () => {
    // The deleted main.order.test.ts pinned these as substring counts over the file. Executed, the
    // property is stronger and name-independent: whatever main.tsx might grow, the startup-work
    // modules it imports are spies here, and none may have fired by the time `start` was called.
    expect(createSettingsRuntime).not.toHaveBeenCalled();
    expect(applyStartupTheme).not.toHaveBeenCalled();
    expect(ensureStartupFontLoaded).not.toHaveBeenCalled();
    expect(h.hydrateUserThemes).not.toHaveBeenCalled();
    expect(h.invoke).not.toHaveBeenCalled();
    expect(takePendingOpenPaths).not.toHaveBeenCalled();
    expect(h.createRoot).not.toHaveBeenCalled();
    expect(h.render).not.toHaveBeenCalled();
    expect(h.runSmoke).not.toHaveBeenCalled();
    expect(h.runPerf).not.toHaveBeenCalled();
    expect(h.runPerfMultipane).not.toHaveBeenCalled();
  });
});

describe("realBootDeps: each member is the real edge", () => {
  it("passes the real exports through by identity where boot.tsx can call them directly", () => {
    expect(deps.createSettingsRuntime).toBe(createSettingsRuntime);
    expect(deps.applyStartupTheme).toBe(applyStartupTheme);
    expect(deps.ensureStartupFontLoaded).toBe(ensureStartupFontLoaded);
    expect(deps.invoke).toBe(realInvoke);
    expect(deps.takePendingOpenPaths).toBe(takePendingOpenPaths);
    expect(deps.resolveSurface).toBe(resolveSurface);
    expect(deps.log).toBe(log);
  });

  it("hydrateUserThemes: awaits the registry hydration and resolves void", async () => {
    await expect(deps.hydrateUserThemes()).resolves.toBeUndefined();
    expect(h.hydrateUserThemes).toHaveBeenCalledTimes(1);
  });

  it("runSmoke: drives the smoke over the dir with the real smoke deps", async () => {
    await deps.runSmoke("/tmp/smoke-dir");
    expect(h.runSmoke).toHaveBeenCalledWith("/tmp/smoke-dir", realSmokeDeps);
  });

  it("runPerf / runPerfMultipane: build the real perf deps from the given settings store", async () => {
    const settings = freshSettingsStore();
    const config: PerfLaunchConfig = { outDir: "/tmp/perf", build: "release" };
    await deps.runPerf(config, settings);
    expect(h.realPerfDeps).toHaveBeenLastCalledWith(settings);
    expect(h.runPerf).toHaveBeenCalledWith(config, { perfDeps: true });
    const multi: PerfLaunchConfig = { outDir: "/tmp/perf", build: "release", scenario: "multipane" };
    await deps.runPerfMultipane(multi, settings);
    expect(h.realPerfDeps).toHaveBeenLastCalledWith(settings);
    expect(h.runPerfMultipane).toHaveBeenCalledWith(multi, { perfDeps: true });
  });

  it("locationSearch reads window.location.search; root reads #root; render mounts a React root there", () => {
    expect(deps.locationSearch()).toBe(window.location.search);
    expect(deps.root()).toBeNull(); // no #root in this document yet
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    try {
      expect(deps.root()).toBe(root);
      const tree = <div data-testid="tree" />;
      deps.render(root, tree);
      expect(h.createRoot).toHaveBeenCalledWith(root);
      expect(h.render).toHaveBeenCalledWith(tree);
    } finally {
      root.remove();
    }
  });

  it("quit: asks the backend for quit_confirmed and swallows a no-runtime rejection", async () => {
    expect(() => deps.quit()).not.toThrow();
    await drain();
    expect(h.invoke).toHaveBeenCalledWith("quit_confirmed");
  });

  it("closeWindow: closes the current Tauri window, and swallows a no-runtime failure", async () => {
    // The member goes through a dynamic `import()`, which resolves through the module loader rather
    // than the microtask queue, so this is a bounded liveness wait on a POSITIVE (the call lands),
    // not a sleep-then-look negative.
    deps.closeWindow();
    await vi.waitFor(() => expect(h.close).toHaveBeenCalledTimes(1));
    h.close.mockImplementationOnce(() => Promise.reject(new Error("no runtime")));
    expect(() => deps.closeWindow()).not.toThrow();
    await vi.waitFor(() => expect(h.close).toHaveBeenCalledTimes(2));
  });

  it("reload: reloads the webview (jsdom does not implement navigation, so only the call is exercised)", () => {
    expect(() => deps.reload()).not.toThrow();
  });
});
