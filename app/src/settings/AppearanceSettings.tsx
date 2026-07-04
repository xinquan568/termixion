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
// tabs.barPosition). The write goes through settings.set, whose broadcast is what the main
// window's App applies live (this window has no bar to move).
//
// trmx-82 (FR-2.3): the Position row is now CONTROLLED by the shell (the D5 lift — `barPosition`
// prop + onBarPositionChange, the exact theme pattern), because the new Orientation row below it
// needs the LIVE position: tabs.sideLabelOrientation only ever takes effect on left/right rails
// (barLayout's labelOrientationFor gate), so on top/bottom bars the row renders DISABLED with a
// hint line and never writes. The gate derives PURELY from the prop — no subscription here; the
// shell keeps it current — via the same barLayoutFor the main window's layout runs on.
import { useState } from "react";
import { SegmentedControl, SettingRow, SettingsGroup } from "./components";
import type { LabelOrientation, SettingsStore, TabBarPosition } from "./settingsStore";
import { barLayoutFor } from "../tabs/barLayout";
import { THEME_IDS, themeLabel, themes, type ThemeId } from "../theme/themes";

const TAB_BAR_POSITION_OPTIONS: ReadonlyArray<{ value: TabBarPosition; label: string }> = [
  { value: "top", label: "Top" },
  { value: "bottom", label: "Bottom" },
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
];

const LABEL_ORIENTATION_OPTIONS: ReadonlyArray<{ value: LabelOrientation; label: string }> = [
  { value: "horizontal", label: "Horizontal" },
  { value: "vertical", label: "Vertical" },
];

/** The Orientation row's why-is-this-off hint (shown only while the row is disabled). */
const ORIENTATION_HINT = "Only applies when the tab bar is on the left or right.";

export interface AppearanceSettingsProps {
  settings: SettingsStore;
  /** The active theme (SettingsApp's state) — the single selection source. */
  selected: ThemeId;
  /** Shell hook: re-derive the window's CSS vars for the new theme (SettingsApp). */
  onThemeChange?: (id: ThemeId) => void;
  /** The LIVE bar position (SettingsApp's state, trmx-82 D5) — selects the Position segment and
   * gates the Orientation row (only left/right rails can rotate labels). */
  barPosition: TabBarPosition;
  /** Shell hook: keep SettingsApp's barPosition current on a local click (the busless path). */
  onBarPositionChange?: (position: TabBarPosition) => void;
}

export function AppearanceSettings({
  settings,
  selected,
  onThemeChange,
  barPosition,
  onBarPositionChange,
}: AppearanceSettingsProps) {
  // trmx-82: the ORIENTATION value stays local (seeded from the injected store at mount, the
  // TerminalSettings row pattern) — only its ENABLEMENT is shell-driven, via the prop.
  const [sideLabelOrientation, setSideLabelOrientation] = useState<LabelOrientation>(() =>
    settings.get("tabs.sideLabelOrientation"),
  );
  // Derived PURELY from the prop through the same layout engine App runs on: the setting can
  // only take effect on a vertical rail, so anywhere else the row is disabled (value preserved).
  const orientationApplies = barLayoutFor(barPosition).orientation === "vertical";

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
              settings.set("tabs.barPosition", value);
              onBarPositionChange?.(value);
            }}
          />
        </SettingRow>
        <SettingRow
          label="Orientation"
          description={orientationApplies ? undefined : ORIENTATION_HINT}
        >
          <SegmentedControl
            value={sideLabelOrientation}
            options={LABEL_ORIENTATION_OPTIONS}
            label="Tab label orientation"
            disabled={!orientationApplies}
            onChange={(value) => {
              // Unreachable while disabled (the SegmentedControl contract): the persisted value
              // is never touched by a click on a gated-off row.
              setSideLabelOrientation(value);
              settings.set("tabs.sideLabelOrientation", value);
            }}
          />
        </SettingRow>
      </SettingsGroup>
    </div>
  );
}
