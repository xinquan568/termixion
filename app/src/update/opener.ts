// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: the external-link seam (Step-5 F3). The About page opens the Website / GitHub links through
// this interface; unit tests inject a fake to assert the URL, and the real `@tauri-apps/plugin-opener`
// edge (opens in the user's default browser) stays runtime-only.
// trmx-80 (review R3): the PATH half of the seam — openPath for filesystem paths (the "Open config
// file" row). openUrl and openPath are distinct plugin commands with distinct validation; a raw
// `/Users/…/termixion.toml` must never ride the URL opener.
import { openPath as pluginOpenPath, openUrl } from "@tauri-apps/plugin-opener";

/** Opens URLs and filesystem paths in their OS default handlers. */
export interface Opener {
  /** Opens a URL in the OS default browser. */
  openExternal(url: string): Promise<void>;
  /** Opens a filesystem PATH in its OS default application (a path is NOT a URL). */
  openPath(path: string): Promise<void>;
}

/** The real edge — delegates to the opener plugin. Runtime-only (not unit-tested). */
export const realOpener: Opener = {
  openExternal: (url) => openUrl(url),
  openPath: (path) => pluginOpenPath(path),
};

/** A recording fake for tests; `opened` collects URLs, `openedPaths` collects filesystem paths —
 * separate arrays so tests can assert a path never routes through the URL opener (and vice versa). */
export function makeFakeOpener(): Opener & { opened: string[]; openedPaths: string[] } {
  const opened: string[] = [];
  const openedPaths: string[] = [];
  return {
    opened,
    openedPaths,
    async openExternal(url) {
      opened.push(url);
    },
    async openPath(path) {
      openedPaths.push(path);
    },
  };
}
