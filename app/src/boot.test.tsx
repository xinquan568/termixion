// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-250 (L10, T4.2): the boot path is EXECUTED here, not read.
//
// Until this change main.order.test.ts and main.handlers.test.ts pinned the startup order, the
// composition root and the global failure handlers by INDEX ARITHMETIC over main.tsx's raw text —
// `source.indexOf("await ")` twenty characters before a call site — because main.tsx boots the real
// app and cannot be imported under jsdom. boot.tsx takes every external effect as a dependency, so
// the same facts are now asserted by running the code against a RECORDER: a `BootDeps` whose every
// function pushes its name and arguments to a log, whose `render` captures the React element tree
// instead of mounting it, and whose `createSettingsRuntime` hands out a fake implementing the full
// `SettingsRuntime` interface with `hydrate` / `makeStore` recorded.
//
// Element-shape assertions inspect the CAPTURED element tree (`type`, `props`, `props.children`).
// Nothing here mounts `App` — it boots terminals — which is exactly why `render` is a dependency.
//
// `locationSearch()` and `root()` are pure reads, not steps, and are deliberately not in the
// sequence log; `makeStore()` is recorded on the runtime that made the store, since the assertion
// about stores is "came from THIS runtime", not "happened at step N".
import React, { type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { boot, installGlobalHandlers, renderFatalSurface, start, type BootDeps } from "./boot";
import { ErrorBoundary } from "./ErrorBoundary";
import { SettingsWindowHost } from "./settings/SettingsWindowHost";
import type { PerfLaunchConfig } from "./perf/runPerf";
import { SettingsRuntimeProvider } from "./store/settingsRuntimeContext";
import type { SettingsRuntime, SettingsStore } from "./store/settingsStore";
import { resolveSurface } from "./surface";
import { freshSettingsRuntime } from "./test/settingsRuntime";

// ------------------------------------------------------------------------------------------------
// The recorder.
// ------------------------------------------------------------------------------------------------

interface Call {
  name: string;
  args: unknown[];
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Drain the microtask queue until the recorder is QUIESCENT — deterministic and timer-free, which
 * matters in the PR that removes timers from tests (trmx-250). Every step of boot() between two
 * awaits is a bounded chain of microtasks, so once the recorder has not grown for a burst of empty
 * turns, boot is parked on the deferred gate and everything a wrongly-unawaited step could have
 * queued has run. Stopping early can only FAIL the prefix assertion that follows, never pass it.
 */
const settle = async (rec: Recorder): Promise<void> => {
  let idle = 0;
  for (let turn = 0; turn < 64 && idle < 8; turn += 1) {
    const before = rec.calls.length;
    await Promise.resolve();
    idle = rec.calls.length === before ? idle + 1 : 0;
  }
};

/** The fake runtime: the full interface, with `hydrate` recorded and every store it makes kept. */
interface FakeRuntime extends SettingsRuntime {
  readonly stores: SettingsStore[];
}

interface RecorderOptions {
  hydrate?: () => Promise<void>;
  hydrateUserThemes?: () => Promise<void>;
  ensureStartupFontLoaded?: () => Promise<void>;
  takePendingOpenPaths?: () => Promise<string[]>;
  /** What `smoke_config` / `perf_config` resolve; both resolve `null` by default (a plain launch). */
  invoke?: (cmd: string) => Promise<unknown>;
  /** The `window.location.search` the boot sees; empty (the main surface) by default. */
  search?: string;
  /** The `#root` element; a fresh div by default, `null` for the missing-root case. */
  root?: HTMLElement | null;
}

interface Recorder {
  deps: BootDeps;
  calls: Call[];
  names(): string[];
  rendered: Array<{ root: HTMLElement; tree: ReactElement }>;
  runtimes: FakeRuntime[];
  root: HTMLElement | null;
}

function makeRecorder(options: RecorderOptions = {}): Recorder {
  const calls: Call[] = [];
  const record = (name: string, ...args: unknown[]): void => {
    calls.push({ name, args });
  };
  const rendered: Recorder["rendered"] = [];
  const runtimes: FakeRuntime[] = [];
  const root = options.root === undefined ? document.createElement("div") : options.root;
  const resolved = (): Promise<void> => Promise.resolve();
  const invoke = options.invoke ?? (() => Promise.resolve(null));

  const fakeRuntime = (): FakeRuntime => {
    // Wrapping the real fixture runtime keeps every `SettingsStore` this fake hands out a REAL
    // store (the type is honoured, not cast) while the two recorded methods are ours.
    const real = freshSettingsRuntime();
    const stores: SettingsStore[] = [];
    const runtime: FakeRuntime = {
      stores,
      hydrate: () => {
        record("hydrate", runtime);
        return (options.hydrate ?? resolved)();
      },
      makeStore: (bus, source) => {
        const store = real.makeStore(bus, source);
        stores.push(store);
        return store;
      },
      getConfigWarnings: () => real.getConfigWarnings(),
      onConfigWarningsChanged: (cb) => real.onConfigWarningsChanged(cb),
      getConfigFilePath: () => real.getConfigFilePath(),
      openConfigFile: () => real.openConfigFile(),
      getLogDir: () => real.getLogDir(),
      openLogDir: () => real.openLogDir(),
      dispose: () => real.dispose(),
    };
    return runtime;
  };

  const deps: BootDeps = {
    createSettingsRuntime: () => {
      record("createSettingsRuntime");
      const runtime = fakeRuntime();
      runtimes.push(runtime);
      return runtime;
    },
    hydrateUserThemes: () => {
      record("hydrateUserThemes");
      return (options.hydrateUserThemes ?? resolved)();
    },
    applyStartupTheme: (args) => {
      record("applyStartupTheme", args);
    },
    ensureStartupFontLoaded: (settings) => {
      record("ensureStartupFontLoaded", settings);
      return (options.ensureStartupFontLoaded ?? resolved)();
    },
    invoke: (cmd, args) => {
      record(`invoke:${cmd}`, args);
      return invoke(cmd);
    },
    runSmoke: (dir) => {
      record("runSmoke", dir);
      return Promise.resolve();
    },
    runPerf: (config, settings) => {
      record("runPerf", config, settings);
      return Promise.resolve();
    },
    runPerfMultipane: (config, settings) => {
      record("runPerfMultipane", config, settings);
      return Promise.resolve();
    },
    resolveSurface: (search) => {
      record("resolveSurface", search);
      return resolveSurface(search);
    },
    locationSearch: () => options.search ?? "",
    takePendingOpenPaths: () => {
      record("takePendingOpenPaths");
      return (options.takePendingOpenPaths ?? (() => Promise.resolve([])))();
    },
    root: () => root,
    render: (target, tree) => {
      record("render", target, tree);
      rendered.push({ root: target, tree });
    },
    reload: () => record("reload"),
    quit: () => record("quit"),
    closeWindow: () => record("closeWindow"),
    log: {
      error: (context, detail) => record("log.error", context, detail),
    },
  };

  return { deps, calls, names: () => calls.map((c) => c.name), rendered, runtimes, root };
}

/** The recorded call named `name`, or a failure naming what WAS recorded. */
function callNamed(rec: Recorder, name: string): Call {
  const found = rec.calls.find((c) => c.name === name);
  if (!found) throw new Error(`no "${name}" recorded; recorded: ${rec.names().join(" → ")}`);
  return found;
}

const FULL_MAIN_SEQUENCE = [
  "createSettingsRuntime",
  "hydrate",
  "hydrateUserThemes",
  "applyStartupTheme",
  "ensureStartupFontLoaded",
  "invoke:smoke_config",
  "invoke:perf_config",
  "resolveSurface",
  "takePendingOpenPaths",
  "render",
];

// ------------------------------------------------------------------------------------------------
// Element-tree helpers: the captured tree is inspected, never mounted.
// ------------------------------------------------------------------------------------------------

type AnyElement = ReactElement<Record<string, unknown>>;

function elementChildren(el: AnyElement): AnyElement[] {
  const children = el.props.children as ReactNode;
  return React.Children.toArray(children).filter((c): c is AnyElement => React.isValidElement(c));
}

function findAll(el: AnyElement, type: unknown): AnyElement[] {
  const out: AnyElement[] = [];
  const walk = (node: AnyElement): void => {
    if (node.type === type) out.push(node);
    for (const child of elementChildren(node)) walk(child);
  };
  walk(el);
  return out;
}

function only(el: AnyElement, type: unknown): AnyElement {
  const all = findAll(el, type);
  expect(all).toHaveLength(1);
  return all[0];
}

function renderedTree(rec: Recorder): AnyElement {
  expect(rec.rendered).toHaveLength(1);
  return rec.rendered[0].tree as AnyElement;
}

const perfConfig = (scenario?: string): PerfLaunchConfig => ({
  outDir: "/tmp/perf",
  build: "test",
  ...(scenario ? { scenario } : {}),
});

// ================================================================================================
// boot(deps)
// ================================================================================================

describe("boot(deps): the pinned startup order, executed (trmx-80/89/204/224/253)", () => {
  it("runs runtime → hydrate → themes → theme paint → font gate → smoke → perf → surface → take → render, and nothing else", async () => {
    const rec = makeRecorder();
    await boot(rec.deps);
    expect(rec.names()).toEqual(FULL_MAIN_SEQUENCE);
    // One code path for all launches: the theme paint happens exactly once, inside boot — a
    // module-evaluation paint would have run before the recorder existed and could not appear here,
    // and a second one inside boot would double the entry.
    expect(rec.names().filter((n) => n === "applyStartupTheme")).toHaveLength(1);
  });

  it.each([
    ["hydrate", ["createSettingsRuntime", "hydrate"]],
    ["hydrateUserThemes", ["createSettingsRuntime", "hydrate", "hydrateUserThemes"]],
    [
      "ensureStartupFontLoaded",
      ["createSettingsRuntime", "hydrate", "hydrateUserThemes", "applyStartupTheme", "ensureStartupFontLoaded"],
    ],
    ["takePendingOpenPaths", FULL_MAIN_SEQUENCE.slice(0, -1)],
  ] as const)("awaits %s: the next step is NOT recorded until it resolves", async (gate, prefix) => {
    const pending = deferred<void>();
    const paths = deferred<string[]>();
    const rec = makeRecorder({
      [gate]: () => (gate === "takePendingOpenPaths" ? paths.promise : pending.promise),
    });
    const done = boot(rec.deps);
    await settle(rec);
    expect(rec.names()).toEqual([...prefix]);
    pending.resolve();
    paths.resolve([]);
    await done;
    expect(rec.names()).toEqual(FULL_MAIN_SEQUENCE);
  });
});

describe("boot(deps): the smoke and perf gates (C-3, trmx-78/93/103)", () => {
  it("smoke_config set: runs the smoke over that dir and RETURNS — no perf gate, no surface, no render", async () => {
    const rec = makeRecorder({
      invoke: (cmd) => Promise.resolve(cmd === "smoke_config" ? "/tmp/smoke" : null),
    });
    await boot(rec.deps);
    expect(rec.names()).toEqual([...FULL_MAIN_SEQUENCE.slice(0, 6), "runSmoke"]);
    expect(callNamed(rec, "runSmoke").args).toEqual(["/tmp/smoke"]);
    expect(rec.rendered).toEqual([]);
  });

  it("perf_config set: runs the single-pane perf driver over the runtime's store and RETURNS before any render", async () => {
    const config = perfConfig();
    const rec = makeRecorder({
      invoke: (cmd) => Promise.resolve(cmd === "perf_config" ? config : null),
    });
    await boot(rec.deps);
    expect(rec.names()).toEqual([...FULL_MAIN_SEQUENCE.slice(0, 7), "runPerf"]);
    const [gotConfig, gotStore] = callNamed(rec, "runPerf").args;
    expect(gotConfig).toBe(config);
    expect(rec.runtimes[0].stores.includes(gotStore as SettingsStore)).toBe(true);
    expect(rec.rendered).toEqual([]);
  });

  it('perf_config scenario "multipane" dispatches to runPerfMultipane, still before any render', async () => {
    const config = perfConfig("multipane");
    const rec = makeRecorder({
      invoke: (cmd) => Promise.resolve(cmd === "perf_config" ? config : null),
    });
    await boot(rec.deps);
    expect(rec.names()).toEqual([...FULL_MAIN_SEQUENCE.slice(0, 7), "runPerfMultipane"]);
    expect(rec.names()).not.toContain("runPerf");
    const [gotConfig, gotStore] = callNamed(rec, "runPerfMultipane").args;
    expect(gotConfig).toBe(config);
    expect(rec.runtimes[0].stores.includes(gotStore as SettingsStore)).toBe(true);
    expect(rec.rendered).toEqual([]);
  });

  it("both gates rejecting (no backend, or the settings window's capability denial) is benign: boot renders", async () => {
    const rec = makeRecorder({ invoke: () => Promise.reject(new Error("no runtime")) });
    await boot(rec.deps);
    expect(rec.names()).toEqual(FULL_MAIN_SEQUENCE);
    expect(rec.rendered).toHaveLength(1);
  });
});

describe("boot(deps): the mounted tree (trmx-51/224/237/253)", () => {
  it("main surface: StrictMode › ONE SettingsRuntimeProvider › ErrorBoundary(main: Reload + Quit, no Close) › App", async () => {
    const rec = makeRecorder();
    await boot(rec.deps);
    expect(rec.rendered[0].root).toBe(rec.root);
    const tree = renderedTree(rec);
    expect(tree.type).toBe(React.StrictMode);

    const provider = only(tree, SettingsRuntimeProvider);
    expect(elementChildren(tree)).toEqual([expect.objectContaining({ type: SettingsRuntimeProvider })]);
    const boundary = only(provider, ErrorBoundary);
    expect(elementChildren(provider)).toHaveLength(1);
    expect(boundary.props.surface).toBe("main");
    expect(typeof boundary.props.onReload).toBe("function");
    expect(typeof boundary.props.onQuit).toBe("function");
    expect(boundary.props.onCloseWindow).toBeUndefined();

    only(boundary, App);
    expect(elementChildren(boundary)).toHaveLength(1);
    expect(findAll(tree, SettingsWindowHost)).toEqual([]);
  });

  it("App receives, by identity, the array takePendingOpenPaths resolved (deps.serviceBootPaths)", async () => {
    const paths = ["/srv/one", "/srv/two"];
    const rec = makeRecorder({ takePendingOpenPaths: () => Promise.resolve(paths) });
    await boot(rec.deps);
    const app = only(renderedTree(rec), App);
    expect((app.props.deps as { serviceBootPaths: string[] }).serviceBootPaths).toBe(paths);
  });

  it("settings surface: never drains the queue; ErrorBoundary(settings: Reload + Close, no Quit) › SettingsWindowHost with the section", async () => {
    const rec = makeRecorder({ search: "?window=settings&section=appearance" });
    await boot(rec.deps);
    expect(rec.names()).toEqual(FULL_MAIN_SEQUENCE.filter((n) => n !== "takePendingOpenPaths"));
    expect(callNamed(rec, "resolveSurface").args).toEqual(["?window=settings&section=appearance"]);

    const tree = renderedTree(rec);
    const provider = only(tree, SettingsRuntimeProvider);
    const boundary = only(provider, ErrorBoundary);
    expect(boundary.props.surface).toBe("settings");
    expect(typeof boundary.props.onReload).toBe("function");
    expect(typeof boundary.props.onCloseWindow).toBe("function");
    expect(boundary.props.onQuit).toBeUndefined();

    const host = only(boundary, SettingsWindowHost);
    expect(host.props.initialSection).toBe("appearance");
    expect(findAll(tree, App)).toEqual([]);
  });

  it("the boundary's actions ARE the deps' recovery actions, and its onError reports through log.error", async () => {
    const rec = makeRecorder();
    await boot(rec.deps);
    const boundary = only(renderedTree(rec), ErrorBoundary);
    (boundary.props.onReload as () => void)();
    (boundary.props.onQuit as () => void)();
    expect(rec.names().slice(-2)).toEqual(["reload", "quit"]);

    const onError = boundary.props.onError as (error: unknown, componentStack?: string) => void;
    onError(new Error("render blew up"), "\n    at Broken");
    onError("not an Error");
    expect(rec.calls.slice(-2)).toEqual([
      { name: "log.error", args: ["webview fatal", "render blew up \n    at Broken"] },
      { name: "log.error", args: ["webview fatal", "not an Error"] },
    ]);

    // The settings branch is a SEPARATE boundary with its own reporting arrow — it must report too,
    // and a non-Error with a component stack is rendered through String().
    const settings = makeRecorder({ search: "?window=settings" });
    await boot(settings.deps);
    const settingsBoundary = only(renderedTree(settings), ErrorBoundary);
    (settingsBoundary.props.onCloseWindow as () => void)();
    (settingsBoundary.props.onError as typeof onError)("not an Error", "\n    at Broken");
    expect(settings.calls.slice(-2)).toEqual([
      { name: "closeWindow", args: [] },
      { name: "log.error", args: ["webview fatal", "not an Error \n    at Broken"] },
    ]);
  });
});

describe("boot(deps): the settings composition root (trmx-253 T3.3/T3.5)", () => {
  it("constructs exactly ONE runtime, hydrates THAT object before any consumer, feeds theme/font/perf from its makeStore(), and provides the same instance", async () => {
    const config = perfConfig();
    // One boot per gate outcome: the perf gate returns before render, so the store it is fed is
    // checked on a perf launch and the provider on a plain one.
    const plain = makeRecorder();
    await boot(plain.deps);
    expect(plain.runtimes).toHaveLength(1);
    const [runtime] = plain.runtimes;

    expect(callNamed(plain, "hydrate").args).toEqual([runtime]);
    const names = plain.names();
    expect(names.indexOf("hydrate")).toBeLessThan(names.indexOf("applyStartupTheme"));
    expect(names.indexOf("hydrate")).toBeLessThan(names.indexOf("ensureStartupFontLoaded"));

    const themeStore = (callNamed(plain, "applyStartupTheme").args[0] as { settings: SettingsStore }).settings;
    const fontStore = callNamed(plain, "ensureStartupFontLoaded").args[0] as SettingsStore;
    expect(runtime.stores.includes(themeStore)).toBe(true);
    expect(runtime.stores.includes(fontStore)).toBe(true);

    const provider = only(renderedTree(plain), SettingsRuntimeProvider);
    expect(provider.props.runtime).toBe(runtime);

    const perf = makeRecorder({ invoke: (cmd) => Promise.resolve(cmd === "perf_config" ? config : null) });
    await boot(perf.deps);
    expect(perf.runtimes).toHaveLength(1);
    expect(perf.runtimes[0].stores.includes(callNamed(perf, "runPerf").args[1] as SettingsStore)).toBe(true);
  });

  it("two independent boots yield two runtimes, two providers with different runtime objects, and disjoint stores", async () => {
    const first = makeRecorder();
    const second = makeRecorder();
    await boot(first.deps);
    await boot(second.deps);
    expect(first.runtimes).toHaveLength(1);
    expect(second.runtimes).toHaveLength(1);
    expect(first.runtimes[0]).not.toBe(second.runtimes[0]);

    const firstProvider = only(renderedTree(first), SettingsRuntimeProvider);
    const secondProvider = only(renderedTree(second), SettingsRuntimeProvider);
    expect(firstProvider.props.runtime).toBe(first.runtimes[0]);
    expect(secondProvider.props.runtime).toBe(second.runtimes[0]);
    expect(firstProvider.props.runtime).not.toBe(secondProvider.props.runtime);

    expect(first.runtimes[0].stores.length).toBeGreaterThan(0);
    for (const store of first.runtimes[0].stores) {
      expect(second.runtimes[0].stores.includes(store)).toBe(false);
    }
  });
});

// ================================================================================================
// installGlobalHandlers / renderFatalSurface / start
// ================================================================================================

describe("start(deps): the global failure handlers (trmx-237 H3)", () => {
  it("installs the window error + unhandledrejection listeners BEFORE boot proceeds, both reporting via log.error", () => {
    // hydrate never resolves: boot is parked at its first await, so anything the listeners do
    // is observed while the startup chain is provably still in flight.
    const rec = makeRecorder({ hydrate: () => new Promise<never>(() => {}) });
    void start(rec.deps);
    expect(rec.names()).toEqual(["createSettingsRuntime", "hydrate"]);

    const thrown = new Error("sync throw outside React");
    window.dispatchEvent(new ErrorEvent("error", { error: thrown, message: "ignored when error is set" }));
    window.dispatchEvent(new ErrorEvent("error", { message: "message-only error event" }));
    window.dispatchEvent(
      new PromiseRejectionEvent("unhandledrejection", { promise: Promise.resolve(), reason: "un-caught" }),
    );

    expect(rec.calls.slice(2)).toEqual([
      { name: "log.error", args: ["webview uncaught error", thrown] },
      { name: "log.error", args: ["webview uncaught error", "message-only error event"] },
      { name: "log.error", args: ["webview unhandled rejection", "un-caught"] },
    ]);
  });

  it("installGlobalHandlers alone registers both listeners (each reports separately)", () => {
    const rec = makeRecorder();
    installGlobalHandlers(rec.deps);
    window.dispatchEvent(new ErrorEvent("error", { error: "e" }));
    window.dispatchEvent(new PromiseRejectionEvent("unhandledrejection", { promise: Promise.resolve(), reason: "r" }));
    expect(rec.calls).toEqual([
      { name: "log.error", args: ["webview uncaught error", "e"] },
      { name: "log.error", args: ["webview unhandled rejection", "r"] },
    ]);
  });
});

describe("start(deps): a rejected boot logs and renders the recovery surface (trmx-237 H3)", () => {
  it.each([
    ["main", "", "main"],
    ["settings", "?window=settings", "settings"],
  ])("%s surface: log.error(\"boot failed\", err), then an ErrorBoundary whose child throws that error", async (_label, search, surface) => {
    const err = new Error("config_read exploded");
    const rec = makeRecorder({ search, hydrate: () => Promise.reject(err) });
    await start(rec.deps);

    expect(rec.names()).toEqual(["createSettingsRuntime", "hydrate", "log.error", "resolveSurface", "render"]);
    expect(callNamed(rec, "log.error").args).toEqual(["boot failed", err]);

    expect(rec.rendered[0].root).toBe(rec.root);
    const tree = renderedTree(rec);
    expect(tree.type).toBe(ErrorBoundary);
    expect(tree.props.surface).toBe(surface);
    if (surface === "main") {
      expect(typeof tree.props.onQuit).toBe("function");
      expect(tree.props.onCloseWindow).toBeUndefined();
    } else {
      expect(typeof tree.props.onCloseWindow).toBe("function");
      expect(tree.props.onQuit).toBeUndefined();
    }
    expect(findAll(tree, SettingsRuntimeProvider)).toEqual([]);

    const [child] = elementChildren(tree);
    let thrown: unknown;
    try {
      (child.type as () => never)();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(err);
  });

  it("a non-Error rejection is wrapped so the boundary still receives an Error", async () => {
    const rec = makeRecorder({ hydrate: () => Promise.reject("plain string") });
    await start(rec.deps);
    expect(callNamed(rec, "log.error").args).toEqual(["boot failed", "plain string"]);
    const [child] = elementChildren(renderedTree(rec));
    expect(() => (child.type as () => never)()).toThrow(new Error("plain string"));
  });

  it("without #root: boot rejects with `boot: #root is missing`, start logs it, and NOTHING is rendered", async () => {
    const direct = makeRecorder({ root: null });
    await expect(boot(direct.deps)).rejects.toThrow("boot: #root is missing");
    // The chain ran up to the mount and stopped there — the root is checked where it is used.
    expect(direct.names()).toEqual(FULL_MAIN_SEQUENCE.slice(0, -1));

    const rec = makeRecorder({ root: null });
    await start(rec.deps);
    const logged = callNamed(rec, "log.error");
    expect(logged.args[0]).toBe("boot failed");
    expect((logged.args[1] as Error).message).toBe("boot: #root is missing");
    expect(rec.rendered).toEqual([]);
    expect(rec.names()).not.toContain("render");
  });

  it("renderFatalSurface: a no-op without a root; with one, the surface boundary around a throwing child", () => {
    const err = new Error("late");
    const none = makeRecorder({ root: null });
    renderFatalSurface(none.deps, err);
    expect(none.calls).toEqual([]);

    const rec = makeRecorder({ search: "?window=settings&section=about" });
    renderFatalSurface(rec.deps, err);
    expect(rec.names()).toEqual(["resolveSurface", "render"]);
    const tree = renderedTree(rec);
    expect(tree.type).toBe(ErrorBoundary);
    expect(tree.props.surface).toBe("settings");
    const [child] = elementChildren(tree);
    expect(() => (child.type as () => never)()).toThrow(err);
    // The fatal boundary reports through the same sink as the mounted one.
    (tree.props.onError as (error: unknown, componentStack?: string) => void)(err, "\n    at Throw");
    expect(rec.calls.at(-1)).toEqual({ name: "log.error", args: ["webview fatal", "late \n    at Throw"] });
  });
});
