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
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import {
  mountTerminal,
  type AddonLike,
  type FitLike,
  type SearchAddonLike,
  type MountDeps,
  type TerminalHandle,
  type TerminalLike,
} from "./mountTerminal";
import {
  attachScrollbar as realAttachScrollbar,
  type AttachScrollbarHandle,
  type ScrollbarTerminalLike,
} from "./scrollbar";
import { makeResizeCoalescer, type FrameSchedule } from "./resizeCoalescer";
import { initialAppearanceFromWindow, iterm2TerminalOptions } from "./iterm2Theme";
import { emulationTerminalOptions } from "./emulationOptions";
import {
  applyScrollbackSettingsChange,
  scrollbackTerminalOptions,
  type ScrollbackOptionsSink,
} from "./scrollbackSettings";
import {
  applyFontSettingsChange,
  fontTerminalOptions,
  type FontOptionsSink,
} from "./fontSettings";
import {
  attachClipboardGuards,
  clipboardTerminalOptions,
  type CopyTerminalLike,
  type PasteTerminalLike,
} from "./clipboard";
import { attachCopyOnSelect, type SelectionTerminalLike } from "./copyOnSelect";
import { activateUnicodeGraphemes } from "./unicodeGraphemes";
import { copyOnSelectEnabled, copyOnSelectSettingChange } from "./copyOnSelectSettings";
import { makeLinkHandler, realOpenUrl } from "./linkHandler";
import {
  attachWindowTitle,
  realSetWindowTitle,
  type TitleTerminalLike,
} from "./windowTitle";
import { attachOsc52, realWriteClipboard, type Osc52TerminalLike } from "./osc52";
import { attachOsc7, defaultCwdStore, type CwdStore, type Osc7TerminalLike } from "./osc7";
import { attachOsc1337, type Osc1337TerminalLike } from "./osc1337";
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
// trmx-80 (FR-13): the settings store reads the file-backed SHARED SNAPSHOT (hydrated in boot());
// the persisted FONT (family/size) and SCROLLBACK capacity are settings-fed here — the font slice
// spreads AFTER iterm2TerminalOptions so a persisted font overrides the profile constants.
export const realDeps: MountDeps = {
  createTerminal: () => {
    const settings = makeSettingsStore();
    const terminal = new Terminal({
      ...iterm2TerminalOptions(initialAppearanceFromWindow()),
      ...themeTerminalOptions(settings),
      ...fontTerminalOptions(settings),
      ...cursorTerminalOptions(settings),
      // trmx-65: scrollback capacity + smooth discrete scrolling (a user setting since trmx-80).
      ...scrollbackTerminalOptions(settings),
      // trmx-66: Option-drag selection while an app owns the mouse (iTerm2 convention).
      ...clipboardTerminalOptions(),
      // trmx-64: the emulation-semantics slice (convertEol:false — VT-correct LF handling) spreads
      // LAST so it always wins; the conformance harness builds from this same exported slice.
      ...emulationTerminalOptions(),
      // trmx-64: OSC 8 hyperlinks activate on ⌘-click only, http/https only, via the opener plugin.
      linkHandler: makeLinkHandler(realOpenUrl),
    });
    // trmx-97 (FR-1.4): grapheme-cluster Unicode (correct CJK/emoji/combining widths) — the conformance
    // driver activates the SAME helper, so the harness pins this exact emulator (the trmx-64 invariant).
    activateUnicodeGraphemes(terminal);
    return terminal as unknown as TerminalLike;
  },
  createWebglAddon: () => {
    if (!supportsWebgl2()) {
      throw new Error("WebGL2 is not available; using the DOM renderer");
    }
    return new WebglAddon() as unknown as AddonLike;
  },
  createFitAddon: () => new FitAddon() as unknown as FitLike,
  // trmx-98: the per-pane search addon (find bar). Renderer-agnostic; loaded unconditionally.
  createSearchAddon: () => new SearchAddon() as unknown as SearchAddonLike,
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
 * defaults are the real Tauri/webview edges (inert without a runtime). trmx-74: the OSC 7 cwd
 * lands in `cwdStore` — App injects one PER TAB so each tab retains its own shell cwd
 * (new-tab-inherits-cwd); when omitted it stays the module-default store, so every pre-tab
 * consumer and test is unaffected. trmx-75: `onTitle` redirects the OSC 0/2 TITLE sink — App
 * injects a per-tab callback so a program's title retitles its TAB (the reducer's `osc` source),
 * not the native window; when omitted the sink stays `realSetWindowTitle` (standalone compat).
 * trmx-90: `onBadge` redirects the OSC 1337 SetBadgeFormat sink — App injects a per-PANE callback so
 * a `printf` badges its own pane (the reducer's `badge` slot); when omitted the badge is a no-op (a
 * badge has no standalone destination, unlike a title/clipboard).
 */
export type AttachOscIntegrations = (
  terminal: TerminalLike,
  cwdStore?: CwdStore,
  onTitle?: (title: string) => void,
  onBadge?: (badge: string | null) => void,
) => () => void;

export function realAttachOscIntegrations(
  terminal: TerminalLike,
  sinks: {
    setTitle: (title: string) => void;
    writeClipboard: (text: string) => void;
    // trmx-90: the per-pane badge sink. Optional (defaulted to a no-op below): unlike title/clipboard
    // a badge has no standalone edge, so a caller with no pane layer simply drops SetBadgeFormat.
    setBadge?: (badge: string | null) => void;
  } = { setTitle: realSetWindowTitle, writeClipboard: realWriteClipboard },
  cwdStore: CwdStore = defaultCwdStore,
): () => void {
  const detachTitle = attachWindowTitle(
    terminal as unknown as TitleTerminalLike,
    sinks.setTitle,
  );
  const detach52 = attachOsc52(
    terminal as unknown as Osc52TerminalLike,
    sinks.writeClipboard,
  );
  const detach7 = attachOsc7(terminal as unknown as Osc7TerminalLike, cwdStore);
  // trmx-90: OSC 1337 SetBadgeFormat → the per-pane badge sink (localized adapter cast, like the
  // three above). No sink injected → a no-op consumer, so an unhandled 1337 still dies in osc1337.ts.
  const detach1337 = attachOsc1337(
    terminal as unknown as Osc1337TerminalLike,
    sinks.setBadge ?? (() => {}),
  );
  return () => {
    detachTitle();
    detach52();
    detach7();
    detach1337();
  };
}

// The default seam value: the real integrations over the real sinks, with the caller's per-tab
// store (or the module default) threaded through. A module-level const — an inline arrow would
// change identity every render and remount the terminal via the effect deps (trmx-74). trmx-75:
// a caller-provided title sink REPLACES realSetWindowTitle (the tab layer owns the window title
// now — only the active tab's effective title may reach it, from App's window-title effect).
const defaultAttachOscIntegrations: AttachOscIntegrations = (terminal, cwdStore, onTitle, onBadge) =>
  realAttachOscIntegrations(
    terminal,
    // No tab/pane layer at all → the full default sinks (window title, real clipboard, no-op badge).
    // Otherwise build the sinks: onTitle REPLACES the window title (else stays realSetWindowTitle),
    // onBadge feeds the pane's badge slot (trmx-90; absent → osc1337 no-op).
    onTitle === undefined && onBadge === undefined
      ? undefined
      : {
          setTitle: onTitle ?? realSetWindowTitle,
          writeClipboard: realWriteClipboard,
          setBadge: onBadge,
        },
    cwdStore,
  );

/**
 * trmx-66: bind the owned ⌘C/⌘V clipboard guards (capture-phase copy/paste on the host — see
 * clipboard.ts for why ownership + stopPropagation are load-bearing). Injectable for tests; the
 * default binds the real handlers over the localized adapter cast.
 */
export type AttachClipboard = (
  host: HTMLElement,
  terminal: TerminalLike,
) => () => void;

export const realAttachClipboard: AttachClipboard = (host, terminal) =>
  attachClipboardGuards(
    host,
    terminal as unknown as CopyTerminalLike & PasteTerminalLike,
  );

/**
 * trmx-95 (FR-8): bind auto-copy-on-select for a pane — a mouse selection lands on the clipboard on
 * pointerup (iTerm2-style), through the SAME `realWriteClipboard` sink OSC 52 uses (byte-identical to
 * ⌘C). Injectable for tests; only attached while `terminal.copyOnSelect` is on (gated in the effect).
 */
export type AttachCopyOnSelect = (host: HTMLElement, terminal: TerminalLike) => () => void;

export const realAttachCopyOnSelect: AttachCopyOnSelect = (host, terminal) =>
  attachCopyOnSelect(host, terminal as unknown as SelectionTerminalLike, realWriteClipboard);

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
  /**
   * Where this terminal's OSC 7 cwd reports land (trmx-74): App injects one store PER TAB so a
   * new tab can inherit the ACTIVE tab's cwd. Defaults to the osc7 module store (pre-tab
   * behavior).
   */
  cwdStore?: CwdStore;
  /**
   * Where this terminal's OSC 0/2 titles land (trmx-75): App injects a per-tab callback (cached
   * — an unstable identity would remount the terminal via the effect deps) that routes the title
   * into the tab reducer's `osc` source. When omitted the title keeps retitling the native
   * window directly (`realSetWindowTitle` — standalone/pre-tab behavior).
   */
  onOscTitle?: (title: string) => void;
  /**
   * Where this terminal's OSC 1337 SetBadgeFormat lands (trmx-90): App injects a per-PANE callback
   * (cached — an unstable identity would remount the terminal via the effect deps, exactly like
   * onOscTitle) that routes the badge into THIS pane's reducer `badge` slot. When omitted the badge
   * has no destination (a no-op — a badge is meaningless without the pane layer).
   */
  onBadge?: (badge: string | null) => void;
  /** Injection seam for tests; defaults to the real ⌘C/⌘V clipboard guards (trmx-66). */
  attachClipboard?: AttachClipboard;
  /** Injection seam for tests; defaults to the real auto-copy-on-select wiring (trmx-95). */
  attachCopyOnSelect?: AttachCopyOnSelect;
  /**
   * Injection seam for tests; the frame source for resize coalescing (trmx-67). Defaults to
   * requestAnimationFrame — tests inject an immediate or manually-fired schedule so the
   * coalesced fit runs deterministically instead of on a real animation frame.
   */
  resizeSchedule?: FrameSchedule;
}

export function TerminalView({
  onReady,
  mount = mountTerminal,
  deps = realDeps,
  observeResize = realObserveResize,
  attachScrollbar = realAttachScrollbar,
  observeSettings = realObserveSettings,
  attachOscIntegrations = defaultAttachOscIntegrations,
  attachClipboard = realAttachClipboard,
  attachCopyOnSelect = realAttachCopyOnSelect,
  cwdStore,
  onOscTitle,
  onBadge,
  resizeSchedule,
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
    // trmx-64: OSC integrations (0/2 title → window title, 52 → write-only clipboard, 7 → cwd —
    // into this tab's injected store when the tab layer provides one, trmx-74). trmx-75: when the
    // tab layer provides onOscTitle, OSC titles go THERE (the tab's `osc` source) instead of the
    // native window. trmx-90: onBadge routes OSC 1337 SetBadgeFormat into THIS pane's badge slot.
    const detachOsc = attachOscIntegrations(handle.terminal, cwdStore, onOscTitle, onBadge);
    // trmx-66: owned ⌘C/⌘V — capture-phase guards on the host (sanitized paste, no-clear copy).
    const detachClipboard = attachClipboard(host, handle.terminal);
    // trmx-95 (FR-8): auto-copy-on-select — attached per pane ONLY while terminal.copyOnSelect is on,
    // and live-toggled below via settings:changed (attach on/off without a remount). Same clipboard
    // sink as ⌘C, so the two produce byte-identical text.
    let detachCopyOnSelect: (() => void) | undefined;
    const syncCopyOnSelect = (enabled: boolean) => {
      if (enabled && !detachCopyOnSelect) {
        detachCopyOnSelect = attachCopyOnSelect(host, handle.terminal);
      } else if (!enabled && detachCopyOnSelect) {
        detachCopyOnSelect();
        detachCopyOnSelect = undefined;
      }
    };
    syncCopyOnSelect(copyOnSelectEnabled(makeSettingsStore()));
    // Keep the grid filling the host as the window resizes (issue 2): a size change re-fits, which
    // makes xterm fire onResize → the PTY grid is resized to match (wired in useBackend). Recompute
    // the scrollbar AFTER the fit so it reads the freshly-resized rows/cols (trmx-41).
    // trmx-67: a live window drag floods ResizeObserver ticks; one fit per frame bounds the SIGWINCH
    // stream (xterm's same-size dedup already stops repeats), and a zero-area/hidden host is skipped
    // entirely so the upstream 2×1 floor artifact never reaches the PTY — the first restore's real
    // resize tick re-fits.
    const coalescer = makeResizeCoalescer(() => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      handle.fit();
      scrollbar.recompute();
    }, resizeSchedule);
    const stopObserving = observeResize(host, () => coalescer.tick());
    // trmx-51/53: settings edited in the settings window (or reverted by Reset) apply to the live
    // terminal by option assignment — no remount. Cursor style/blink reassign their options;
    // a theme change (trmx-53, superseding trmx-44's live OS-following) reassigns options.theme
    // wholesale, then syncs the host/body background (the inset + sub-cell remainder) and
    // recomputes the scrollbar (its colors derive from the theme's scrollbarSlider* tokens).
    // trmx-80 (FR-13): scrollback reassigns options.scrollback (xterm truncates on shrink —
    // accepted, documented in scrollbackSettings.ts); a FONT change alters the cell metrics, so
    // it re-fits the grid and recomputes the scrollbar over the fresh rows/cols. Since trmx-80
    // these broadcasts also arrive from the backend's config-file watcher (source "config-file").
    const stopObservingSettings = observeSettings((payload) => {
      applyCursorSettingsChange(handle.terminal as unknown as CursorOptionsSink, payload);
      applyScrollbackSettingsChange(handle.terminal as unknown as ScrollbackOptionsSink, payload);
      const appliedFont = applyFontSettingsChange(
        handle.terminal as unknown as FontOptionsSink,
        payload,
      );
      if (appliedFont) {
        handle.fit();
        scrollbar.recompute();
      }
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
      // trmx-95: a live copy-on-select toggle attaches/detaches the auto-copy listeners in place.
      const copyOnSelectChange = copyOnSelectSettingChange(payload);
      if (copyOnSelectChange !== null) syncCopyOnSelect(copyOnSelectChange);
    });
    return () => {
      stopObserving();
      stopObservingSettings();
      // trmx-67: revoke any coalesced fit still waiting on a frame — a frame that fires after
      // teardown must not touch the disposed terminal.
      coalescer.dispose();
      detachClipboard();
      detachCopyOnSelect?.();
      detachOsc();
      scrollbar.dispose();
      handle.dispose();
    };
  }, [mount, deps, onReady, observeResize, attachScrollbar, observeSettings, attachOscIntegrations, attachClipboard, attachCopyOnSelect, cwdStore, onOscTitle, onBadge, resizeSchedule]);

  return <div ref={hostRef} data-testid="terminal" className="terminal-host" />;
}
