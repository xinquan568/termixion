// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-253 (T3.4) — THE shared fresh-runtime fixture for tests.
//
// WHY THIS FILE EXISTS. Before T3.4 a test that wanted an isolated settings store had two ways to
// get one, and both were wrong in the end: inject a fake `KeyValueStore` (the test-only legacy
// storage backend, which T3.5 deletes) or call `__resetSettingsForTest()` between cases (a global
// reset for a global snapshot, which T3.5 also deletes). Twenty-six files did one or the other.
// Handing each of them a hand-rolled `createSettingsRuntime()` would just be how the NEXT
// `__resetSettingsForTest` gets invented — so isolation lives here, once, and every suite asks for
// it the same way.
//
// WHAT ISOLATION MEANS NOW. `createSettingsRuntime()` closes over all ten pieces of settings state,
// so a runtime per test IS the isolation: nothing is shared, and nothing needs resetting. The only
// two things this fixture adds on top are defaults that keep a unit test off the real edges:
//
//   - `invoke` resolves `undefined` instead of reaching for a Tauri runtime that is not there.
//     A real `realInvoke` rejects under jsdom, which would make every `set()` in every converted
//     test author a spurious "Could not save …" client warning (trmx-238's write-failure ledger).
//   - `storage` is an empty in-memory map rather than jsdom's shared `localStorage`, so the T3b
//     legacy-key migration cannot leak values between test files that run in one worker.
//
// Both are plain defaults: a suite that is ABOUT the invoke channel or the migration passes its
// own and gets exactly what it passed.
//
// Lives under `src/test/` deliberately — that path is excluded from the coverage denominator
// (vite.config.ts), so a test fixture never inflates the measured numbers.
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { SettingsRuntimeProvider } from "../store/settingsRuntimeContext";
import {
  createSettingsRuntime,
  type KeyValueStore,
  type SettingsBus,
  type SettingsRuntime,
  type SettingsRuntimeDeps,
  type SettingsStore,
} from "../store/settingsStore";

/** An in-memory `KeyValueStore` — the legacy-migration source, and nothing else, since T3.5. */
export function memoryStorage(initial: Record<string, string> = {}): KeyValueStore & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k)! : null),
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

/**
 * A settings runtime for ONE test: its own snapshot, warnings, write channel and subscriptions.
 * Pass `invoke`/`bus`/`storage` to override the quiet defaults described in the header.
 */
export function freshSettingsRuntime(deps: SettingsRuntimeDeps = {}): SettingsRuntime {
  return createSettingsRuntime({
    invoke: deps.invoke ?? (() => Promise.resolve(undefined)),
    bus: deps.bus,
    storage: deps.storage ?? memoryStorage(),
  });
}

/**
 * A store over a runtime nobody else holds — the direct replacement for the deleted
 * `makeSettingsStore(fakeStorage())`: same per-instance isolation, on the production backend.
 */
export function freshSettingsStore(bus?: SettingsBus, source?: string): SettingsStore {
  return freshSettingsRuntime().makeStore(bus, source);
}

/** A `wrapper` for Testing Library's `render`, so `rerender` keeps the same runtime. */
export function settingsWrapper(runtime: SettingsRuntime) {
  return function SettingsFixtureWrapper({ children }: { children: ReactNode }) {
    return <SettingsRuntimeProvider runtime={runtime}>{children}</SettingsRuntimeProvider>;
  };
}

export interface RenderWithSettingsOptions extends Omit<RenderOptions, "wrapper"> {
  /** The runtime the tree reads settings through; a fresh one when omitted. */
  runtime?: SettingsRuntime;
}

/**
 * `render` with a settings runtime above the tree. Since T3.5 `useSettingsRuntime()` THROWS
 * without a provider (there is no ambient fallback any more), so any component that reaches the
 * settings — App, TerminalView, SettingsApp, ConfigWarningsBadge — must be rendered through this.
 * The runtime comes back on the result so the test can seed or inspect it.
 */
export function renderWithSettings(
  ui: ReactElement,
  options: RenderWithSettingsOptions = {},
): RenderResult & { runtime: SettingsRuntime } {
  const { runtime = freshSettingsRuntime(), ...rest } = options;
  return { ...render(ui, { ...rest, wrapper: settingsWrapper(runtime) }), runtime };
}
