// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the MAIN window's headless update host. Mounting it makes the main window the update
// AUTHORITY: it runs the startup/scheduled check (per the persisted Automatic-updates +
// Check-frequency settings), auto-downloads when that preference is on, and serves the settings
// window over the event bus (state snapshots + command execution). Renders nothing — the UI lives
// in the settings window. Runtime wiring only; the behavior is tested in useUpdateAuthority.
import { useUpdateAuthority } from "./useUpdateAuthority";
import { realUpdateClient } from "./realUpdateClient";
import { useSettingsStore } from "../store/settingsRuntimeContext";
import { realEventBus } from "../ipc/eventBus";

export function UpdateAuthorityHost() {
  // trmx-253 (T3.3): built per MOUNT from the runtime main.tsx provides, not at module
  // evaluation. Stable across renders all the same — `realEventBus` and the source literal
  // are constants, so useSettingsStore memoizes on the runtime identity alone.
  const settingsStore = useSettingsStore(realEventBus, "main");
  useUpdateAuthority({
    client: realUpdateClient,
    settings: settingsStore,
    bus: realEventBus,
    source: "main",
  });
  return null;
}
