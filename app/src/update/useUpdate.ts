// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: the React hook binding the pure state machine (updateState) to an injected UpdateClient +
// auto-check source. All Tauri contact is inside `client`, so the hook is unit-tested with a fake client
// and a fake store (R8). trmx-51: scheduling moved out — useUpdate never checks on its own; the MAIN
// window's useUpdateAuthority owns startup/scheduled checks (shouldAutoCheck) and wraps this hook.
import { useCallback, useReducer, useRef } from "react";
import type { PendingUpdate, UpdateClient } from "./updateClient";
import type { SettingsStore } from "../settings/settingsStore";
import { initialUpdateState, updateReducer, type UpdateState } from "./updateState";

/** Where the persisted auto-check flag lives (the trmx-48 store shape, now registry-backed). */
export interface AutoCheckSource {
  load(): boolean;
  save(enabled: boolean): void;
}

/** Adapt the trmx-51 settings registry to the auto-check slice this hook needs. */
export function autoCheckSourceFrom(settings: SettingsStore): AutoCheckSource {
  return {
    load: () => settings.get("update.autoCheck"),
    save: (enabled) => settings.set("update.autoCheck", enabled),
  };
}

export interface UseUpdateDeps {
  client: UpdateClient;
  store: AutoCheckSource;
}

export interface UseUpdate {
  state: UpdateState;
  /** Check the endpoint now. */
  checkNow(): Promise<void>;
  /** Download + install the pending update, streaming progress. */
  download(): Promise<void>;
  /** Relaunch to apply a staged update. */
  restart(): Promise<void>;
  /** Skip the currently-offered version (hides the card until a newer one appears). */
  skip(): void;
  /** Toggle automatic checking (persisted). */
  setAutoCheck(enabled: boolean): void;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function useUpdate({ client, store }: UseUpdateDeps): UseUpdate {
  const [state, dispatch] = useReducer(updateReducer, undefined, () =>
    initialUpdateState(store.load()),
  );
  // The pending update handle from the last successful check — needed to drive download().
  const pendingRef = useRef<PendingUpdate | null>(null);

  const checkNow = useCallback(async () => {
    dispatch({ type: "checkStarted" });
    try {
      const { update } = await client.check();
      pendingRef.current = update;
      if (update) dispatch({ type: "foundAvailable", info: update.info });
      else dispatch({ type: "foundUpToDate" });
    } catch (e) {
      dispatch({ type: "failed", error: errorMessage(e) });
    }
  }, [client]);

  const download = useCallback(async () => {
    const pending = pendingRef.current;
    if (!pending) return;
    dispatch({ type: "downloadStarted" });
    try {
      await pending.downloadAndInstall((progress) => dispatch({ type: "downloadProgress", progress }));
      dispatch({ type: "downloadReady" });
    } catch (e) {
      dispatch({ type: "failed", error: errorMessage(e) });
    }
  }, []);

  const restart = useCallback(async () => {
    try {
      await client.relaunch();
    } catch (e) {
      dispatch({ type: "failed", error: errorMessage(e) });
    }
  }, [client]);

  const skip = useCallback(() => {
    const version = pendingRef.current?.info.version;
    if (version) dispatch({ type: "skip", version });
  }, []);

  const setAutoCheck = useCallback(
    (enabled: boolean) => {
      store.save(enabled);
      dispatch({ type: "setAutoCheck", enabled });
    },
    [store],
  );

  return { state, checkNow, download, restart, skip, setAutoCheck };
}
