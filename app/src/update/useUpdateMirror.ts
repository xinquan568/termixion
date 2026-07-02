// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the settings window's update PROJECTION. It holds no PendingUpdate and never talks to
// the updater plugin: it converges on the authority's `update:state` snapshots (requesting one on
// mount, so a window opened mid-download shows the truth) and forwards every manual action as an
// `update:command`. When the bus has no runtime (plain browser/jsdom), `connected` stays false and
// the host falls back to a local useUpdate instance.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SettingsStore } from "../settings/settingsStore";
import type { EventBus } from "../ipc/eventBus";
import type { UseUpdate } from "./useUpdate";
import { initialUpdateState, type UpdateState } from "./updateState";
import {
  UPDATE_COMMAND_EVENT,
  UPDATE_REQUEST_STATE_EVENT,
  UPDATE_STATE_EVENT,
  isUpdateStateBroadcast,
  type UpdateCommand,
} from "./updateEvents";

export interface UseUpdateMirrorDeps {
  bus: EventBus;
  settings: SettingsStore;
  /** This window's tag on commands (and echo guard on snapshots). */
  source?: string;
}

export interface UpdateMirror {
  update: UseUpdate;
  /** True once the bus subscription is live (a Tauri runtime exists). */
  connected: boolean;
}

export function useUpdateMirror({
  bus,
  settings,
  source = "settings",
}: UseUpdateMirrorDeps): UpdateMirror {
  const [state, setState] = useState<UpdateState>(() =>
    initialUpdateState(settings.get("update.autoCheck")),
  );
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let live = true;
    const unsubs: Array<() => void> = [];
    bus
      .listen(UPDATE_STATE_EVENT, (payload) => {
        if (isUpdateStateBroadcast(payload) && payload.source !== source) {
          setState(payload.state);
        }
      })
      .then((unlisten) => {
        if (!live) {
          unlisten();
          return;
        }
        unsubs.push(unlisten);
        setConnected(true);
        // Late-subscriber convergence: ask the authority for the current state.
        void bus.emit(UPDATE_REQUEST_STATE_EVENT, { source });
      })
      .catch(() => {
        if (live) setConnected(false);
      });
    return () => {
      live = false;
      unsubs.forEach((u) => u());
    };
  }, [bus, source]);

  const send = useCallback(
    (cmd: UpdateCommand) => {
      void bus.emit(UPDATE_COMMAND_EVENT, { cmd, source });
    },
    [bus, source],
  );

  const update: UseUpdate = useMemo(
    () => ({
      state,
      checkNow: async () => send({ type: "checkNow" }),
      download: async () => send({ type: "download" }),
      restart: async () => send({ type: "restart" }),
      skip: () => send({ type: "skip" }),
      setAutoCheck: (enabled) => {
        // Optimistic local echo so the toggle answers immediately; the authority persists and
        // broadcasts the authoritative state right after.
        setState((s) => ({ ...s, autoCheckEnabled: enabled }));
        send({ type: "setAutoCheck", enabled });
      },
    }),
    [state, send],
  );

  return { update, connected };
}
