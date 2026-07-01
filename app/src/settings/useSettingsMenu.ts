// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: bridges the native menu to the Settings overlay. The Tauri shell emits `open-settings` when
// either "About Termixion" or "Settings…" is chosen (both open the same page); this hook subscribes and
// flips the overlay open. `listen` is injected so the subscription is unit-testable without Tauri.
import { useEffect, useState } from "react";

/** The event this hook subscribes to (emitted by the Rust menu handler). */
export const OPEN_SETTINGS_EVENT = "open-settings";

/** The `listen` shape we depend on (a subset of `@tauri-apps/api/event`'s). */
export type ListenFn = (event: string, handler: () => void) => Promise<() => void>;

export interface SettingsMenu {
  open: boolean;
  openSettings: () => void;
  close: () => void;
}

export function useSettingsMenu(listen: ListenFn): SettingsMenu {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    listen(OPEN_SETTINGS_EVENT, () => setOpen(true))
      .then((fn) => {
        if (active) unlisten = fn;
        else fn(); // unmounted before the subscription resolved — drop it immediately
      })
      .catch(() => {
        // No Tauri runtime (e.g. `pnpm dev` in a plain browser) — the menu just won't fire.
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [listen]);

  return { open, openSettings: () => setOpen(true), close: () => setOpen(false) };
}
