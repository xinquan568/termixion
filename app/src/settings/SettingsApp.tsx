// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the settings-WINDOW shell (replaces the trmx-48 overlay). vmark's layout: a full-height
// sidebar with the "Search settings…" filter and the page list (Appearance, Terminal, About), the
// page content on the right, and a centered "Settings" title overlay. Because the window uses the
// Overlay titlebar with a hidden native title, the top strips and the title overlay carry
// `data-tauri-drag-region` — that chrome is what makes the window draggable. Presentational with
// injected seams (update/appInfo/opener/settings/listen); SettingsWindowHost does the real wiring.
//
// trmx-53: the shell owns the window's THEME. On mount it applies the persisted theme's --tx-*
// vars (documentElement — see txCssVars.ts for the cascade contract); the Appearance page's
// onThemeChange restyles instantly without a bus, and the settings:changed subscription restyles
// on About-page resets / cross-window writes (payload-guarded; echoes are idempotent re-applies).
//
// trmx-80 (FR-13): the shell also surfaces the CONFIG-FILE WARNINGS (a hand-edited config.toml
// with syntax errors / unknown keys / invalid values) as a dismissable banner at the top of the
// content pane. State seeds from getConfigWarnings() at mount and stays current through
// onConfigWarningsChanged — the STORE is the single warnings authority (review R2): it notifies
// on every backend re-parse (including the EMPTY set, which clears the banner once the user
// fixes the file) AND on client-authored warnings (e.g. an invalid live theme), which no raw
// config:warnings event ever carries. A fresh non-empty set un-dismisses the banner.
//
// trmx-82 (FR-2.3, D5): the shell also owns the LIVE tabs.barPosition — seeded from the injected
// store, kept current by the SAME payload-guarded settings:changed subscription the theme rides
// (cross-window writes, config-file edits, About-page resets) — and hands it to the Appearance
// page, whose Orientation row it gates (top/bottom bars disable it). The theme pattern exactly:
// AppearanceSettings stays controlled, its onBarPositionChange feeds a local click back here so
// the gate flips instantly even without a bus (plain dev/jsdom).
import { useEffect, useState, type ReactNode } from "react";
import { AboutSettings } from "./AboutSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { TerminalSettings } from "./TerminalSettings";
import { InfoIcon, PaletteIcon, SearchIcon, TerminalIcon } from "./icons";
import { isSection, type SettingsSection } from "../surface";
import type { AppInfo } from "../update/appInfo";
import type { Opener } from "../update/opener";
import type { UseUpdate } from "../update/useUpdate";
import {
  getConfigWarnings,
  isTabBarPosition,
  onConfigWarningsChanged,
  SETTINGS_CHANGED_EVENT,
  type ConfigWarningItem,
  type SettingsStore,
  type TabBarPosition,
} from "./settingsStore";
import { isRegisteredThemeId } from "../theme/registry";
import type { ThemeId } from "../theme/themes";
import { applyTxTheme } from "../theme/txCssVars";
import "./settings.css";

/** Emitted by the shell (window_manager.rs) to switch an already-open window's page. */
export const SETTINGS_NAVIGATE_EVENT = "settings:navigate";

type ListenFn = (event: string, handler: (payload: unknown) => void) => Promise<() => void>;

export interface SettingsAppProps {
  initialSection?: SettingsSection | null;
  update: UseUpdate;
  appInfo: AppInfo;
  opener: Opener;
  settings: SettingsStore;
  /** Subscription seam for settings:navigate + settings:changed; absent in tests/dev browser is fine. */
  listen?: ListenFn;
}

// trmx-53: Appearance leads the nav (the issue's "new first section"), like vmark.
const NAV: ReadonlyArray<{ id: SettingsSection; label: string; icon: ReactNode }> = [
  { id: "appearance", label: "Appearance", icon: <PaletteIcon /> },
  { id: "terminal", label: "Terminal", icon: <TerminalIcon /> },
  { id: "about", label: "About", icon: <InfoIcon /> },
];

export function SettingsApp({
  initialSection,
  update,
  appInfo,
  opener,
  settings,
  listen,
}: SettingsAppProps) {
  const [section, setSection] = useState<SettingsSection>(initialSection ?? "terminal");
  const [query, setQuery] = useState("");
  // trmx-53: the window's active theme; initial read materializes the first-run default.
  const [theme, setTheme] = useState<ThemeId>(() => settings.get("appearance.theme"));
  // trmx-82 (D5): the LIVE bar position for the Appearance page's Orientation gate.
  const [barPosition, setBarPosition] = useState<TabBarPosition>(() =>
    settings.get("tabs.barPosition"),
  );
  // trmx-80: the config-file warnings banner, seeded from the hydrated module state.
  const [warnings, setWarnings] = useState<ConfigWarningItem[]>(() => getConfigWarnings());
  const [warningsDismissed, setWarningsDismissed] = useState(false);

  // Re-derive the window's CSS vars whenever the theme changes (and once on mount).
  useEffect(() => {
    applyTxTheme(theme, document);
  }, [theme]);

  // trmx-80 review R2: the ONE warnings path — the store notifies on every change (backend
  // re-parse including the empty set, client-authored warnings) and un-dismissing here means a
  // new problem is never hidden by an old dismissal (an empty set renders no banner anyway).
  useEffect(
    () =>
      onConfigWarningsChanged((items) => {
        setWarnings(items);
        setWarningsDismissed(false);
      }),
    [],
  );

  useEffect(() => {
    if (!listen) return;
    let live = true;
    const unsubs: Array<() => void> = [];
    const subscribe = (event: string, handler: (payload: unknown) => void) => {
      listen(event, handler)
        .then((unlisten) => (live ? unsubs.push(unlisten) : unlisten()))
        .catch(() => {
          // No runtime — the nav still works by clicks, the theme by onThemeChange.
        });
    };
    subscribe(SETTINGS_NAVIGATE_EVENT, (payload) => {
      if (isSection(payload)) setSection(payload);
    });
    // trmx-53: About-page resets and cross-window writes restyle this window live. Payloads are
    // untrusted; junk is inert. Same-window echoes just re-apply identical values.
    // trmx-82: the ONE subscription now guards TWO keys — the bar position rides the same
    // payload guard (junk values inert, exactly like the theme's).
    subscribe(SETTINGS_CHANGED_EVENT, (payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const { key, value } = payload as { key?: unknown; value?: unknown };
      // trmx-89 (D): registry-aware guard — a built-in OR a registered user theme id re-styles.
      if (key === "appearance.theme" && isRegisteredThemeId(value)) setTheme(value);
      else if (key === "tabs.barPosition" && isTabBarPosition(value)) setBarPosition(value);
    });
    return () => {
      live = false;
      unsubs.forEach((u) => u());
    };
  }, [listen]);

  const visibleNav = NAV.filter((item) =>
    item.label.toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <div className="tx-settings">
      <aside className="tx-settings__sidebar">
        {/* Top strip under the floating traffic lights; draggable chrome. */}
        <div className="tx-settings__drag" data-tauri-drag-region />
        <div className="tx-settings__search">
          <SearchIcon />
          <input
            type="search"
            placeholder="Search settings…"
            aria-label="Search settings"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <nav className="tx-settings__nav">
          {visibleNav.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`tx-nav-item${section === item.id ? " tx-nav-item--active" : ""}`}
              onClick={() => setSection(item.id)}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <div className="tx-settings__content">
        <div className="tx-settings__drag" data-tauri-drag-region />
        {warnings.length > 0 && !warningsDismissed ? (
          <div className="tx-settings__warnings" role="alert">
            <div className="tx-settings__warnings-title">Config file warnings</div>
            <ul className="tx-settings__warnings-list">
              {warnings.map((w, i) => (
                <li key={i}>{w.message}</li>
              ))}
            </ul>
            <button
              type="button"
              className="tx-settings__warnings-dismiss"
              aria-label="Dismiss config warnings"
              onClick={() => setWarningsDismissed(true)}
            >
              ×
            </button>
          </div>
        ) : null}
        <div className="tx-settings__page">
          {section === "appearance" ? (
            <AppearanceSettings
              settings={settings}
              selected={theme}
              onThemeChange={setTheme}
              barPosition={barPosition}
              onBarPositionChange={setBarPosition}
            />
          ) : section === "terminal" ? (
            <TerminalSettings settings={settings} />
          ) : (
            <AboutSettings update={update} appInfo={appInfo} opener={opener} settings={settings} />
          )}
        </div>
      </div>

      {/* Centered over the content pane (offset past the sidebar), like vmark's title overlay. */}
      <div className="tx-settings__title" data-tauri-drag-region>
        <span>Settings</span>
      </div>
    </div>
  );
}
