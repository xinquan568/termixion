// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the Terminal settings page — the two rows the issue boxes out of vmark's screenshot:
// Cursor Style (Bar │ / Block █ / Underline ▁ — vmark's glyphed labels, Underline by default) and
// Cursor Blink (off by default since trmx-55). Writes go through the settings registry, which
// persists and broadcasts `settings:changed` so the live terminal in the main window applies the
// change immediately. Presentational + injected store: unit-tested headless (R8).
//
// trmx-80 (FR-13) adds the scrollback/font trio below them: Scrollback (a clamped commit-on-blur
// numeric field — shrinking truncates the existing buffer, xterm behavior), Font Family (empty =
// the platform default stack, which the placeholder names — ITERM2_FONT_FAMILY), and Font Size
// (a ± stepper bounded by the registry range). The fields clamp with SETTING_RANGES so the value
// shown is exactly the value persisted (the registry would clamp again anyway — same contract).
import { useState } from "react";
import { NumberField, SettingRow, SettingsGroup, Select, TextField, Toggle } from "./components";
import { ITERM2_FONT_FAMILY } from "../terminal/iterm2Theme";
import { SETTING_RANGES, type CursorStyle, type SettingsStore } from "./settingsStore";

const CURSOR_STYLE_OPTIONS: ReadonlyArray<{ value: CursorStyle; label: string }> = [
  { value: "bar", label: "Bar │" },
  { value: "block", label: "Block █" },
  { value: "underline", label: "Underline ▁" },
];

const SCROLLBACK_RANGE = SETTING_RANGES["terminal.scrollbackLines"];
const FONT_SIZE_RANGE = SETTING_RANGES["terminal.fontSize"];

export interface TerminalSettingsProps {
  settings: SettingsStore;
}

export function TerminalSettings({ settings }: TerminalSettingsProps) {
  const [cursorStyle, setCursorStyle] = useState<CursorStyle>(() =>
    settings.get("terminal.cursorStyle"),
  );
  const [cursorBlink, setCursorBlink] = useState<boolean>(() =>
    settings.get("terminal.cursorBlink"),
  );
  // trmx-91: the FR-7a activity indicator on/off (default on) — App shows/hides the per-pane green
  // line live when this broadcasts settings:changed.
  const [activityIndicator, setActivityIndicator] = useState<boolean>(() =>
    settings.get("terminal.activityIndicator"),
  );
  const [scrollback, setScrollback] = useState<number>(() =>
    settings.get("terminal.scrollbackLines"),
  );
  const [fontFamily, setFontFamily] = useState<string>(() =>
    settings.get("terminal.fontFamily"),
  );
  const [fontSize, setFontSize] = useState<number>(() => settings.get("terminal.fontSize"));

  return (
    <div className="tx-terminal-settings">
      <SettingsGroup>
        <SettingRow label="Cursor Style" description="Shape of the terminal cursor">
          <Select
            value={cursorStyle}
            options={CURSOR_STYLE_OPTIONS}
            label="Cursor Style"
            onChange={(value) => {
              setCursorStyle(value);
              settings.set("terminal.cursorStyle", value);
            }}
          />
        </SettingRow>
        <SettingRow label="Cursor Blink" description="Whether the terminal cursor blinks">
          <Toggle
            checked={cursorBlink}
            label="Cursor Blink"
            onChange={(value) => {
              setCursorBlink(value);
              settings.set("terminal.cursorBlink", value);
            }}
          />
        </SettingRow>
        <SettingRow
          label="Activity Indicator"
          description="Show a green line while a command is running"
        >
          <Toggle
            checked={activityIndicator}
            label="Activity Indicator"
            onChange={(value) => {
              setActivityIndicator(value);
              settings.set("terminal.activityIndicator", value);
            }}
          />
        </SettingRow>
        <SettingRow label="Scrollback" description="Lines of history kept per terminal">
          <NumberField
            value={scrollback}
            min={SCROLLBACK_RANGE.min}
            max={SCROLLBACK_RANGE.max}
            label="Scrollback"
            onCommit={(value) => {
              setScrollback(value);
              settings.set("terminal.scrollbackLines", value);
            }}
          />
        </SettingRow>
        <SettingRow label="Font Family" description="Empty uses the platform default">
          <TextField
            value={fontFamily}
            placeholder={ITERM2_FONT_FAMILY}
            label="Font Family"
            onCommit={(value) => {
              setFontFamily(value);
              settings.set("terminal.fontFamily", value);
            }}
          />
        </SettingRow>
        <SettingRow label="Font Size" description="Terminal font size in points">
          <NumberField
            value={fontSize}
            min={FONT_SIZE_RANGE.min}
            max={FONT_SIZE_RANGE.max}
            label="Font Size"
            stepper
            onCommit={(value) => {
              setFontSize(value);
              settings.set("terminal.fontSize", value);
            }}
          />
        </SettingRow>
      </SettingsGroup>
    </div>
  );
}
