// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: the container that wires the Settings overlay to the real runtime edges — the native-menu
// event, the Tauri updater/process client, app version, and the link opener. It holds no logic of its
// own (that lives in the tested SettingsView / useUpdate / useSettingsMenu); like `useBackend`'s real
// path it is exercised by the app, and App.test stubs it out.
import { listen } from "@tauri-apps/api/event";
import { SettingsView } from "./SettingsView";
import { useSettingsMenu, type ListenFn } from "./useSettingsMenu";
import { useUpdate } from "../update/useUpdate";
import { realUpdateClient } from "../update/realUpdateClient";
import { makeAutoCheckStore } from "../update/autoCheckStore";
import { realAppInfo } from "../update/appInfo";
import { realOpener } from "../update/opener";

// Stable across renders (module scope): one store, one adapter from Tauri's listen to our seam.
const autoCheckStore = makeAutoCheckStore();
const realListen: ListenFn = (event, handler) => listen(event, () => handler());

export function SettingsHost() {
  const menu = useSettingsMenu(realListen);
  const update = useUpdate({ client: realUpdateClient, store: autoCheckStore });
  return (
    <SettingsView
      open={menu.open}
      onClose={menu.close}
      update={update}
      appInfo={realAppInfo}
      opener={realOpener}
    />
  );
}
