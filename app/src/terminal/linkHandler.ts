// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-64: the OSC 8 hyperlink activation policy. xterm.js renders OSC 8 links but delegates
// opening to `options.linkHandler`; ours opens only on ⌘-click (the terminal convention — a plain
// click must never open) and only for URLs that parse with an http(s) protocol, so javascript:,
// file:, data: and custom schemes stay inert (we never opt into allowNonHttpProtocols). The sink is
// injected: policy is unit-tested with a spy, and `realOpenUrl` is the thin runtime edge over the
// Tauri opener plugin, guarded like `ipc/eventBus.ts` so a plain browser (`pnpm dev`) stays quiet.
import type { ILinkHandler } from "@xterm/xterm";
import { openUrl } from "@tauri-apps/plugin-opener";

/** True when the text parses as a URL whose protocol is exactly http: or https:. */
function isHttpUrl(text: string): boolean {
  try {
    const { protocol } = new URL(text);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Build the xterm `linkHandler`: open the link's exact text via `open` on ⌘-click when it is an
 * http(s) URL; every other combination (plain click, other schemes, junk text) is a silent no-op.
 */
export function makeLinkHandler(open: (url: string) => void): ILinkHandler {
  return {
    activate(event, text) {
      if (event.metaKey && isHttpUrl(text)) open(text);
    },
  };
}

/** The production sink: hand the URL to the OS default browser via the Tauri opener plugin. */
export function realOpenUrl(url: string): void {
  void openUrl(url).catch(() => {
    // No runtime (plain browser / jsdom) — opening is best-effort by design.
  });
}
