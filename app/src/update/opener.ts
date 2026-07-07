// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: the external-link seam (Step-5 F3). The About page opens the Website / GitHub links through
// this interface; unit tests inject a fake to assert the URL, and the real `@tauri-apps/plugin-opener`
// edge (opens in the user's default browser) stays runtime-only.
// trmx-148 (supersedes the trmx-80 review-R3 openPath half): the "Open config file" row now opens
// BACKEND-side via the `config_open_file` command (the webview plugin command was capability-denied
// in the packaged app), so the seam is URL-only again — the "a path never rides the URL opener"
// invariant is preserved by construction.
import { openUrl } from "@tauri-apps/plugin-opener";

/** Opens URLs in their OS default handlers. */
export interface Opener {
  /** Opens a URL in the OS default browser. */
  openExternal(url: string): Promise<void>;
}

/** The real edge — delegates to the opener plugin. Runtime-only (not unit-tested). */
export const realOpener: Opener = {
  openExternal: (url) => openUrl(url),
};

/** A recording fake for tests; `opened` collects the URLs handed to the seam. */
export function makeFakeOpener(): Opener & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    async openExternal(url) {
      opened.push(url);
    },
  };
}
