// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the settings-WINDOW shell (replaces the trmx-48 overlay). vmark's layout: a full-height
// sidebar with the "Search settings…" filter and the page list (Terminal, About), the page content
// on the right, and a centered "Settings" title overlay. Because the window uses the Overlay
// titlebar with a hidden native title, the top strips and the title overlay carry
// `data-tauri-drag-region` — that chrome is what makes the window draggable. Presentational with
// injected seams (update/appInfo/opener/settings/listen); SettingsWindowHost does the real wiring.
import { useEffect, useState, type ReactNode } from "react";
import { AboutSettings } from "./AboutSettings";
import { TerminalSettings } from "./TerminalSettings";
import { InfoIcon, SearchIcon, TerminalIcon } from "./icons";
import type { SettingsSection } from "../surface";
import type { AppInfo } from "../update/appInfo";
import type { Opener } from "../update/opener";
import type { UseUpdate } from "../update/useUpdate";
import type { SettingsStore } from "./settingsStore";
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
  /** Subscription seam for settings:navigate; absent in tests/dev browser is fine. */
  listen?: ListenFn;
}

const NAV: ReadonlyArray<{ id: SettingsSection; label: string; icon: ReactNode }> = [
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

  useEffect(() => {
    if (!listen) return;
    let live = true;
    const unsubs: Array<() => void> = [];
    listen(SETTINGS_NAVIGATE_EVENT, (payload) => {
      if (payload === "terminal" || payload === "about") setSection(payload);
    })
      .then((unlisten) => (live ? unsubs.push(unlisten) : unlisten()))
      .catch(() => {
        // No runtime — the nav still works by clicks.
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
          {section === "terminal" ? (
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
