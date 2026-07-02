// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// B-4: the React surface for a terminal. It owns a host <div>, mounts an xterm.js terminal into it
// on mount (via the injectable WebGL→DOM strategy), and disposes on unmount. B-5/C wire the live PTY
// across the Tauri channel into this terminal.
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  mountTerminal,
  type AddonLike,
  type FitLike,
  type MountDeps,
  type TerminalHandle,
  type TerminalLike,
} from "./mountTerminal";
import {
  attachScrollbar as realAttachScrollbar,
  type AttachScrollbarHandle,
  type ScrollbarTerminalLike,
} from "./scrollbar";
import {
  initialAppearanceFromWindow,
  iterm2Theme,
  iterm2TerminalOptions,
  prefersDarkToMode,
} from "./iterm2Theme";
import {
  applyCursorSettingsChange,
  cursorTerminalOptions,
  type CursorOptionsSink,
} from "./cursorSettings";
import { makeSettingsStore, SETTINGS_CHANGED_EVENT } from "../settings/settingsStore";
import { realEventBus } from "../ipc/eventBus";

// Is a WebGL2 context actually obtainable? Preflighting here means we throw *before* constructing
// `WebglAddon` on unsupported hardware — `WebglAddon.activate()` registers some renderer listeners
// before its own `getContext("webgl2")` would throw, so skipping it entirely keeps the fallback clean.
function supportsWebgl2(): boolean {
  try {
    return document.createElement("canvas").getContext("webgl2") != null;
  } catch {
    return false;
  }
}

// Adapter seam: bridge the real xterm classes to the strategy's small interfaces. The casts are
// localized here — the one place our pure logic meets the external library's wider types. Exported so the
// display chokepoint is unit-testable (realDeps.test.ts asserts the iTerm2 option set is what reaches
// `new Terminal`). trmx-44: the options come from iterm2TerminalOptions, and the initial palette is chosen
// from the system appearance (live light/dark switching is wired in TerminalView's effect below).
// trmx-51: the persisted cursor settings (default underline + blink on — superseding the iTerm2 cursor)
// overlay the profile at this same chokepoint.
export const realDeps: MountDeps = {
  createTerminal: () =>
    new Terminal({
      ...iterm2TerminalOptions(initialAppearanceFromWindow()),
      ...cursorTerminalOptions(makeSettingsStore()),
    }) as unknown as TerminalLike,
  createWebglAddon: () => {
    if (!supportsWebgl2()) {
      throw new Error("WebGL2 is not available; using the DOM renderer");
    }
    return new WebglAddon() as unknown as AddonLike;
  },
  createFitAddon: () => new FitAddon() as unknown as FitLike,
};

/**
 * Observe `target` for size changes and invoke `onResize`; returns a teardown. Defaults to a
 * `ResizeObserver` (fires once immediately, then on every layout change), but is injectable because
 * jsdom has no `ResizeObserver` — so the resize path is unit-testable without a real layout engine.
 */
export type ResizeObservation = (
  target: HTMLElement,
  onResize: () => void,
) => () => void;

const realObserveResize: ResizeObservation = (target, onResize) => {
  const observer = new ResizeObserver(() => onResize());
  observer.observe(target);
  return () => observer.disconnect();
};

/**
 * trmx-44: observe the system light/dark appearance and invoke `onChange(prefersDark)` on every switch;
 * returns a teardown. iTerm2's default profile is adaptive (separate light/dark colors that follow the OS),
 * so the live terminal must repaint when the appearance changes. Injectable for tests; the default uses
 * `prefers-color-scheme` and is a no-op where `matchMedia` is unavailable (jsdom / headless contexts).
 */
export type AppearanceObservation = (
  onChange: (prefersDark: boolean) => void,
) => () => void;

const realObserveAppearance: AppearanceObservation = (onChange) => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mql = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = (event: MediaQueryListEvent) => onChange(event.matches);
  mql.addEventListener("change", handler);
  return () => mql.removeEventListener("change", handler);
};

/**
 * Mount the Kitty-style scrollbar (trmx-41) — injectable so the React wiring stays unit-testable with a
 * fake (jsdom has no layout). Defaults to the real overlay.
 */
export type AttachScrollbar = (
  host: HTMLElement,
  terminal: ScrollbarTerminalLike,
  opts?: { document?: Document },
) => AttachScrollbarHandle;

/**
 * trmx-51: observe cross-window `settings:changed` broadcasts (the settings window editing cursor
 * style/blink, or a reset's default-value broadcast) and invoke `onChange(payload)`; returns a
 * teardown. Injectable for tests; the default listens over the Tauri event bus and is a no-op in a
 * plain browser/jsdom (no runtime — the listen rejects and is swallowed).
 */
export type SettingsObservation = (onChange: (payload: unknown) => void) => () => void;

const realObserveSettings: SettingsObservation = (onChange) => {
  let live = true;
  let unlisten: (() => void) | undefined;
  realEventBus
    .listen(SETTINGS_CHANGED_EVENT, onChange)
    .then((u) => {
      if (live) unlisten = u;
      else u();
    })
    .catch(() => {
      // No Tauri runtime — cursor settings still apply at the next launch via persisted state.
    });
  return () => {
    live = false;
    unlisten?.();
  };
};

export interface TerminalViewProps {
  /** Called once the terminal is mounted, so the parent can attach it to a PTY session (C-2). */
  onReady?: (handle: TerminalHandle) => void;
  /** Injection seam for tests; defaults to the real WebGL→DOM strategy. */
  mount?: typeof mountTerminal;
  /** Injection seam for tests; defaults to the real xterm-backed factories. */
  deps?: MountDeps;
  /** Injection seam for tests; defaults to a real `ResizeObserver` on the host element. */
  observeResize?: ResizeObservation;
  /** Injection seam for tests; defaults to the real Kitty-style scrollbar (trmx-41). */
  attachScrollbar?: AttachScrollbar;
  /** Injection seam for tests; defaults to a real `prefers-color-scheme` listener (trmx-44). */
  observeAppearance?: AppearanceObservation;
  /** Injection seam for tests; defaults to a real settings:changed listener (trmx-51). */
  observeSettings?: SettingsObservation;
}

export function TerminalView({
  onReady,
  mount = mountTerminal,
  deps = realDeps,
  observeResize = realObserveResize,
  attachScrollbar = realAttachScrollbar,
  observeAppearance = realObserveAppearance,
  observeSettings = realObserveSettings,
}: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handle = mount(host, deps);
    onReady?.(handle);
    // trmx-41: the Kitty-style scrollbar overlays the same host. The real xterm `Terminal` carries the
    // members `ScrollbarTerminalLike` needs; this is the localized adapter cast (cf. the `as unknown as
    // TerminalLike` casts in `realDeps`), the one place our narrow interface meets xterm's wider type.
    const scrollbar = attachScrollbar(
      host,
      handle.terminal as unknown as ScrollbarTerminalLike,
      { document: host.ownerDocument },
    );
    // Keep the grid filling the host as the window resizes (issue 2): every size change re-fits, which
    // makes xterm fire onResize → the PTY grid is resized to match (wired in useBackend). Recompute the
    // scrollbar AFTER the fit so it reads the freshly-resized rows/cols (trmx-41).
    const stopObserving = observeResize(host, () => {
      handle.fit();
      scrollbar.recompute();
    });
    // trmx-44: iTerm2's default theme is adaptive — repaint the live terminal when the system appearance
    // flips. Reassigning `terminal.options.theme` makes xterm repaint without a remount; we also keep the
    // host/body background (the inset + sub-cell remainder) in sync, then recompute the scrollbar (its
    // handle colour derives from the theme foreground).
    const stopObservingAppearance = observeAppearance((prefersDark) => {
      const theme = iterm2Theme(prefersDarkToMode(prefersDark));
      (handle.terminal as unknown as { options: { theme?: typeof theme } }).options.theme = theme;
      if (theme.background) {
        host.style.background = theme.background;
        const body = host.ownerDocument?.body;
        if (body) body.style.background = theme.background;
      }
      scrollbar.recompute();
    });
    // trmx-51: cursor style/blink edited in the settings window (or reverted by Reset) applies to
    // the live terminal by option assignment — same no-remount mechanism as the theme above.
    const stopObservingSettings = observeSettings((payload) => {
      applyCursorSettingsChange(handle.terminal as unknown as CursorOptionsSink, payload);
    });
    return () => {
      stopObserving();
      stopObservingAppearance();
      stopObservingSettings();
      scrollbar.dispose();
      handle.dispose();
    };
  }, [mount, deps, onReady, observeResize, attachScrollbar, observeAppearance, observeSettings]);

  return <div ref={hostRef} data-testid="terminal" className="terminal-host" />;
}
