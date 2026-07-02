// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: the React hook binding the pure state machine (updateState) to an injected UpdateClient +
// AutoCheckStore. All Tauri contact is inside `client`, so the hook is unit-tested with a fake client and
// a fake store (R8). The About page consumes what this returns.
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { PendingUpdate, UpdateClient } from "./updateClient";
import type { AutoCheckStore } from "./autoCheckStore";
import { initialUpdateState, updateReducer, type UpdateState } from "./updateState";

export interface UseUpdateDeps {
  client: UpdateClient;
  store: AutoCheckStore;
  /** When true, run a check once on mount if auto-check is enabled (default true). */
  autoCheckOnMount?: boolean;
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

export function useUpdate({ client, store, autoCheckOnMount = true }: UseUpdateDeps): UseUpdate {
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

  // Optional check-on-mount, guarded so it fires at most once.
  const didAutoCheck = useRef(false);
  useEffect(() => {
    if (!autoCheckOnMount || didAutoCheck.current) return;
    didAutoCheck.current = true;
    if (store.load()) void checkNow();
  }, [autoCheckOnMount, store, checkNow]);

  return { state, checkNow, download, restart, skip, setAutoCheck };
}
