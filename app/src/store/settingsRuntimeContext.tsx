// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-253 (T3.3) — how the ONE runtime main.tsx creates reaches the React tree.
//
// THE PROBLEM. Before this change `UpdateAuthorityHost` and `SettingsWindowHost` each built their
// settings store at MODULE-EVALUATION time (`const settingsStore = makeSettingsStore(...)` beside
// the import list). A store built while the module is being imported can only close over state
// that already exists, which is precisely why the ten pieces had to be module-global in the first
// place: a boot-local runtime does not exist yet when those lines run. Removing the globals
// without removing those two lines is impossible — whatever they closed over would have to stay.
//
// THE FIX. Both hosts build their store per MOUNT instead, from a runtime handed down the tree.
// A React context is the mechanism because `UpdateAuthorityHost` is rendered deep inside AppView,
// six components below `main.tsx`; prop-drilling a settings runtime through App and AppView would
// put a settings dependency into every layer between them, which is exactly the coupling the
// context avoids. `SettingsWindowHost` could take a prop — it is main.tsx's direct child — but
// both surfaces reading the same seam is worth more than saving one context on one branch.
//
// NO FALLBACK (T3.5). During the migration these hooks resolved to an ambient runtime when no
// provider was above them. That fallback is gone with the ambient module, and its absence is the
// point: a lazily created replacement would be a SECOND runtime that nothing ever hydrated, so the
// main window would read registry defaults instead of the user's config file — with no error, no
// warning, and a UI that looks like a first run. Throwing turns that into a mount-time failure
// naming the missing provider. main.tsx puts exactly one above both surfaces; tests use the
// `renderWithSettings` / `settingsWrapper` fixture in src/test/settingsRuntime.tsx.
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { SettingsBus, SettingsRuntime, SettingsStore } from "./settingsStore";

const SettingsRuntimeContext = createContext<SettingsRuntime | null>(null);

export interface SettingsRuntimeProviderProps {
  runtime: SettingsRuntime;
  children: ReactNode;
}

/** Provide the boot runtime to a subtree. main.tsx wraps BOTH surfaces in exactly one of these. */
export function SettingsRuntimeProvider({ runtime, children }: SettingsRuntimeProviderProps) {
  return (
    <SettingsRuntimeContext.Provider value={runtime}>{children}</SettingsRuntimeContext.Provider>
  );
}

/** The runtime for this subtree. THROWS with no provider above it — see the header. */
export function useSettingsRuntime(): SettingsRuntime {
  const runtime = useContext(SettingsRuntimeContext);
  if (!runtime) {
    throw new Error(
      "useSettingsRuntime: no <SettingsRuntimeProvider> above this component. " +
        "Production provides one in main.tsx; tests use renderWithSettings/settingsWrapper " +
        "from src/test/settingsRuntime.",
    );
  }
  return runtime;
}

/**
 * A settings store over this subtree's runtime, stable for as long as the runtime is. `bus` and
 * `source` must be stable references (a module-level bus and a literal, as both hosts pass).
 */
export function useSettingsStore(bus?: SettingsBus, source?: string): SettingsStore {
  const runtime = useSettingsRuntime();
  return useMemo(() => runtime.makeStore(bus, source), [runtime, bus, source]);
}
