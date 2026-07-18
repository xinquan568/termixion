// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-188: the app-drawn main-window title bar. tauri.conf.json pins the macOS Overlay style +
// hidden native title on the main window (the config, not apply_macos_titlebar — that builder
// path only serves windows created at runtime, and the main window is auto-built before `setup`),
// so the webview owns the strip under the floating traffic lights. LEFT: the active tab's derived
// title, CONSUMED from App (tabTitle.ts owns the ladder — this component never re-derives),
// truncating with an ellipsis. RIGHT: a priority slot (`rightSlot`) that always wins the width
// fight — empty here, the mount point for trmx-190's AI-session counters. The native setTitle
// path (windowTitle.ts) is untouched: Mission Control / ⌘-Tab read the real NSWindow title.
//
// Drag: Tauri's drag handler fires only on elements CARRYING data-tauri-drag-region (children do
// not inherit — the SettingsApp precedent), so the bar, the inset, and the title span each repeat
// the attribute; the slot must NOT carry it (it will hold interactive content).
//
// Fullscreen: macOS auto-hides the traffic lights in fullscreen, so the left inset collapses.
// Tauri v2 has no dedicated fullscreen event; the real observer re-queries isFullscreen() on
// every resize, and — like realSetWindowTitle — swallows every rejection so it is inert without
// a Tauri runtime (pnpm dev, jsdom, Playwright). Tests drive the seam directly.

import { useEffect, useState, type ReactNode } from "react";

export interface TitleBarProps {
  /** The ACTIVE tab's derived title (App's activeTab.title — manual pin > osc > process > fallback). */
  title: string;
  /** Priority right-slot content (trmx-190's counters); the slot element renders even when empty. */
  rightSlot?: ReactNode;
  /** Injection seam for tests; defaults to the resize-driven isFullscreen() observer below. */
  observeFullscreen?: (onChange: (fullscreen: boolean) => void) => () => void;
}

/**
 * Observe the window's fullscreen state: query once on subscribe, re-query on every window
 * resize (entering/leaving macOS fullscreen always resizes). Inert without a Tauri runtime.
 */
export function realObserveFullscreen(onChange: (fullscreen: boolean) => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  import("@tauri-apps/api/window")
    .then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      const query = () =>
        win
          .isFullscreen()
          .then((fullscreen) => {
            if (!disposed) onChange(fullscreen);
          })
          .catch(() => {
            // The query itself failed — keep the last known state.
          });
      await query();
      const stop = await win.onResized(() => void query());
      if (disposed) stop();
      else unlisten = stop;
    })
    .catch(() => {
      // No Tauri runtime — there are no traffic lights to clear; the inset just stays.
    });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

export function TitleBar({
  title,
  rightSlot = null,
  observeFullscreen = realObserveFullscreen,
}: TitleBarProps) {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => observeFullscreen(setFullscreen), [observeFullscreen]);

  return (
    <div
      className={`title-bar${fullscreen ? " title-bar--fullscreen" : ""}`}
      data-tauri-drag-region
    >
      <div className="title-bar__inset" data-tauri-drag-region />
      <span className="title-bar__title" data-tauri-drag-region>
        {title}
      </span>
      <div className="title-bar__slot">{rightSlot}</div>
    </div>
  );
}
