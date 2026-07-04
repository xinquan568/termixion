// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-53: the Appearance page — exactly the one row the issue boxes out of vmark's Appearance
// page (issues/trmx-53/theme-*.png): a "Theme" group with six labeled color swatches, the
// selected one ring-highlighted. CONTROLLED by the shell: `selected` is SettingsApp's theme
// state, so cross-window broadcasts and About-page resets move the ring too (step-9 F1). A click
// persists through the registry (which broadcasts settings:changed so the live terminal
// re-themes) and notifies the shell via onThemeChange so the settings window restyles
// immediately even without a bus (plain dev/jsdom). Presentational + injected store (R8).
//
// trmx-81 (FR-2.2): the "Tab bar" group below Theme — a Position row (SegmentedControl over
// tabs.barPosition). Local state seeded from the injected store at mount, the TerminalSettings
// row pattern; the write goes through settings.set, whose broadcast is what the main window's
// App applies live (this window has no bar to move).
import { useState } from "react";
import { SegmentedControl, SettingRow, SettingsGroup } from "./components";
import type { SettingsStore, TabBarPosition } from "./settingsStore";
import { THEME_IDS, themeLabel, themes, type ThemeId } from "../theme/themes";

const TAB_BAR_POSITION_OPTIONS: ReadonlyArray<{ value: TabBarPosition; label: string }> = [
  { value: "top", label: "Top" },
  { value: "bottom", label: "Bottom" },
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
];

export interface AppearanceSettingsProps {
  settings: SettingsStore;
  /** The active theme (SettingsApp's state) — the single selection source. */
  selected: ThemeId;
  /** Shell hook: re-derive the window's CSS vars for the new theme (SettingsApp). */
  onThemeChange?: (id: ThemeId) => void;
}

export function AppearanceSettings({ settings, selected, onThemeChange }: AppearanceSettingsProps) {
  const [barPosition, setBarPosition] = useState<TabBarPosition>(() =>
    settings.get("tabs.barPosition"),
  );

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
      <SettingsGroup title="Tab bar">
        <SettingRow label="Position" description="Window edge the tab bar sits on">
          <SegmentedControl
            value={barPosition}
            options={TAB_BAR_POSITION_OPTIONS}
            label="Tab bar position"
            onChange={(value) => {
              setBarPosition(value);
              settings.set("tabs.barPosition", value);
            }}
          />
        </SettingRow>
      </SettingsGroup>
    </div>
  );
}
