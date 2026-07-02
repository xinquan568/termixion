// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53: the Appearance page — exactly the one row the issue boxes out of vmark's Appearance
// page (issues/trmx-53/theme-*.png): a "Theme" group with six labeled color swatches, the
// selected one ring-highlighted. A click persists through the registry (which broadcasts
// settings:changed so the live terminal re-themes) and notifies the shell via onThemeChange so
// the settings window itself restyles immediately even without a bus (plain dev/jsdom).
// Presentational + injected store: unit-tested headless (R8).
import { useState } from "react";
import { SettingsGroup } from "./components";
import type { SettingsStore } from "./settingsStore";
import { THEME_IDS, themeLabel, themes, type ThemeId } from "../theme/themes";

export interface AppearanceSettingsProps {
  settings: SettingsStore;
  /** Shell hook: re-derive the window's CSS vars for the new theme (SettingsApp). */
  onThemeChange?: (id: ThemeId) => void;
}

export function AppearanceSettings({ settings, onThemeChange }: AppearanceSettingsProps) {
  const [selected, setSelected] = useState<ThemeId>(() => settings.get("appearance.theme"));

  return (
    <div className="tx-appearance-settings">
      <SettingsGroup title="Theme">
        <div className="tx-theme-row" role="radiogroup" aria-label="Theme">
          {THEME_IDS.map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected === id}
              className={`tx-swatch${selected === id ? " tx-swatch--active" : ""}`}
              onClick={() => {
                setSelected(id);
                settings.set("appearance.theme", id);
                onThemeChange?.(id);
              }}
            >
              <span
                className="tx-swatch__circle"
                style={{ background: themes[id].color.bg.primary }}
              />
              <span className="tx-swatch__label">{themeLabel(id)}</span>
            </button>
          ))}
        </div>
      </SettingsGroup>
    </div>
  );
}
