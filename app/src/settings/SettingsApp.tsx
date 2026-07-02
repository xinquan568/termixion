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
import { useEffect, useState, type ReactNode } from "react";
import { AboutSettings } from "./AboutSettings";
import { AppearanceSettings } from "./AppearanceSettings";
import { TerminalSettings } from "./TerminalSettings";
import { InfoIcon, PaletteIcon, SearchIcon, TerminalIcon } from "./icons";
import { isSection, type SettingsSection } from "../surface";
import type { AppInfo } from "../update/appInfo";
import type { Opener } from "../update/opener";
import type { UseUpdate } from "../update/useUpdate";
import { SETTINGS_CHANGED_EVENT, type SettingsStore } from "./settingsStore";
import { isThemeId, type ThemeId } from "../theme/themes";
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

  // Re-derive the window's CSS vars whenever the theme changes (and once on mount).
  useEffect(() => {
    applyTxTheme(theme, document);
  }, [theme]);

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
    subscribe(SETTINGS_CHANGED_EVENT, (payload) => {
      if (typeof payload !== "object" || payload === null) return;
      const { key, value } = payload as { key?: unknown; value?: unknown };
      if (key === "appearance.theme" && isThemeId(value)) setTheme(value);
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
        <div className="tx-settings__page">
          {section === "appearance" ? (
            <AppearanceSettings settings={settings} onThemeChange={setTheme} />
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
