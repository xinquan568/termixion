// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: the external-link seam (Step-5 F3). The About page opens the Website / GitHub links through
// this interface; unit tests inject a fake to assert the URL, and the real `@tauri-apps/plugin-opener`
// edge (opens in the user's default browser) stays runtime-only.
import { openUrl } from "@tauri-apps/plugin-opener";

/** Opens a URL in the OS default handler. */
export interface Opener {
  openExternal(url: string): Promise<void>;
}

/** The real edge — delegates to the opener plugin. Runtime-only (not unit-tested). */
export const realOpener: Opener = {
  openExternal: (url) => openUrl(url),
};

/** A recording fake for tests; `opened` collects every URL passed. */
export function makeFakeOpener(): Opener & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    async openExternal(url) {
      opened.push(url);
    },
  };
}
