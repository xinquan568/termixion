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
//
// trmx-89 (4b): the USER-THEME picker. The Theme row now renders the full registry list
// (`listThemes()` — built-ins first, then the user themes the settings window hydrated into its
// own registry instance), not just the closed built-in catalog. A user theme resolves its swatch
// color through the registry (`resolveTheme`); a VALID one is selectable exactly like a built-in
// (a low-contrast one still applies, flagged with a WARNING badge + tooltip), an INVALID one lists
// but is inert (an ERROR badge + tooltip, no radio role, no click). Each BUILT-IN carries a
// "Duplicate" affordance that writes a complete TOML copy into the user themes dir (themeTokensToToml
// → writeUserTheme), re-hydrates the registry, and selects the new `user:<stem>`. An "Open themes
// folder" button reveals the dir, and a hint links the file-format docs. The backend edge is the
// injected `invoke` seam (default realInvoke) so tests drive a fake.
import { useState } from "react";
import { SegmentedControl, SettingRow, SettingsGroup } from "./components";
import type { LabelOrientation, SettingsStore, TabBarPosition } from "./settingsStore";
import { barLayoutFor } from "../tabs/barLayout";
import type { ThemeId } from "../theme/themes";
import {
  listThemes,
  resolveTheme,
  type ThemeDiagnostic,
  type ThemeListEntry,
} from "../theme/registry";
import { hydrateUserThemes, openThemesDir, writeUserTheme } from "../theme/themesBackend";
import { themeTokensToToml } from "../theme/themeTokensToToml";
import { realInvoke, type InvokeFn } from "../ipc/backend";

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

/** The theme-file format docs (created by a sibling sub-task) — the hint line links here. */
const THEMES_DOC_URL = "https://github.com/xinquan568/termixion/blob/main/docs/themes.md";

/** The first diagnostic message of a given severity, for a swatch's badge tooltip. */
function firstMessage(diagnostics: ThemeDiagnostic[], severity: ThemeDiagnostic["severity"]): string | undefined {
  return diagnostics.find((d) => d.severity === severity)?.message;
}

/**
 * The auto-name for a Duplicate of `builtinId`: `${builtinId}-copy`, then `-copy-2`, `-copy-3`…,
 * skipping any stem already present as a `user:<stem>` id in the registry (`existingIds`). Pure so
 * the naming rule is unit-testable through the Duplicate flow.
 */
function uniqueStem(builtinId: string, existingIds: ReadonlySet<string>): string {
  const base = `${builtinId}-copy`;
  if (!existingIds.has(`user:${base}`)) return base;
  let n = 2;
  while (existingIds.has(`user:${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

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
  /** trmx-89 (4b): the backend edge for the themes-dir actions (open / write / re-hydrate).
   * Injected so tests drive a fake; the packaged app uses the real Tauri invoke. */
  invoke?: InvokeFn;
}

export function AppearanceSettings({
  settings,
  selected,
  onThemeChange,
  barPosition,
  onBarPositionChange,
  invoke = realInvoke,
}: AppearanceSettingsProps) {
  // trmx-82: the ORIENTATION value stays local (seeded from the injected store at mount, the
  // TerminalSettings row pattern) — only its ENABLEMENT is shell-driven, via the prop.
  const [sideLabelOrientation, setSideLabelOrientation] = useState<LabelOrientation>(() =>
    settings.get("tabs.sideLabelOrientation"),
  );
  // Derived PURELY from the prop through the same layout engine App runs on: the setting can
  // only take effect on a vertical rail, so anywhere else the row is disabled (value preserved).
  const orientationApplies = barLayoutFor(barPosition).orientation === "vertical";

  // trmx-89 (4b): the ONE selection path — persist through the registry (which broadcasts so the
  // live terminal re-themes) and notify the shell (the busless dev path). Shared by built-in and
  // valid user swatches; an invalid swatch never reaches it.
  const selectTheme = (id: ThemeId) => {
    settings.set("appearance.theme", id);
    onThemeChange?.(id);
  };

  // trmx-89 (4b): Duplicate a built-in into an editable user theme file. Auto-name a fresh stem,
  // serialize the built-in's FULL tokens to TOML (opens zero-warning, a coherent starting point),
  // write it, re-hydrate the registry so the new theme is resolvable, then select it. Guarded:
  // writeUserTheme rejects on I/O error — surface nothing fatal, the picker just doesn't change.
  const duplicateBuiltin = async (entry: ThemeListEntry) => {
    const existingIds = new Set(listThemes().map((e) => e.id));
    const stem = uniqueStem(entry.id, existingIds);
    const toml = themeTokensToToml(resolveTheme(entry.id), entry.label);
    try {
      await writeUserTheme(stem, toml, invoke);
      await hydrateUserThemes(invoke);
      selectTheme(`user:${stem}`);
    } catch (err) {
      console.warn(`[termixion] duplicating ${entry.id} failed`, err);
    }
  };

  const openFolder = () => {
    openThemesDir(invoke).catch((err: unknown) => {
      console.warn("[termixion] opening the themes folder failed", err);
    });
  };

  return (
    <div className="tx-appearance-settings">
      <SettingsGroup title="Theme">
        <div className="tx-theme-row" role="radiogroup" aria-label="Theme">
          {listThemes().map((entry) => (
            <ThemeSwatch
              key={entry.id}
              entry={entry}
              selected={selected === entry.id}
              onSelect={() => selectTheme(entry.id)}
              onDuplicate={() => void duplicateBuiltin(entry)}
            />
          ))}
        </div>
        <div className="tx-theme-actions">
          <button type="button" className="tx-btn" onClick={openFolder}>
            Open themes folder
          </button>
          <p className="tx-theme-hint">
            Want your own colors?{" "}
            <a
              className="tx-theme-hint__link"
              href={THEMES_DOC_URL}
              target="_blank"
              rel="noreferrer"
            >
              Learn the theme file format
            </a>
            .
          </p>
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

/**
 * One swatch cell. A built-in or VALID user theme renders a selectable radio (circle filled with
 * `resolveTheme(id).color.bg.primary`); a valid-but-low-contrast user theme adds a WARNING badge +
 * tooltip. An INVALID user theme renders an inert, non-radio swatch with an ERROR badge + tooltip.
 * Only built-ins carry the Duplicate affordance (you copy a built-in to start a user theme). The
 * badge/Duplicate are SIBLINGS of the swatch (never nested inside the radio) so the swatch's
 * accessible name / textContent stays exactly its label.
 */
function ThemeSwatch({
  entry,
  selected,
  onSelect,
  onDuplicate,
}: {
  entry: ThemeListEntry;
  selected: boolean;
  onSelect: () => void;
  onDuplicate: () => void;
}) {
  const swatchColor = resolveTheme(entry.id).color.bg.primary;
  const errorMessage = entry.valid ? undefined : firstMessage(entry.diagnostics, "error");
  const warningMessage = entry.valid ? firstMessage(entry.diagnostics, "warning") : undefined;

  const circle = (
    <span className="tx-swatch__circle" style={{ background: swatchColor }} />
  );
  const label = <span className="tx-swatch__label">{entry.label}</span>;

  return (
    <div className="tx-swatch-cell">
      {entry.valid ? (
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          className={`tx-swatch${selected ? " tx-swatch--active" : ""}`}
          title={warningMessage}
          onClick={onSelect}
        >
          {circle}
          {label}
        </button>
      ) : (
        // Not a radio, no onClick: an invalid theme is listed for diagnosis, never selectable.
        <div className="tx-swatch tx-swatch--invalid" aria-disabled="true" title={errorMessage}>
          {circle}
          {label}
        </div>
      )}
      {warningMessage ? (
        <span className="tx-swatch__badge tx-swatch__badge--warning" title={warningMessage}>
          warning
        </span>
      ) : null}
      {errorMessage ? (
        <span className="tx-swatch__badge tx-swatch__badge--error" title={errorMessage}>
          invalid
        </span>
      ) : null}
      {entry.source === "builtin" ? (
        <button
          type="button"
          className="tx-swatch__dup"
          aria-label={`Duplicate ${entry.label}`}
          onClick={onDuplicate}
        >
          Duplicate
        </button>
      ) : null}
    </div>
  );
}
