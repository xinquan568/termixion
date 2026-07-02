// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the Terminal settings page — exactly the two rows the issue boxes out of vmark's
// screenshot: Cursor Style (Bar │ / Block █ / Underline ▁ — vmark's glyphed labels, Underline by
// default) and Cursor Blink (off by default since trmx-55). Writes go through the settings registry, which
// persists and broadcasts `settings:changed` so the live terminal in the main window applies the
// change immediately. Presentational + injected store: unit-tested headless (R8).
import { useState } from "react";
import { SettingRow, SettingsGroup, Select, Toggle } from "./components";
import type { CursorStyle, SettingsStore } from "./settingsStore";

const CURSOR_STYLE_OPTIONS: ReadonlyArray<{ value: CursorStyle; label: string }> = [
  { value: "bar", label: "Bar │" },
  { value: "block", label: "Block █" },
  { value: "underline", label: "Underline ▁" },
];

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
      </SettingsGroup>
    </div>
  );
}
