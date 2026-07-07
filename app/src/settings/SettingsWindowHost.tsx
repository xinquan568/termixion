// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the container the SETTINGS WINDOW boots into (replaces trmx-48's overlay SettingsHost).
// It wires SettingsApp to the real runtime edges: the shared settings registry broadcasting over
// the Tauri event bus, the update PROJECTION (useUpdateMirror — the main window is the authority)
// with a local useUpdate fallback for busless contexts (plain `pnpm dev`), the app version, and the
// link opener. It holds no logic of its own; like the other hosts it is exercised by the app while
// the tested pieces live behind the seams.
import { SettingsApp } from "./SettingsApp";
import { makeSettingsStore, openConfigFile } from "./settingsStore";
import { realEventBus } from "../ipc/eventBus";
import { autoCheckSourceFrom, useUpdate } from "../update/useUpdate";
import { useUpdateMirror } from "../update/useUpdateMirror";
import { realUpdateClient } from "../update/realUpdateClient";
import { realAppInfo } from "../update/appInfo";
import { realOpener } from "../update/opener";
import type { SettingsSection } from "../surface";

// Stable across renders (module scope): one store, tagged as this window on broadcasts.
const settingsStore = makeSettingsStore(undefined, realEventBus, "settings");

export interface SettingsWindowHostProps {
  initialSection: SettingsSection | null;
}

export function SettingsWindowHost({ initialSection }: SettingsWindowHostProps) {
  const mirror = useUpdateMirror({
    bus: realEventBus,
    settings: settingsStore,
    source: "settings",
  });
  // Busless fallback (no Tauri runtime): a local machine so the page still works in a browser.
  const local = useUpdate({ client: realUpdateClient, store: autoCheckSourceFrom(settingsStore) });
  const update = mirror.connected ? mirror.update : local;

  return (
    <SettingsApp
      initialSection={initialSection}
      update={update}
      appInfo={realAppInfo}
      opener={realOpener}
      settings={settingsStore}
      openConfigFile={openConfigFile}
      listen={realEventBus.listen}
    />
  );
}
