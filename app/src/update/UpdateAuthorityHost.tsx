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
import { makeSettingsStore } from "../settings/settingsStore";
import { realEventBus } from "../ipc/eventBus";

// Stable across renders (module scope): one store, tagged as the main window on broadcasts.
const settingsStore = makeSettingsStore(undefined, realEventBus, "main");

export function UpdateAuthorityHost() {
  useUpdateAuthority({
    client: realUpdateClient,
    settings: settingsStore,
    bus: realEventBus,
    source: "main",
  });
  return null;
}
