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
// numeric field — shrinking truncates the existing buffer, xterm behavior), Font Family, and Font
// Size (a ± stepper bounded by the registry range). The fields clamp with SETTING_RANGES so the
// value shown is exactly the value persisted (the registry would clamp again anyway — same contract).
//
// trmx-204: Font Family is a dropdown over the unchanged string setting — the five bundled
// Nerd Font families (fontCatalog.ts) + "System default" ("" sentinel) + "Custom…" (reveals the
// trmx-80 free-text field; any unknown persisted value lands here so nobody's hand-typed font
// regresses). Selecting a bundled entry awaits ensureFontLoaded first so the live terminal
// re-measures with the face already available.
import { useRef, useState } from "react";
import {
  NumberField,
  SegmentedControl,
  SettingRow,
  SettingsGroup,
  Select,
  TextField,
  Toggle,
} from "./components";
import { ITERM2_FONT_FAMILY } from "../terminal/iterm2Theme";
import { BUNDLED_FONTS, ensureFontLoaded, isBundledFamily } from "../terminal/fontCatalog";
import {
  SETTING_RANGES,
  type ConfirmClose,
  type CursorStyle,
  type SettingsStore,
} from "./settingsStore";
import { realInvoke, type InvokeFn } from "../ipc/backend";

// trmx-204: dropdown sentinels — never valid font names, so they can share the value space with
// the persisted family string ("" is the real System-default sentinel in the registry).
const FONT_SYSTEM = "__system__";
const FONT_CUSTOM = "__custom__";

const FONT_FAMILY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  ...BUNDLED_FONTS.map((font) => ({ value: font.family, label: font.label })),
  { value: FONT_SYSTEM, label: "System default" },
  { value: FONT_CUSTOM, label: "Custom…" },
];

const FIRA_CODE_FAMILY = "FiraCode Nerd Font Mono";
const FONT_ROW_DESCRIPTION = "Bundled fonts work out of the box — no installation needed";
const FIRA_CODE_DESCRIPTION =
  "FiraCode's programming ligatures are not rendered by the terminal renderer";

const CURSOR_STYLE_OPTIONS: ReadonlyArray<{ value: CursorStyle; label: string }> = [
  { value: "bar", label: "Bar │" },
  { value: "block", label: "Block █" },
  { value: "underline", label: "Underline ▁" },
];

// trmx-144: the close-confirmation tri-state (pane close, tab close, quit alike).
const CONFIRM_CLOSE_OPTIONS: ReadonlyArray<{ value: ConfirmClose; label: string }> = [
  { value: "never", label: "Never" },
  { value: "when-busy", label: "When busy" },
  { value: "always", label: "Always" },
];

const SCROLLBACK_RANGE = SETTING_RANGES["terminal.scrollbackLines"];
const FONT_SIZE_RANGE = SETTING_RANGES["terminal.fontSize"];

export interface TerminalSettingsProps {
  settings: SettingsStore;
  /** Injected for tests; the real edge writes + reveals the shell-integration snippets (trmx-99). */
  invoke?: InvokeFn;
}

export function TerminalSettings({ settings, invoke = realInvoke }: TerminalSettingsProps) {
  const [cursorStyle, setCursorStyle] = useState<CursorStyle>(() =>
    settings.get("terminal.cursorStyle"),
  );
  const [cursorBlink, setCursorBlink] = useState<boolean>(() =>
    settings.get("terminal.cursorBlink"),
  );
  // trmx-91: the FR-7a activity indicator on/off (default on) — App shows/hides the per-pane green
  // line live when this broadcasts settings:changed.
  const [copyOnSelect, setCopyOnSelect] = useState<boolean>(() =>
    settings.get("terminal.copyOnSelect"),
  );
  const [activityIndicator, setActivityIndicator] = useState<boolean>(() =>
    settings.get("terminal.activityIndicator"),
  );
  // trmx-190: the title-bar AI-session counter gate — a peer of the activity indicator (the
  // counter's numerator IS the lit-activity-bar count, so the two toggles sit together).
  const [aiCounter, setAiCounter] = useState<boolean>(() => settings.get("titleBar.aiCounter"));
  // trmx-144: confirm-before-closing tri-state (default "when-busy").
  const [confirmClose, setConfirmClose] = useState<ConfirmClose>(() =>
    settings.get("terminal.confirmClose"),
  );
  const [scrollback, setScrollback] = useState<number>(() =>
    settings.get("terminal.scrollbackLines"),
  );
  const [fontFamily, setFontFamily] = useState<string>(() =>
    settings.get("terminal.fontFamily"),
  );
  // trmx-204: sticky Custom… mode — choosing Custom… keeps the text field visible while the
  // persisted value still names a bundled family (until the user commits their own stack).
  const [fontCustomMode, setFontCustomMode] = useState<boolean>(
    () => fontFamily !== "" && !isBundledFamily(settings.get("terminal.fontFamily")),
  );
  const [fontSize, setFontSize] = useState<number>(() => settings.get("terminal.fontSize"));

  const fontSelection = fontCustomMode
    ? FONT_CUSTOM
    : fontFamily === ""
      ? FONT_SYSTEM
      : isBundledFamily(fontFamily)
        ? fontFamily
        : FONT_CUSTOM;

  // Step-8 finding 1 (race guard): a bundled selection persists only after its (async) face load,
  // so EVERY selection bumps the request id and a stale load's completion is ignored — the newest
  // user choice always wins, regardless of load latency.
  const fontRequestRef = useRef(0);

  function onFontSelect(value: string) {
    const request = ++fontRequestRef.current;
    if (value === FONT_CUSTOM) {
      setFontCustomMode(true);
      return; // nothing persists until the user commits a custom value
    }
    setFontCustomMode(false);
    if (value === FONT_SYSTEM) {
      setFontFamily("");
      settings.set("terminal.fontFamily", "");
      return;
    }
    // A bundled family: make the face available BEFORE the live terminal re-measures on the
    // broadcast (ensureFontLoaded never throws and never hangs — bounded timeout).
    void ensureFontLoaded(value).then(() => {
      if (fontRequestRef.current !== request) return; // a newer selection superseded this load
      setFontFamily(value);
      settings.set("terminal.fontFamily", value);
    });
  }

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
          label="Copy on Select"
          description="Automatically copy the mouse selection to the clipboard (iTerm2-style)"
        >
          <Toggle
            checked={copyOnSelect}
            label="Copy on Select"
            onChange={(value) => {
              setCopyOnSelect(value);
              settings.set("terminal.copyOnSelect", value);
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
        <SettingRow
          label="AI Session Counter"
          description="Show live AI session counts in the title bar"
        >
          <Toggle
            checked={aiCounter}
            label="AI Session Counter"
            onChange={(value) => {
              setAiCounter(value);
              settings.set("titleBar.aiCounter", value);
            }}
          />
        </SettingRow>
        <SettingRow
          label="Confirm before closing"
          description='Applies when closing a pane, a tab, or quitting; "When busy" prompts only when a program is still running'
        >
          <SegmentedControl
            value={confirmClose}
            options={CONFIRM_CLOSE_OPTIONS}
            label="Confirm before closing"
            onChange={(value) => {
              setConfirmClose(value);
              settings.set("terminal.confirmClose", value);
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
        <SettingRow
          label="Font Family"
          description={
            fontSelection === FIRA_CODE_FAMILY ? FIRA_CODE_DESCRIPTION : FONT_ROW_DESCRIPTION
          }
        >
          <Select
            value={fontSelection}
            options={FONT_FAMILY_OPTIONS}
            label="Font Family"
            onChange={onFontSelect}
          />
          {fontSelection === FONT_CUSTOM ? (
            <TextField
              value={isBundledFamily(fontFamily) ? "" : fontFamily}
              placeholder={ITERM2_FONT_FAMILY}
              label="Font Family"
              onCommit={(value) => {
                fontRequestRef.current++; // a custom commit also supersedes any pending load
                setFontFamily(value);
                setFontCustomMode(value.trim() !== "" && !isBundledFamily(value));
                settings.set("terminal.fontFamily", value);
              }}
            />
          ) : null}
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

      {/* trmx-99 (FR-7b): shell integration — a manual, documented install (we never edit rc files). */}
      <SettingsGroup title="Shell integration">
        <div className="tx-shell-integration">
          <p className="tx-shell-integration__hint">
            Install the OSC 133 snippet for an accurate activity indicator (exact command windows +
            an exit-code failure flash). Reveal the snippets, then add one line to your shell rc file:
          </p>
          <code className="tx-shell-integration__line">
            source ~/.config/termixion/shell-integration/termixion.zsh
          </code>
          <code className="tx-shell-integration__line">
            source ~/.config/termixion/shell-integration/termixion.bash
          </code>
          <button
            type="button"
            className="tx-btn"
            onClick={() => {
              invoke("shell_integration_reveal").catch((err: unknown) =>
                console.error("[termixion] reveal shell integration failed", err),
              );
            }}
          >
            Reveal snippets
          </button>
        </div>
      </SettingsGroup>
    </div>
  );
}
