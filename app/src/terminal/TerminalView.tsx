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
import { initialAppearanceFromWindow, iterm2TerminalOptions } from "./iterm2Theme";
import { emulationTerminalOptions } from "./emulationOptions";
import { makeLinkHandler, realOpenUrl } from "./linkHandler";
import {
  attachWindowTitle,
  realSetWindowTitle,
  type TitleTerminalLike,
} from "./windowTitle";
import { attachOsc52, realWriteClipboard, type Osc52TerminalLike } from "./osc52";
import { attachOsc7, type Osc7TerminalLike } from "./osc7";
import {
  applyCursorSettingsChange,
  cursorTerminalOptions,
  type CursorOptionsSink,
} from "./cursorSettings";
import {
  applyThemeSettingsChange,
  themeTerminalOptions,
  type ThemeOptionsSink,
} from "./themeSettings";
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
// display chokepoint is unit-testable (realDeps.test.ts asserts the full option set is what reaches
// `new Terminal`). trmx-44/46: the non-color profile facts (font, spacing, anti-aliasing) come from
// iterm2TerminalOptions. trmx-53: the COLORS come from the theme catalog — the persisted
// appearance.theme (first-run-derived from the OS: dark → Night, light → White) overrides the iTerm2
// palette at this chokepoint; live theme switching arrives over settings:changed in the effect below.
// trmx-51: the persisted cursor settings (default underline + no blink since trmx-55) overlay last.
export const realDeps: MountDeps = {
  createTerminal: () => {
    const settings = makeSettingsStore();
    return new Terminal({
      ...iterm2TerminalOptions(initialAppearanceFromWindow()),
      ...themeTerminalOptions(settings),
      ...cursorTerminalOptions(settings),
      // trmx-64: the emulation-semantics slice (convertEol:false — VT-correct LF handling) spreads
      // LAST so it always wins; the conformance harness builds from this same exported slice.
      ...emulationTerminalOptions(),
      // trmx-64: OSC 8 hyperlinks activate on ⌘-click only, http/https only, via the opener plugin.
      linkHandler: makeLinkHandler(realOpenUrl),
    }) as unknown as TerminalLike;
  },
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
 * Mount the Kitty-style scrollbar (trmx-41) — injectable so the React wiring stays unit-testable with a
 * fake (jsdom has no layout). Defaults to the real overlay.
 */
export type AttachScrollbar = (
  host: HTMLElement,
  terminal: ScrollbarTerminalLike,
  opts?: { document?: Document },
) => AttachScrollbarHandle;

/**
 * trmx-64: attach the OSC integrations (0/2 window title, 52 write-only clipboard, 7 cwd retention)
 * to a mounted terminal; returns one combined teardown. Injectable so the React wiring stays
 * unit-testable with fakes (the default casts to the modules' narrow slices — the same localized
 * adapter-cast pattern as the scrollbar below). Sinks are injectable for the same reason; the
 * defaults are the real Tauri/webview edges (inert without a runtime).
 */
export type AttachOscIntegrations = (terminal: TerminalLike) => () => void;

export function realAttachOscIntegrations(
  terminal: TerminalLike,
  sinks: {
    setTitle: (title: string) => void;
    writeClipboard: (text: string) => void;
  } = { setTitle: realSetWindowTitle, writeClipboard: realWriteClipboard },
): () => void {
  const detachTitle = attachWindowTitle(
    terminal as unknown as TitleTerminalLike,
    sinks.setTitle,
  );
  const detach52 = attachOsc52(
    terminal as unknown as Osc52TerminalLike,
    sinks.writeClipboard,
  );
  const detach7 = attachOsc7(terminal as unknown as Osc7TerminalLike);
  return () => {
    detachTitle();
    detach52();
    detach7();
  };
}

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
  /** Injection seam for tests; defaults to a real settings:changed listener (trmx-51). */
  observeSettings?: SettingsObservation;
  /** Injection seam for tests; defaults to the real OSC title/52/7 wiring (trmx-64). */
  attachOscIntegrations?: AttachOscIntegrations;
}

export function TerminalView({
  onReady,
  mount = mountTerminal,
  deps = realDeps,
  observeResize = realObserveResize,
  attachScrollbar = realAttachScrollbar,
  observeSettings = realObserveSettings,
  attachOscIntegrations = realAttachOscIntegrations,
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
    // trmx-64: OSC integrations (0/2 title → window title, 52 → write-only clipboard, 7 → cwd).
    const detachOsc = attachOscIntegrations(handle.terminal);
    // Keep the grid filling the host as the window resizes (issue 2): every size change re-fits, which
    // makes xterm fire onResize → the PTY grid is resized to match (wired in useBackend). Recompute the
    // scrollbar AFTER the fit so it reads the freshly-resized rows/cols (trmx-41).
    const stopObserving = observeResize(host, () => {
      handle.fit();
      scrollbar.recompute();
    });
    // trmx-51/53: settings edited in the settings window (or reverted by Reset) apply to the live
    // terminal by option assignment — no remount. Cursor style/blink reassign their options;
    // a theme change (trmx-53, superseding trmx-44's live OS-following) reassigns options.theme
    // wholesale, then syncs the host/body background (the inset + sub-cell remainder) and
    // recomputes the scrollbar (its colors derive from the theme's scrollbarSlider* tokens).
    const stopObservingSettings = observeSettings((payload) => {
      applyCursorSettingsChange(handle.terminal as unknown as CursorOptionsSink, payload);
      const appliedTheme = applyThemeSettingsChange(
        handle.terminal as unknown as ThemeOptionsSink,
        payload,
      );
      if (appliedTheme) {
        const theme = (handle.terminal as unknown as ThemeOptionsSink).options.theme;
        if (theme?.background) {
          host.style.background = theme.background;
          const body = host.ownerDocument?.body;
          if (body) body.style.background = theme.background;
        }
        scrollbar.recompute();
      }
    });
    return () => {
      stopObserving();
      stopObservingSettings();
      detachOsc();
      scrollbar.dispose();
      handle.dispose();
    };
  }, [mount, deps, onReady, observeResize, attachScrollbar, observeSettings, attachOscIntegrations]);

  return <div ref={hostRef} data-testid="terminal" className="terminal-host" />;
}
