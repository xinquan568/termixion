// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu

// trmx-254 (T11): the app-level services — boot, layout measurement, service-path delivery, session
// notices, the control bridge, settings sync, theme hot-reload and the window-title mirror. Pure
// logic: no state, no refs, no effects.
//
// Its outward set is EMPTY: nothing declared here is read anywhere else, which is what makes this a
// service module rather than another shared surface. The eight effects keep their registrations and
// dependency arrays at the root and call these operations.

import type { Dispatch, SetStateAction } from "react";
import { buildLsSnapshot, routeControlRequest, type ControlDeps } from "../control/controlBridge";
import { takePendingOpenPaths } from "../ipc/backend";
import { realEventBus } from "../ipc/eventBus";
import { log } from "../ipc/logSink";
import type { PaneId } from "../panes/layoutTree";
import { listScripts } from "../scripts/scriptsBackend";
import {
  isLabelOrientation,
  isTabBarPosition,
  type LabelOrientation,
  type TabBarPosition,
} from "../store/settingsStore";
import { useSettingsStore } from "../store/settingsRuntimeContext";
import { paneBySessionId, type TabsState } from "../tabs/tabState";
import { writePaneNotice } from "../terminal/appSeams";
import { activityErrorColorFor, activityIsDarkFor } from "../theme/activityColors";
import { normalizeLegacyThemeId } from "../theme/defaultTheme";
import { isRegisteredThemeId, isUserThemeIdShape, resolveTheme } from "../theme/registry";
import { applyTxTheme } from "../theme/txCssVars";
import type { Command } from "../commands/registry";
import type { Dispatcher } from "../commands/dispatch";
import type { ControlRequestObservation } from "../control/controlRequestSeam";
import type { SettingsObservation } from "../terminal/TerminalView";
import type { Tab } from "../tabs/tabState";
import type { installThemeHotReload } from "../startup/themeHotReload";
import type { PaneRuntime, PaneRuntimes } from "./paneRuntime";

export type AppServicesDeps = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  stateRef: { current: TabsState };
  runtimesRef: { current: PaneRuntimes };
  bootedRef: { current: boolean };
  startupFiredRef: { current: boolean };
  deliverServicePathsRef: { current: (paths: string[]) => void };
  createTabRef: { current: (cwdOverride?: string) => { tabId: number; paneId: number } };
  contentRef: { current: HTMLDivElement | null };
  ffmRef: { current: boolean };
  seamsRef: { current: { setWindowTitle: (t: string) => void; sendInput: (id: number, d: string) => Promise<void> } };
  dispatcherRef: { current: Dispatcher | null };
  commandsRef: { current: Command[] };
  serviceBootPaths: string[];
  activeTitle: string | undefined;
  getActiveTab: () => Tab | undefined;
  seedPaneField: <K extends keyof PaneRuntime>(paneId: PaneId, field: K, value: PaneRuntime[K]) => void;
  observeServiceNudge: (on: () => void) => () => void;
  observeSessionNotice: (on: (n: { session_id: number; text: string }) => void) => () => void;
  observeControlRequest: ControlRequestObservation;
  observeSettings: SettingsObservation;
  installHotReload: typeof installThemeHotReload;
  setBounds: Dispatch<SetStateAction<{ x: number; y: number; width: number; height: number }>>;
  setBarPosition: Dispatch<SetStateAction<TabBarPosition>>;
  setSideLabelOrientation: Dispatch<SetStateAction<LabelOrientation>>;
  setActivityIndicatorOn: Dispatch<SetStateAction<boolean>>;
  setShortcutHintsOn: Dispatch<SetStateAction<boolean>>;
  setAiCounterOn: Dispatch<SetStateAction<boolean>>;
  setBadgeColor: Dispatch<SetStateAction<string>>;
  setBadgeOutlineColor: Dispatch<SetStateAction<string>>;
  setActivityIsDark: Dispatch<SetStateAction<boolean>>;
  setActivityErrorColor: Dispatch<SetStateAction<string>>;
  setSearchColors: Dispatch<SetStateAction<{ match: string; activeMatch: string }>>;
};

export type AppServices = {
  boot: () => void | (() => void);
  observeContentSize: () => void | (() => void);
  drainServicePaths: () => () => void;
  onSessionNotice: () => () => void;
  installControlBridge: () => () => void;
  onSettingsChanged: () => () => void;
  installThemeHotReload: () => () => void;
  mirrorWindowTitle: () => void;
};

export function useAppServices(deps: AppServicesDeps): AppServices {
  const {
    invoke, stateRef, runtimesRef, bootedRef, startupFiredRef, deliverServicePathsRef, createTabRef,
    contentRef, ffmRef, seamsRef, dispatcherRef, commandsRef, serviceBootPaths,
    activeTitle, getActiveTab, seedPaneField,
    observeServiceNudge, observeSessionNotice, observeControlRequest, observeSettings,
    installHotReload, setBounds, setBarPosition, setSideLabelOrientation, setActivityIndicatorOn,
    setShortcutHintsOn, setAiCounterOn, setBadgeColor, setBadgeOutlineColor, setActivityIsDark,
    setActivityErrorColor, setSearchColors,
  } = deps;
  // trmx-253 (T3.4): both settings reads below come off THIS window's runtime — the startup-script
  // path through a plain store, the theme hot-reload through one that broadcasts on the real bus.
  const settings = useSettingsStore();
  const themeReloadSettings = useSettingsStore(realEventBus, "themes-reload");

  const boot = () => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    if (stateRef.current.tabs.length === 0) {
      // trmx-224: a service-triggered cold launch (main.tsx pre-fetched the queued dirs
      // BEFORE mount) opens the requested dirs as the initial tabs — no default $HOME tab,
      // no startup script. Plain boot (the empty default) is byte-identical to before.
      if (serviceBootPaths.length > 0) {
        deliverServicePathsRef.current(serviceBootPaths);
        return;
      }
      const startupPath = settings.get("scripts.startup");
      // The boot default tab goes through the shared creation primitive (one reservation
      // per dispatch; at boot there is no active tab, so the inherited cwd is undefined —
      // identical to the pre-trmx-224 unseeded open), and the startup script keys off the
      // RETURNED pane id like every other wrapper.
      const opened = createTabRef.current();
      if (startupPath && !startupFiredRef.current) {
        startupFiredRef.current = true;
        seedPaneField(
          opened.paneId, "pendingScript", listScripts(invoke).then((scripts) => {
            const match = scripts.find((entry) => entry.relPath === startupPath);
            if (!match) {
              log.warn(
                `startup script "${startupPath}" not found in ~/.config/termixion/scripts/; starting a plain shell`,
              );
              return null;
            }
            return { sourceLine: match.sourceLine };
          }),
        );
      }
    }
  };

  const observeContentSize = () => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[entries.length - 1]?.contentRect;
      if (r && r.width > 0 && r.height > 0) {
        setBounds({ x: 0, y: 0, width: Math.round(r.width), height: Math.round(r.height) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  };

  const drainServicePaths = () => {
    return observeServiceNudge(() => {
      void takePendingOpenPaths(invoke).then((paths) => {
        if (paths.length > 0) deliverServicePathsRef.current(paths);
      });
    });
  };

  const onSessionNotice = () => {
    return observeSessionNotice(({ session_id, text }) => {
      const hit = paneBySessionId(stateRef.current, session_id);
      if (!hit) return;
      const handle = runtimesRef.current.get(hit.paneId)?.handle;
      if (handle) writePaneNotice(handle, text);
    });
  };

  const installControlBridge = () => {
    const paneBusy = (paneId: PaneId): boolean => {
      for (const tab of stateRef.current.tabs) {
        const pane = tab.panes[paneId];
        if (pane) return pane.activityVisible === true;
      }
      return false;
    };
    return observeControlRequest(({ id, request }) => {
      const deps: ControlDeps = {
        // trmx-144: forward the router's "remote" source so close commands skip the confirm gate.
        dispatch: (cmd, arg, source) => dispatcherRef.current?.dispatch(cmd, arg, source) ?? false,
        hasCommand: (cmd) => dispatcherRef.current?.get(cmd) !== undefined,
        // trmx-235: the `commands` query lists every registry id (the documented callable set).
        listCommands: () => commandsRef.current.map((c) => c.id),
        buildLs: () =>
          buildLsSnapshot(
            stateRef.current.tabs,
            stateRef.current.activeTabId,
            (paneId) => runtimesRef.current.get(paneId)?.cwd?.get() ?? null,
            paneBusy,
          ),
        sendText: (pane, text) => {
          const active = getActiveTab();
          const paneId = pane === "focused" ? active?.focusedPaneId : Number(pane);
          if (paneId === undefined || Number.isNaN(paneId)) return false;
          const sessionId = runtimesRef.current.get(paneId)?.sessionId;
          if (sessionId === undefined) return false;
          seamsRef.current.sendInput(sessionId, text).catch(() => {});
          return true;
        },
      };
      const payload = routeControlRequest(request, deps);
      invoke("control_response", { id, payload }).catch(() => {});
    });
  };

  const onSettingsChanged = () => {
    const stopSettings = observeSettings((payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const { key, value } = payload as { key?: unknown; value?: unknown };
      if (key === "tabs.barPosition" && isTabBarPosition(value)) setBarPosition(value);
      else if (key === "tabs.sideLabelOrientation" && isLabelOrientation(value)) {
        setSideLabelOrientation(value);
      }
      // trmx-91: keep the activity-indicator toggle live (boolean-guarded, the untrusted-payload
      // discipline). Off hides the line without touching the backend poller (titles keep flowing).
      // trmx-225: keep the FFM gate live — a ref (not state): the hover handler reads it per
      // event and nothing needs a re-render on toggle.
      else if (key === "terminal.focusFollowsMouse" && typeof value === "boolean") {
        ffmRef.current = value;
      } else if (key === "terminal.activityIndicator" && typeof value === "boolean") {
        setActivityIndicatorOn(value);
      }
      // trmx-151: keep the ⌘N hint toggle live (same boolean guard). Off strips the prefixes
      // without touching the keymap — the chords stay bound either way.
      else if (key === "tabs.showShortcutHints" && typeof value === "boolean") {
        setShortcutHintsOn(value);
      }
      // trmx-190: keep the AI-session-counter toggle live (same boolean guard). A pure render
      // gate — foreground tracking keeps running so re-enabling shows correct counts at once.
      else if (key === "titleBar.aiCounter" && typeof value === "boolean") {
        setAiCounterOn(value);
      }
      // trmx-90/91: recompute the badge watermark AND the activity-line color on every theme event so
      // both repaint on a theme switch AND on a trmx-89 same-id hot-reload (the token changed under the
      // same id, review-1). Same untrusted-payload discipline as barPosition; resolveTheme is total.
      else if (key === "appearance.theme") {
        // trmx-202: a REMOVED built-in (live config edit / the watcher's default "white")
        // normalizes to the derived default before the guard; user-shape ids pass untouched.
        const themeId = normalizeLegacyThemeId(value) ?? value;
        if (isRegisteredThemeId(themeId) || isUserThemeIdShape(themeId)) {
          // trmx-173: re-apply the --tx-* CSS vars on documentElement so the main window's chrome (tab
          // bar, borders, …) recolors with the terminal. On EVERY theme event — including a trmx-89
          // same-id hot-reload where the tokens changed under the same id — matching the color-state
          // refreshes below; applyTxTheme is idempotent, so a bus echo is harmless.
          applyTxTheme(themeId, document);
          setBadgeColor(resolveTheme(themeId).terminal.badge);
          setBadgeOutlineColor(resolveTheme(themeId).color.bg.primary); // trmx-149: re-tint the stroke
          setActivityIsDark(activityIsDarkFor(themeId)); // trmx-160: re-key the progress bar's mode
          setActivityErrorColor(activityErrorColorFor(themeId)); // trmx-99: re-tint the exit-code flash
          setSearchColors(resolveTheme(themeId).terminal.search); // trmx-98: re-tint the find highlights
        }
      }
    });
    return stopSettings;
  };

  const installThemeHotReload = () => {
    return installHotReload({
      settings: themeReloadSettings,
    });
  };

  const mirrorWindowTitle = () => {
    if (activeTitle === undefined) return;
    seamsRef.current.setWindowTitle(activeTitle);
  };

  return {
    boot, observeContentSize, drainServicePaths, onSessionNotice,
    installControlBridge, onSettingsChanged, installThemeHotReload, mirrorWindowTitle,
  };
}
