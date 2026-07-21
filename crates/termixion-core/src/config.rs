// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-80 (FR-13): the pure config backbone — the typed settings schema, a tolerant TOML
//! parse that **never panics and never hard-fails** (defaults + warnings instead), and the
//! mapping between TOML paths (`terminal.font_size`, what the user edits) and registry keys
//! (`terminal.fontSize`, what the frontend settings registry consumes — see
//! `app/src/settings/settingsStore.ts`).
//!
//! Pure by design: no filesystem, no environment, no paths — the shell owns I/O and hands
//! text in. Warnings carry the TOML path in their `key` (that is the spelling the user can
//! actually fix in the file).

use std::collections::BTreeMap;
use std::fmt;
use std::ops::RangeInclusive;

use serde::{Deserialize, Serialize};

/// How often the app checks for updates (registry key `update.checkFrequency`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CheckFrequency {
    OnStartup,
    Daily,
    Weekly,
    Manual,
}

impl CheckFrequency {
    /// The TOML/registry spelling of this value (kebab-case, e.g. `"on-startup"`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OnStartup => "on-startup",
            Self::Daily => "daily",
            Self::Weekly => "weekly",
            Self::Manual => "manual",
        }
    }

    fn from_toml(s: &str) -> Option<Self> {
        match s {
            "on-startup" => Some(Self::OnStartup),
            "daily" => Some(Self::Daily),
            "weekly" => Some(Self::Weekly),
            "manual" => Some(Self::Manual),
            _ => None,
        }
    }
}

/// The terminal cursor shape (registry key `terminal.cursorStyle`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CursorStyle {
    Bar,
    Block,
    Underline,
}

impl CursorStyle {
    /// The TOML/registry spelling of this value (lowercase, e.g. `"underline"`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bar => "bar",
            Self::Block => "block",
            Self::Underline => "underline",
        }
    }

    fn from_toml(s: &str) -> Option<Self> {
        match s {
            "bar" => Some(Self::Bar),
            "block" => Some(Self::Block),
            "underline" => Some(Self::Underline),
            _ => None,
        }
    }
}

/// When to confirm before closing a busy pane/tab or quitting (registry key
/// `terminal.confirmClose`) — trmx-144.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConfirmClose {
    Never,
    WhenBusy,
    Always,
}

impl ConfirmClose {
    /// The TOML/registry spelling of this value (kebab-case, e.g. `"when-busy"`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Never => "never",
            Self::WhenBusy => "when-busy",
            Self::Always => "always",
        }
    }

    fn from_toml(s: &str) -> Option<Self> {
        match s {
            "never" => Some(Self::Never),
            "when-busy" => Some(Self::WhenBusy),
            "always" => Some(Self::Always),
            _ => None,
        }
    }
}

/// Where the tab bar sits in the window (registry key `tabs.barPosition`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TabBarPosition {
    Top,
    Bottom,
    Left,
    Right,
}

impl TabBarPosition {
    /// The TOML/registry spelling of this value (lowercase, e.g. `"bottom"`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Top => "top",
            Self::Bottom => "bottom",
            Self::Left => "left",
            Self::Right => "right",
        }
    }

    fn from_toml(s: &str) -> Option<Self> {
        match s {
            "top" => Some(Self::Top),
            "bottom" => Some(Self::Bottom),
            "left" => Some(Self::Left),
            "right" => Some(Self::Right),
            _ => None,
        }
    }
}

/// How tab labels read when the bar sits on a side — left/right bars only
/// (registry key `tabs.sideLabelOrientation`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LabelOrientation {
    Horizontal,
    Vertical,
}

impl LabelOrientation {
    /// The TOML/registry spelling of this value (lowercase, e.g. `"vertical"`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Horizontal => "horizontal",
            Self::Vertical => "vertical",
        }
    }

    fn from_toml(s: &str) -> Option<Self> {
        match s {
            "horizontal" => Some(Self::Horizontal),
            "vertical" => Some(Self::Vertical),
            _ => None,
        }
    }
}

/// The `[update]` table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct UpdateConfig {
    pub auto_check: bool,
    pub check_frequency: CheckFrequency,
    pub auto_download: bool,
}

impl Default for UpdateConfig {
    fn default() -> Self {
        Self {
            auto_check: true,
            check_frequency: CheckFrequency::OnStartup,
            auto_download: true,
        }
    }
}

/// The `[remote_control]` table (trmx-101, FR-9.4): the opt-in external control channel. OFF by default;
/// `socket_path` empty = the XDG-default socket path (resolved in the tauri shell — the socket + its perms
/// live there, never in core; R2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct RemoteControlConfig {
    /// OFF by default (a `bool` defaults to `false`).
    pub enabled: bool,
    /// Empty string (the `String` default) = the default socket path (`~/.config/termixion/control.sock`).
    pub socket_path: String,
}

/// The `[terminal]` table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TerminalConfig {
    pub cursor_style: CursorStyle,
    pub cursor_blink: bool,
    pub scrollback_lines: u32,
    /// Empty string = the platform default font stack. trmx-204: the default is the bundled
    /// "SauceCodePro Nerd Font Mono" face; "" stays the explicit System-default sentinel.
    pub font_family: String,
    pub font_size: u32,
    /// Show an animated line while a command runs (trmx-91).
    pub activity_indicator: bool,
    /// Auto-copy the mouse selection to the clipboard, iTerm2-style (trmx-95).
    pub copy_on_select: bool,
    /// When to confirm before closing a busy pane/tab or quitting (trmx-144).
    pub confirm_close: ConfirmClose,
    /// trmx-205: the shell new sessions spawn. `""` = System default (`$SHELL` → `/bin/zsh` →
    /// `/bin/bash`); a non-empty value is an absolute path to an installed shell, validated
    /// impurely at spawn/read time by the tauri layer (the pure parser accepts any string).
    pub shell: String,
}

impl Default for TerminalConfig {
    fn default() -> Self {
        Self {
            cursor_style: CursorStyle::Underline,
            cursor_blink: false,
            scrollback_lines: 10_000,
            font_family: "SauceCodePro Nerd Font Mono".to_string(),
            font_size: 12,
            activity_indicator: true,
            copy_on_select: true,
            confirm_close: ConfirmClose::WhenBusy,
            shell: String::new(),
        }
    }
}

/// trmx-207: which prompt the zsh enhancement layer initializes. `Existing` = touch nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PromptChoice {
    Existing,
    Starship,
    Powerlevel10k,
    Pure,
}

impl PromptChoice {
    /// The TOML/registry spelling of this value (lowercase).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Existing => "existing",
            Self::Starship => "starship",
            Self::Powerlevel10k => "powerlevel10k",
            Self::Pure => "pure",
        }
    }

    fn from_toml(s: &str) -> Option<Self> {
        match s {
            "existing" => Some(Self::Existing),
            "starship" => Some(Self::Starship),
            "powerlevel10k" => Some(Self::Powerlevel10k),
            "pure" => Some(Self::Pure),
            _ => None,
        }
    }
}

/// The `[shell]` table (trmx-206): the zsh enhancement layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ShellConfig {
    /// Master kill switch: `false` ⇒ spawns are byte-identical to the un-enhanced baseline
    /// (no ZDOTDIR shim, no TERMIXION_* vars, no materialization).
    pub enhancements: bool,
    /// Layer zsh-autosuggestions (skipped if the user's own setup already loads it).
    pub autosuggestions: bool,
    /// Layer zsh-syntax-highlighting (skipped if already loaded; always sourced last).
    pub syntax_highlighting: bool,
    /// trmx-207: the prompt to initialize after the user's rc (`existing` = touch nothing).
    pub prompt: PromptChoice,
}

impl Default for ShellConfig {
    fn default() -> Self {
        Self {
            enhancements: true,
            autosuggestions: true,
            syntax_highlighting: true,
            prompt: PromptChoice::Existing,
        }
    }
}

/// The `[appearance]` table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppearanceConfig {
    /// Free string; the theme catalog is validated frontend-side.
    pub theme: String,
}

impl Default for AppearanceConfig {
    fn default() -> Self {
        Self {
            theme: "white".to_string(),
        }
    }
}

/// The `[tabs]` table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TabsConfig {
    pub bar_position: TabBarPosition,
    pub side_label_orientation: LabelOrientation,
    /// Show the ⌘1–⌘9 shortcut prefixes on tab labels (trmx-151).
    pub show_shortcut_hints: bool,
}

impl Default for TabsConfig {
    fn default() -> Self {
        Self {
            bar_position: TabBarPosition::Bottom,
            side_label_orientation: LabelOrientation::Horizontal,
            show_shortcut_hints: true,
        }
    }
}

/// The `[title_bar]` table (trmx-190).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TitleBarConfig {
    /// Show the live AI-session counters in the title bar's right slot (trmx-190).
    pub ai_counter: bool,
}

impl Default for TitleBarConfig {
    fn default() -> Self {
        Self { ai_counter: true }
    }
}

/// The `[scripts]` table (trmx-93, FR-5).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ScriptsConfig {
    /// The startup script to source in the first tab on a normal launch, as a path relative to the
    /// scripts root (e.g. `work/proj-x.sh`). Empty string (the default) = no startup script
    /// (validated tolerantly: a missing/unmatched value warns at launch and starts a plain shell,
    /// never a blocked launch).
    pub startup: String,
}

/// The fully-defaulted typed configuration model (one field per TOML table).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub update: UpdateConfig,
    pub terminal: TerminalConfig,
    /// trmx-206: the zsh enhancement layer.
    pub shell: ShellConfig,
    pub appearance: AppearanceConfig,
    pub tabs: TabsConfig,
    /// trmx-190: the title-bar chrome table (the AI-session counter gate).
    pub title_bar: TitleBarConfig,
    pub scripts: ScriptsConfig,
    /// trmx-101 (FR-9.4): the opt-in external control channel.
    pub remote_control: RemoteControlConfig,
    /// trmx-94 (FR-9.3): the `[keys]` table — an OPEN map of chord string → command id (or the
    /// literal `"none"` to unbind a default). Unlike every other table this is a DYNAMIC map, not a
    /// fixed schema, so it is read tolerantly (a non-string value warns and is skipped) and surfaced
    /// to the frontend as a map (via the tauri `keys_read` command), not as flat registry pairs.
    /// Chord-syntax and command validation live in the frontend keymap; core only stores the raw map.
    pub keys: BTreeMap<String, String>,
}

/// A value in the frontend settings registry's wire shape (untagged: `true`, `14`, `"night"`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum RegistryValue {
    Bool(bool),
    Int(u32),
    Str(String),
}

/// A non-fatal problem found while reading a config file. `key` is always the TOML path
/// (snake_case dotted, e.g. `"terminal.font_size"`) — the spelling the user edits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type")]
pub enum ConfigWarning {
    /// The file is not valid TOML at all; everything falls back to defaults.
    SyntaxError { message: String },
    /// An unrecognized table or key (forward compat: ignored, not fatal).
    UnknownKey { key: String },
    /// A known key holding a value of the wrong type or an unknown enum value;
    /// the field keeps its default.
    InvalidValue {
        key: String,
        got: String,
        expected: String,
    },
    /// A known integer key outside its allowed range; the value is clamped and used.
    OutOfRange {
        key: String,
        got: i64,
        clamped_to: u32,
    },
}

impl fmt::Display for ConfigWarning {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SyntaxError { message } => {
                write!(f, "config file is not valid TOML: {message}")
            }
            Self::UnknownKey { key } => write!(f, "unknown config key `{key}` (ignored)"),
            Self::InvalidValue { key, got, expected } => {
                write!(
                    f,
                    "invalid value for `{key}`: got {got}, expected {expected}"
                )
            }
            Self::OutOfRange {
                key,
                got,
                clamped_to,
            } => {
                write!(
                    f,
                    "`{key}` = {got} is out of range; clamped to {clamped_to}"
                )
            }
        }
    }
}

/// The fully-commented default config file: every table/key present but commented out,
/// showing its default. Parsing it yields pure defaults with zero warnings and zero pairs.
pub const DEFAULT_TEMPLATE: &str = r##"# Termixion configuration (TOML).
# Reference: docs/config.md — every key, its type, and its allowed values.
#
# Every key is optional; a missing (or commented-out) key keeps its built-in
# default. The defaults are shown below — uncomment a line to override it.

# [update]
# auto_check = true               # check for updates automatically
# check_frequency = "on-startup"  # "on-startup" | "daily" | "weekly" | "manual"
# auto_download = true            # download an available update automatically

# [terminal]
# cursor_style = "underline"      # "bar" | "block" | "underline"
# cursor_blink = false            # blink the cursor
# scrollback_lines = 10000        # 0..=200000
# font_family = "SauceCodePro Nerd Font Mono"  # a bundled font (trmx-204); "" = the platform default font stack
# shell = ""                      # "" = the system default shell ($SHELL); or an absolute path to an installed shell (trmx-205)
# font_size = 12                  # 6..=72
# activity_indicator = true       # animated line while a command runs
# copy_on_select = true           # auto-copy the mouse selection to the clipboard (iTerm2-style)
# confirm_close = "when-busy"     # confirm before closing a busy pane/tab or quitting: "never" | "when-busy" | "always"

# [shell]
# enhancements = true             # master switch for the zsh enhancement layer (trmx-206)
# autosuggestions = true          # fish-style suggestions (zsh-autosuggestions, bundled)
# syntax_highlighting = true      # command colorization (zsh-syntax-highlighting, bundled)
# prompt = "existing"             # "existing" | "starship" | "powerlevel10k" | "pure" (trmx-207)

# [appearance]
# theme = "night"                 # a theme id from the theme catalog

# [tabs]
# bar_position = "bottom"         # "top" | "bottom" | "left" | "right"
# side_label_orientation = "horizontal"   # "horizontal" | "vertical" (left/right bars only)
# show_shortcut_hints = true      # false hides the ⌘1–⌘9 tab prefixes

# [title_bar]
# ai_counter = true               # live AI-session counters in the title bar (trmx-190)

# [scripts]
# startup = ""                    # a script under ~/.config/termixion/scripts/ to run in the first
                                  # tab on launch, e.g. "work/proj-x.sh" ("" = none)

# [remote_control]                # trmx-101: the opt-in external control channel (see docs/remote-control.md).
# enabled = false                 # OFF by default — a local socket that lets scripts drive the terminal.
# socket_path = ""                # "" = ~/.config/termixion/control.sock (0600 in a 0700 dir; NO TCP, ever).

# [keys]                          # chord = "command.id" — rebind any shortcut; = "none" to unbind.
# "cmd+t" = "tab.new"             # See docs/commands.md for every command id + its default binding.
# "cmd+w" = "tab.close"
# "cmd+shift+w" = "window.close"
# "cmd+shift+t" = "tab.new-with-script"
# "cmd+shift+p" = "app.command-palette"
# "cmd+d" = "pane.split-right"
# "cmd+shift+d" = "pane.split-below"
# "cmd+shift+b" = "pane.set-badge"
# "cmd+]" = "pane.next"
# "cmd+[" = "pane.prev"
# "cmd+shift+]" = "tab.next"
# "cmd+shift+[" = "tab.prev"
# "cmd+alt+left" = "pane.focus-left"
# "cmd+1" = "tab.select-1"        # …through "cmd+9" = "tab.select-9"
# "cmd+," = "app.settings"
"##;

/// Tolerantly parse `text` into a typed [`Config`]. Never panics, never hard-fails:
/// unreadable parts fall back to their defaults and are reported as [`ConfigWarning`]s.
pub fn parse_config(text: &str) -> (Config, Vec<ConfigWarning>) {
    let (config, _, warnings) = parse_full(text);
    (config, warnings)
}

/// Tolerantly parse `text` into PRESENT-ONLY `(registry key, value)` pairs (dotted camelCase
/// keys, e.g. `"update.autoCheck"`). A key appears only if it is present AND readable in the
/// file; clamped values appear, clamped.
pub fn parse_registry_pairs(text: &str) -> (Vec<(String, RegistryValue)>, Vec<ConfigWarning>) {
    let (_, pairs, warnings) = parse_full(text);
    (pairs, warnings)
}

/// The TOML `(table, key)` for a registry key (e.g. `"terminal.fontSize"` →
/// `("terminal", "font_size")`), or `None` for an unknown registry key.
pub fn toml_path_for(registry_key: &str) -> Option<(&'static str, &'static str)> {
    match registry_key {
        "update.autoCheck" => Some(("update", "auto_check")),
        "update.checkFrequency" => Some(("update", "check_frequency")),
        "update.autoDownload" => Some(("update", "auto_download")),
        "terminal.cursorStyle" => Some(("terminal", "cursor_style")),
        "terminal.cursorBlink" => Some(("terminal", "cursor_blink")),
        "terminal.scrollbackLines" => Some(("terminal", "scrollback_lines")),
        "terminal.fontFamily" => Some(("terminal", "font_family")),
        "terminal.shell" => Some(("terminal", "shell")),
        "shell.enhancements" => Some(("shell", "enhancements")),
        "shell.autosuggestions" => Some(("shell", "autosuggestions")),
        "shell.syntaxHighlighting" => Some(("shell", "syntax_highlighting")),
        "shell.prompt" => Some(("shell", "prompt")),
        "terminal.fontSize" => Some(("terminal", "font_size")),
        "terminal.activityIndicator" => Some(("terminal", "activity_indicator")),
        "terminal.copyOnSelect" => Some(("terminal", "copy_on_select")),
        "terminal.confirmClose" => Some(("terminal", "confirm_close")),
        "appearance.theme" => Some(("appearance", "theme")),
        "tabs.barPosition" => Some(("tabs", "bar_position")),
        "tabs.sideLabelOrientation" => Some(("tabs", "side_label_orientation")),
        "tabs.showShortcutHints" => Some(("tabs", "show_shortcut_hints")),
        "titleBar.aiCounter" => Some(("title_bar", "ai_counter")),
        "scripts.startup" => Some(("scripts", "startup")),
        "remote_control.enabled" => Some(("remote_control", "enabled")),
        "remote_control.socketPath" => Some(("remote_control", "socket_path")),
        _ => None,
    }
}

/// The registry pairs that changed between `old` and `new` (new values), registry-keyed,
/// in schema order.
pub fn diff_configs(old: &Config, new: &Config) -> Vec<(String, RegistryValue)> {
    let mut changed = Vec::new();
    let mut push = |differs: bool, key: &str, value: RegistryValue| {
        if differs {
            changed.push((key.to_string(), value));
        }
    };
    push(
        old.update.auto_check != new.update.auto_check,
        "update.autoCheck",
        RegistryValue::Bool(new.update.auto_check),
    );
    push(
        old.update.check_frequency != new.update.check_frequency,
        "update.checkFrequency",
        RegistryValue::Str(new.update.check_frequency.as_str().to_string()),
    );
    push(
        old.update.auto_download != new.update.auto_download,
        "update.autoDownload",
        RegistryValue::Bool(new.update.auto_download),
    );
    push(
        old.terminal.cursor_style != new.terminal.cursor_style,
        "terminal.cursorStyle",
        RegistryValue::Str(new.terminal.cursor_style.as_str().to_string()),
    );
    push(
        old.terminal.cursor_blink != new.terminal.cursor_blink,
        "terminal.cursorBlink",
        RegistryValue::Bool(new.terminal.cursor_blink),
    );
    push(
        old.terminal.scrollback_lines != new.terminal.scrollback_lines,
        "terminal.scrollbackLines",
        RegistryValue::Int(new.terminal.scrollback_lines),
    );
    push(
        old.terminal.font_family != new.terminal.font_family,
        "terminal.fontFamily",
        RegistryValue::Str(new.terminal.font_family.clone()),
    );
    push(
        old.terminal.font_size != new.terminal.font_size,
        "terminal.fontSize",
        RegistryValue::Int(new.terminal.font_size),
    );
    push(
        old.terminal.activity_indicator != new.terminal.activity_indicator,
        "terminal.activityIndicator",
        RegistryValue::Bool(new.terminal.activity_indicator),
    );
    push(
        old.terminal.copy_on_select != new.terminal.copy_on_select,
        "terminal.copyOnSelect",
        RegistryValue::Bool(new.terminal.copy_on_select),
    );
    push(
        old.terminal.shell != new.terminal.shell,
        "terminal.shell",
        RegistryValue::Str(new.terminal.shell.clone()),
    );
    push(
        old.shell.enhancements != new.shell.enhancements,
        "shell.enhancements",
        RegistryValue::Bool(new.shell.enhancements),
    );
    push(
        old.shell.autosuggestions != new.shell.autosuggestions,
        "shell.autosuggestions",
        RegistryValue::Bool(new.shell.autosuggestions),
    );
    push(
        old.shell.syntax_highlighting != new.shell.syntax_highlighting,
        "shell.syntaxHighlighting",
        RegistryValue::Bool(new.shell.syntax_highlighting),
    );
    push(
        old.shell.prompt != new.shell.prompt,
        "shell.prompt",
        RegistryValue::Str(new.shell.prompt.as_str().to_string()),
    );
    push(
        old.terminal.confirm_close != new.terminal.confirm_close,
        "terminal.confirmClose",
        RegistryValue::Str(new.terminal.confirm_close.as_str().to_string()),
    );
    push(
        old.appearance.theme != new.appearance.theme,
        "appearance.theme",
        RegistryValue::Str(new.appearance.theme.clone()),
    );
    push(
        old.tabs.bar_position != new.tabs.bar_position,
        "tabs.barPosition",
        RegistryValue::Str(new.tabs.bar_position.as_str().to_string()),
    );
    push(
        old.tabs.side_label_orientation != new.tabs.side_label_orientation,
        "tabs.sideLabelOrientation",
        RegistryValue::Str(new.tabs.side_label_orientation.as_str().to_string()),
    );
    push(
        old.tabs.show_shortcut_hints != new.tabs.show_shortcut_hints,
        "tabs.showShortcutHints",
        RegistryValue::Bool(new.tabs.show_shortcut_hints),
    );
    push(
        old.title_bar.ai_counter != new.title_bar.ai_counter,
        "titleBar.aiCounter",
        RegistryValue::Bool(new.title_bar.ai_counter),
    );
    push(
        old.scripts.startup != new.scripts.startup,
        "scripts.startup",
        RegistryValue::Str(new.scripts.startup.clone()),
    );
    push(
        old.remote_control.enabled != new.remote_control.enabled,
        "remote_control.enabled",
        RegistryValue::Bool(new.remote_control.enabled),
    );
    push(
        old.remote_control.socket_path != new.remote_control.socket_path,
        "remote_control.socketPath",
        RegistryValue::Str(new.remote_control.socket_path.clone()),
    );
    changed
}

// ---------------------------------------------------------------------------
// The tolerant walk: parse to a toml::Table, then read each KNOWN field
// explicitly (serde's deny_unknown_fields aborts instead of warning, so the
// walk is hand-rolled). Unreadable parts warn and keep their defaults.
// ---------------------------------------------------------------------------

const SCROLLBACK_LINES_RANGE: RangeInclusive<u32> = 0..=200_000;
const FONT_SIZE_RANGE: RangeInclusive<u32> = 6..=72;

/// Collects the walk's outputs so field readers stay small.
struct Sink {
    pairs: Vec<(String, RegistryValue)>,
    warnings: Vec<ConfigWarning>,
}

fn parse_full(text: &str) -> (Config, Vec<(String, RegistryValue)>, Vec<ConfigWarning>) {
    let table = match text.parse::<toml::Table>() {
        Ok(table) => table,
        Err(error) => {
            return (
                Config::default(),
                Vec::new(),
                vec![ConfigWarning::SyntaxError {
                    message: error.message().to_string(),
                }],
            );
        }
    };

    let mut config = Config::default();
    let mut sink = Sink {
        pairs: Vec::new(),
        warnings: Vec::new(),
    };
    for (name, value) in &table {
        // trmx-94: `[keys]` is a DYNAMIC map (arbitrary chord keys), not a fixed-schema table — read
        // it separately from the hand-rolled per-key walks below.
        if name == "keys" {
            match value.as_table() {
                Some(inner) => walk_keys(inner, &mut config, &mut sink),
                None => sink.warnings.push(ConfigWarning::InvalidValue {
                    key: "keys".to_string(),
                    got: describe_value(value),
                    expected: "a table of chord = command entries".to_string(),
                }),
            }
            continue;
        }
        let walk_table: Option<fn(&toml::Table, &mut Config, &mut Sink)> = match name.as_str() {
            "update" => Some(walk_update),
            "terminal" => Some(walk_terminal),
            "shell" => Some(walk_shell),
            "appearance" => Some(walk_appearance),
            "tabs" => Some(walk_tabs),
            "title_bar" => Some(walk_title_bar),
            "scripts" => Some(walk_scripts),
            "remote_control" => Some(walk_remote_control),
            _ => None,
        };
        match walk_table {
            Some(walk_table) => match value.as_table() {
                Some(inner) => walk_table(inner, &mut config, &mut sink),
                None => sink.warnings.push(ConfigWarning::InvalidValue {
                    key: name.clone(),
                    got: describe_value(value),
                    expected: "a table of settings".to_string(),
                }),
            },
            None => sink
                .warnings
                .push(ConfigWarning::UnknownKey { key: name.clone() }),
        }
    }
    (config, sink.pairs, sink.warnings)
}

fn walk_update(table: &toml::Table, config: &mut Config, sink: &mut Sink) {
    for (key, value) in table {
        match key.as_str() {
            "auto_check" => read_bool(
                value,
                ("update.auto_check", "update.autoCheck"),
                &mut config.update.auto_check,
                sink,
            ),
            "check_frequency" => read_enum(
                value,
                ("update.check_frequency", "update.checkFrequency"),
                CheckFrequency::from_toml,
                CheckFrequency::as_str,
                r#"one of "on-startup", "daily", "weekly", "manual""#,
                &mut config.update.check_frequency,
                sink,
            ),
            "auto_download" => read_bool(
                value,
                ("update.auto_download", "update.autoDownload"),
                &mut config.update.auto_download,
                sink,
            ),
            _ => sink.warnings.push(ConfigWarning::UnknownKey {
                key: format!("update.{key}"),
            }),
        }
    }
}

// trmx-101 (FR-9.4): the `[remote_control]` table. Mirrors walk_update; the socket itself lives in the tauri shell.
fn walk_remote_control(table: &toml::Table, config: &mut Config, sink: &mut Sink) {
    for (key, value) in table {
        match key.as_str() {
            "enabled" => read_bool(
                value,
                ("remote_control.enabled", "remote_control.enabled"),
                &mut config.remote_control.enabled,
                sink,
            ),
            "socket_path" => read_string(
                value,
                ("remote_control.socket_path", "remote_control.socketPath"),
                &mut config.remote_control.socket_path,
                sink,
            ),
            _ => sink.warnings.push(ConfigWarning::UnknownKey {
                key: format!("remote_control.{key}"),
            }),
        }
    }
}

fn walk_terminal(table: &toml::Table, config: &mut Config, sink: &mut Sink) {
    for (key, value) in table {
        match key.as_str() {
            "cursor_style" => read_enum(
                value,
                ("terminal.cursor_style", "terminal.cursorStyle"),
                CursorStyle::from_toml,
                CursorStyle::as_str,
                r#"one of "bar", "block", "underline""#,
                &mut config.terminal.cursor_style,
                sink,
            ),
            "cursor_blink" => read_bool(
                value,
                ("terminal.cursor_blink", "terminal.cursorBlink"),
                &mut config.terminal.cursor_blink,
                sink,
            ),
            "scrollback_lines" => read_clamped_int(
                value,
                ("terminal.scrollback_lines", "terminal.scrollbackLines"),
                SCROLLBACK_LINES_RANGE,
                &mut config.terminal.scrollback_lines,
                sink,
            ),
            "font_family" => read_string(
                value,
                ("terminal.font_family", "terminal.fontFamily"),
                &mut config.terminal.font_family,
                sink,
            ),
            "shell" => read_string(
                value,
                ("terminal.shell", "terminal.shell"),
                &mut config.terminal.shell,
                sink,
            ),
            "font_size" => read_clamped_int(
                value,
                ("terminal.font_size", "terminal.fontSize"),
                FONT_SIZE_RANGE,
                &mut config.terminal.font_size,
                sink,
            ),
            "activity_indicator" => read_bool(
                value,
                ("terminal.activity_indicator", "terminal.activityIndicator"),
                &mut config.terminal.activity_indicator,
                sink,
            ),
            "copy_on_select" => read_bool(
                value,
                ("terminal.copy_on_select", "terminal.copyOnSelect"),
                &mut config.terminal.copy_on_select,
                sink,
            ),
            "confirm_close" => read_enum(
                value,
                ("terminal.confirm_close", "terminal.confirmClose"),
                ConfirmClose::from_toml,
                ConfirmClose::as_str,
                r#"one of "never", "when-busy", "always""#,
                &mut config.terminal.confirm_close,
                sink,
            ),
            _ => sink.warnings.push(ConfigWarning::UnknownKey {
                key: format!("terminal.{key}"),
            }),
        }
    }
}

fn walk_scripts(table: &toml::Table, config: &mut Config, sink: &mut Sink) {
    for (key, value) in table {
        match key.as_str() {
            "startup" => read_string(
                value,
                ("scripts.startup", "scripts.startup"),
                &mut config.scripts.startup,
                sink,
            ),
            _ => sink.warnings.push(ConfigWarning::UnknownKey {
                key: format!("scripts.{key}"),
            }),
        }
    }
}

/// Read the `[keys]` map (trmx-94): each entry is `chord = command-id` (or `"none"` to unbind). Any
/// chord key is allowed (validation is the frontend's job); a non-string value warns and is skipped.
/// Stored raw in `config.keys` (a BTreeMap → deterministic order); NOT surfaced as registry pairs.
fn walk_keys(table: &toml::Table, config: &mut Config, sink: &mut Sink) {
    for (chord, value) in table {
        match value.as_str() {
            Some(command) => {
                config.keys.insert(chord.clone(), command.to_string());
            }
            None => sink.warnings.push(ConfigWarning::InvalidValue {
                key: format!("keys.{chord}"),
                got: describe_value(value),
                expected: "a command id string".to_string(),
            }),
        }
    }
}

fn walk_shell(table: &toml::Table, config: &mut Config, sink: &mut Sink) {
    for (key, value) in table {
        match key.as_str() {
            "enhancements" => read_bool(
                value,
                ("shell.enhancements", "shell.enhancements"),
                &mut config.shell.enhancements,
                sink,
            ),
            "autosuggestions" => read_bool(
                value,
                ("shell.autosuggestions", "shell.autosuggestions"),
                &mut config.shell.autosuggestions,
                sink,
            ),
            "syntax_highlighting" => read_bool(
                value,
                ("shell.syntax_highlighting", "shell.syntaxHighlighting"),
                &mut config.shell.syntax_highlighting,
                sink,
            ),
            "prompt" => read_enum(
                value,
                ("shell.prompt", "shell.prompt"),
                PromptChoice::from_toml,
                PromptChoice::as_str,
                r#"one of "existing", "starship", "powerlevel10k", "pure""#,
                &mut config.shell.prompt,
                sink,
            ),
            _ => sink.warnings.push(ConfigWarning::UnknownKey {
                key: format!("shell.{key}"),
            }),
        }
    }
}

fn walk_appearance(table: &toml::Table, config: &mut Config, sink: &mut Sink) {
    for (key, value) in table {
        match key.as_str() {
            "theme" => read_string(
                value,
                ("appearance.theme", "appearance.theme"),
                &mut config.appearance.theme,
                sink,
            ),
            _ => sink.warnings.push(ConfigWarning::UnknownKey {
                key: format!("appearance.{key}"),
            }),
        }
    }
}

fn walk_tabs(table: &toml::Table, config: &mut Config, sink: &mut Sink) {
    for (key, value) in table {
        match key.as_str() {
            "bar_position" => read_enum(
                value,
                ("tabs.bar_position", "tabs.barPosition"),
                TabBarPosition::from_toml,
                TabBarPosition::as_str,
                r#"one of "top", "bottom", "left", "right""#,
                &mut config.tabs.bar_position,
                sink,
            ),
            "side_label_orientation" => read_enum(
                value,
                ("tabs.side_label_orientation", "tabs.sideLabelOrientation"),
                LabelOrientation::from_toml,
                LabelOrientation::as_str,
                r#"one of "horizontal", "vertical""#,
                &mut config.tabs.side_label_orientation,
                sink,
            ),
            // trmx-151: the ⌘1–⌘9 tab-prefix toggle (tolerant read_bool, like activity_indicator).
            "show_shortcut_hints" => read_bool(
                value,
                ("tabs.show_shortcut_hints", "tabs.showShortcutHints"),
                &mut config.tabs.show_shortcut_hints,
                sink,
            ),
            _ => sink.warnings.push(ConfigWarning::UnknownKey {
                key: format!("tabs.{key}"),
            }),
        }
    }
}

/// trmx-190: the `[title_bar]` table — the AI-session counter gate.
fn walk_title_bar(table: &toml::Table, config: &mut Config, sink: &mut Sink) {
    for (key, value) in table {
        match key.as_str() {
            "ai_counter" => read_bool(
                value,
                ("title_bar.ai_counter", "titleBar.aiCounter"),
                &mut config.title_bar.ai_counter,
                sink,
            ),
            _ => sink.warnings.push(ConfigWarning::UnknownKey {
                key: format!("title_bar.{key}"),
            }),
        }
    }
}

/// Read a boolean field; `keys` is `(toml_path, registry_key)`.
fn read_bool(value: &toml::Value, keys: (&str, &str), target: &mut bool, sink: &mut Sink) {
    match value.as_bool() {
        Some(parsed) => {
            *target = parsed;
            sink.pairs
                .push((keys.1.to_string(), RegistryValue::Bool(parsed)));
        }
        None => sink.warnings.push(ConfigWarning::InvalidValue {
            key: keys.0.to_string(),
            got: describe_value(value),
            expected: "a boolean (true or false)".to_string(),
        }),
    }
}

/// Read a free-string field; `keys` is `(toml_path, registry_key)`.
fn read_string(value: &toml::Value, keys: (&str, &str), target: &mut String, sink: &mut Sink) {
    match value.as_str() {
        Some(parsed) => {
            *target = parsed.to_string();
            sink.pairs
                .push((keys.1.to_string(), RegistryValue::Str(parsed.to_string())));
        }
        None => sink.warnings.push(ConfigWarning::InvalidValue {
            key: keys.0.to_string(),
            got: describe_value(value),
            expected: "a string".to_string(),
        }),
    }
}

/// Read an integer field, clamping into `range` (out-of-range warns but the clamped
/// value is used and surfaces in the pairs); `keys` is `(toml_path, registry_key)`.
fn read_clamped_int(
    value: &toml::Value,
    keys: (&str, &str),
    range: RangeInclusive<u32>,
    target: &mut u32,
    sink: &mut Sink,
) {
    let (min, max) = (*range.start(), *range.end());
    match value.as_integer() {
        Some(raw) => {
            let clamped_i64 = raw.clamp(i64::from(min), i64::from(max));
            // In-range by construction; the fallback can never be hit.
            let clamped = u32::try_from(clamped_i64).unwrap_or(max);
            if raw != clamped_i64 {
                sink.warnings.push(ConfigWarning::OutOfRange {
                    key: keys.0.to_string(),
                    got: raw,
                    clamped_to: clamped,
                });
            }
            *target = clamped;
            sink.pairs
                .push((keys.1.to_string(), RegistryValue::Int(clamped)));
        }
        None => sink.warnings.push(ConfigWarning::InvalidValue {
            key: keys.0.to_string(),
            got: describe_value(value),
            expected: format!("an integer in {min}..={max}"),
        }),
    }
}

/// Read an enum-valued field via its `parse`/`render` pair; `keys` is
/// `(toml_path, registry_key)` and `expected` lists the valid spellings for the warning.
fn read_enum<T: Copy>(
    value: &toml::Value,
    keys: (&str, &str),
    parse: fn(&str) -> Option<T>,
    render: fn(T) -> &'static str,
    expected: &str,
    target: &mut T,
    sink: &mut Sink,
) {
    let parsed = value.as_str().and_then(parse);
    match parsed {
        Some(parsed) => {
            *target = parsed;
            sink.pairs.push((
                keys.1.to_string(),
                RegistryValue::Str(render(parsed).to_string()),
            ));
        }
        None => sink.warnings.push(ConfigWarning::InvalidValue {
            key: keys.0.to_string(),
            got: describe_value(value),
            expected: expected.to_string(),
        }),
    }
}

/// A short human description of a TOML value for `InvalidValue::got`.
fn describe_value(value: &toml::Value) -> String {
    if let Some(text) = value.as_str() {
        format!("\"{text}\"")
    } else if let Some(flag) = value.as_bool() {
        flag.to_string()
    } else if let Some(number) = value.as_integer() {
        number.to_string()
    } else if let Some(number) = value.as_float() {
        number.to_string()
    } else if value.is_array() {
        "an array".to_string()
    } else if value.is_table() {
        "a table".to_string()
    } else {
        "a datetime".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// All 15 registry keys.
    const REGISTRY_KEYS: [&str; 20] = [
        "update.autoCheck",
        "update.checkFrequency",
        "update.autoDownload",
        "terminal.cursorStyle",
        "terminal.cursorBlink",
        "terminal.scrollbackLines",
        "terminal.fontFamily",
        "terminal.fontSize",
        "terminal.activityIndicator",
        "terminal.copyOnSelect",
        "terminal.confirmClose",
        "terminal.shell",
        "shell.enhancements",
        "shell.autosuggestions",
        "shell.syntaxHighlighting",
        "shell.prompt",
        "appearance.theme",
        "tabs.barPosition",
        "tabs.sideLabelOrientation",
        "tabs.showShortcutHints",
    ];

    fn value_for<'a>(pairs: &'a [(String, RegistryValue)], key: &str) -> Option<&'a RegistryValue> {
        pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    const FULL_NON_DEFAULT: &str = r#"
[update]
auto_check = false
check_frequency = "weekly"
auto_download = false

[terminal]
cursor_style = "block"
cursor_blink = true
scrollback_lines = 5000
font_family = "Menlo"
font_size = 14
activity_indicator = false
copy_on_select = false
confirm_close = "always"
shell = "/opt/homebrew/bin/fish"

[shell]
enhancements = false
autosuggestions = false
syntax_highlighting = false
prompt = "starship"

[appearance]
theme = "night"

[tabs]
bar_position = "top"
side_label_orientation = "vertical"
show_shortcut_hints = false
"#;

    // 1. Happy path: every key set to a non-default valid value.
    #[test]
    fn full_file_parses_to_matching_config_with_no_warnings() {
        let (config, warnings) = parse_config(FULL_NON_DEFAULT);
        assert_eq!(warnings, Vec::new(), "expected no warnings");
        assert_eq!(
            config,
            Config {
                update: UpdateConfig {
                    auto_check: false,
                    check_frequency: CheckFrequency::Weekly,
                    auto_download: false,
                },
                terminal: TerminalConfig {
                    cursor_style: CursorStyle::Block,
                    cursor_blink: true,
                    scrollback_lines: 5000,
                    font_family: "Menlo".to_string(),
                    font_size: 14,
                    activity_indicator: false,
                    copy_on_select: false,
                    confirm_close: ConfirmClose::Always,
                    shell: "/opt/homebrew/bin/fish".to_string(),
                },
                shell: ShellConfig {
                    enhancements: false,
                    autosuggestions: false,
                    syntax_highlighting: false,
                    prompt: PromptChoice::Starship,
                },
                appearance: AppearanceConfig {
                    theme: "night".to_string(),
                },
                tabs: TabsConfig {
                    bar_position: TabBarPosition::Top,
                    side_label_orientation: LabelOrientation::Vertical,
                    show_shortcut_hints: false,
                },
                title_bar: TitleBarConfig::default(),
                scripts: ScriptsConfig::default(),
                remote_control: RemoteControlConfig::default(),
                keys: BTreeMap::new(),
            }
        );
    }

    // trmx-190: [title_bar] — ai_counter, the render gate for the title-bar AI-session counters.
    // Bool default ON (tolerant read_bool, same as terminal.activity_indicator); present-only pair;
    // the template documents the table commented out; diff yields the pair (the settings:changed
    // path the frontend's aiCounterOn gate listens on).
    #[test]
    fn title_bar_ai_counter_defaults_on_and_maps_its_registry_key() {
        assert!(Config::default().title_bar.ai_counter);
        assert_eq!(
            toml_path_for("titleBar.aiCounter"),
            Some(("title_bar", "ai_counter"))
        );
        let (config, warnings) = parse_config("[title_bar]\n");
        assert!(config.title_bar.ai_counter, "defaults to true");
        assert_eq!(warnings, Vec::new());
        let (pairs, _) = parse_registry_pairs("[title_bar]\n");
        assert!(value_for(&pairs, "titleBar.aiCounter").is_none());
        assert!(
            DEFAULT_TEMPLATE.contains("# [title_bar]"),
            "the template must document the [title_bar] table"
        );
        assert!(
            DEFAULT_TEMPLATE.contains("# ai_counter = true"),
            "the template must document title_bar.ai_counter (commented out)"
        );
    }

    #[test]
    fn title_bar_ai_counter_false_surfaces_config_and_pair() {
        let text = "[title_bar]\nai_counter = false\n";
        let (config, warnings) = parse_config(text);
        assert!(!config.title_bar.ai_counter);
        assert_eq!(warnings, Vec::new());
        let (pairs, warnings) = parse_registry_pairs(text);
        assert_eq!(warnings, Vec::new());
        assert_eq!(
            pairs,
            vec![("titleBar.aiCounter".to_string(), RegistryValue::Bool(false))]
        );
    }

    #[test]
    fn title_bar_ai_counter_wrong_type_warns_and_keeps_default() {
        let text = "[title_bar]\nai_counter = \"yes\"\n";
        let (config, warnings) = parse_config(text);
        assert!(config.title_bar.ai_counter, "wrong type keeps the default");
        assert_eq!(warnings.len(), 1);
        assert!(matches!(
            &warnings[0],
            ConfigWarning::InvalidValue { key, .. } if key == "title_bar.ai_counter"
        ));
        let (pairs, _) = parse_registry_pairs(text);
        assert!(value_for(&pairs, "titleBar.aiCounter").is_none());
    }

    #[test]
    fn title_bar_ai_counter_diff_yields_the_pair() {
        let old = Config::default();
        let mut new = Config::default();
        new.title_bar.ai_counter = false;
        assert_eq!(
            diff_configs(&old, &new),
            vec![("titleBar.aiCounter".to_string(), RegistryValue::Bool(false))]
        );
    }

    // trmx-94: the [keys] dynamic map — string values stored raw; a non-string value warns + skips;
    // any chord key is allowed (validation is frontend-side); the template documents it commented.
    #[test]
    fn keys_table_reads_string_entries_and_warns_on_non_string() {
        let text = "[keys]\n\"cmd+shift+enter\" = \"pane.split-below\"\n\"cmd+d\" = \"none\"\n\"cmd+x\" = 3\n";
        let (config, warnings) = parse_config(text);
        assert_eq!(
            config.keys.get("cmd+shift+enter"),
            Some(&"pane.split-below".to_string())
        );
        assert_eq!(config.keys.get("cmd+d"), Some(&"none".to_string()));
        assert!(
            !config.keys.contains_key("cmd+x"),
            "a non-string value is skipped"
        );
        assert_eq!(warnings.len(), 1);
        assert!(matches!(
            &warnings[0],
            ConfigWarning::InvalidValue { key, .. } if key == "keys.cmd+x"
        ));
        // The [keys] map does not surface as flat registry pairs.
        let (pairs, _) = parse_registry_pairs(text);
        assert!(
            pairs.is_empty(),
            "keys entries are a map, not registry pairs"
        );
    }

    #[test]
    fn keys_table_defaults_empty_and_a_non_table_warns() {
        assert!(Config::default().keys.is_empty());
        let (config, warnings) = parse_config("keys = 5\n");
        assert!(config.keys.is_empty());
        assert_eq!(warnings.len(), 1);
        assert!(matches!(
            &warnings[0],
            ConfigWarning::InvalidValue { key, .. } if key == "keys"
        ));
        assert!(
            DEFAULT_TEMPLATE.contains("# [keys]"),
            "the template must document the [keys] table (commented)"
        );
    }

    #[test]
    fn full_file_yields_all_twelve_registry_pairs() {
        let (pairs, warnings) = parse_registry_pairs(FULL_NON_DEFAULT);
        assert_eq!(warnings, Vec::new());
        assert_eq!(pairs.len(), 20);
        for key in REGISTRY_KEYS {
            assert!(value_for(&pairs, key).is_some(), "missing pair for {key}");
        }
        assert_eq!(
            value_for(&pairs, "update.autoCheck"),
            Some(&RegistryValue::Bool(false))
        );
        assert_eq!(
            value_for(&pairs, "update.checkFrequency"),
            Some(&RegistryValue::Str("weekly".to_string()))
        );
        assert_eq!(
            value_for(&pairs, "update.autoDownload"),
            Some(&RegistryValue::Bool(false))
        );
        assert_eq!(
            value_for(&pairs, "terminal.cursorStyle"),
            Some(&RegistryValue::Str("block".to_string()))
        );
        assert_eq!(
            value_for(&pairs, "terminal.cursorBlink"),
            Some(&RegistryValue::Bool(true))
        );
        assert_eq!(
            value_for(&pairs, "terminal.scrollbackLines"),
            Some(&RegistryValue::Int(5000))
        );
        assert_eq!(
            value_for(&pairs, "terminal.fontFamily"),
            Some(&RegistryValue::Str("Menlo".to_string()))
        );
        assert_eq!(
            value_for(&pairs, "terminal.fontSize"),
            Some(&RegistryValue::Int(14))
        );
        assert_eq!(
            value_for(&pairs, "terminal.copyOnSelect"),
            Some(&RegistryValue::Bool(false))
        );
        assert_eq!(
            value_for(&pairs, "terminal.activityIndicator"),
            Some(&RegistryValue::Bool(false))
        );
        assert_eq!(
            value_for(&pairs, "terminal.confirmClose"),
            Some(&RegistryValue::Str("always".to_string()))
        );
        assert_eq!(
            value_for(&pairs, "appearance.theme"),
            Some(&RegistryValue::Str("night".to_string()))
        );
        assert_eq!(
            value_for(&pairs, "tabs.barPosition"),
            Some(&RegistryValue::Str("top".to_string()))
        );
        assert_eq!(
            value_for(&pairs, "tabs.sideLabelOrientation"),
            Some(&RegistryValue::Str("vertical".to_string()))
        );
        assert_eq!(
            value_for(&pairs, "tabs.showShortcutHints"),
            Some(&RegistryValue::Bool(false))
        );
    }

    // 2. Empty string → defaults, zero warnings, zero pairs.
    #[test]
    fn empty_string_is_all_defaults_with_no_warnings_and_no_pairs() {
        let (config, warnings) = parse_config("");
        assert_eq!(config, Config::default());
        assert_eq!(warnings, Vec::new());
        let (pairs, warnings) = parse_registry_pairs("");
        assert_eq!(pairs, Vec::new());
        assert_eq!(warnings, Vec::new());
    }

    // 3. DEFAULT_TEMPLATE is fully commented: defaults, zero warnings, ZERO pairs.
    #[test]
    fn default_template_parses_to_defaults_with_no_warnings_and_no_pairs() {
        assert!(DEFAULT_TEMPLATE.contains("docs/config.md"));
        assert!(
            DEFAULT_TEMPLATE.contains("# [tabs]"),
            "the template must document the [tabs] table (commented out)"
        );
        assert!(
            DEFAULT_TEMPLATE.contains("# side_label_orientation = \"horizontal\""),
            "the template must document tabs.side_label_orientation (commented out)"
        );
        // trmx-202: the template's example theme id must be a SURVIVING catalog id — a generated
        // config file must never recommend a removed built-in (white/paper/mint/sepia).
        assert!(
            DEFAULT_TEMPLATE.contains("# theme = \"night\""),
            "the template's theme example must be a surviving catalog id (trmx-202)"
        );
        let (config, warnings) = parse_config(DEFAULT_TEMPLATE);
        assert_eq!(config, Config::default());
        assert_eq!(warnings, Vec::new());
        let (pairs, warnings) = parse_registry_pairs(DEFAULT_TEMPLATE);
        assert_eq!(pairs, Vec::new());
        assert_eq!(warnings, Vec::new());
    }

    // 4. Syntax error → defaults + exactly one SyntaxError.
    #[test]
    fn syntax_error_yields_defaults_and_one_syntax_warning() {
        let (config, warnings) = parse_config("[update\nauto_check=");
        assert_eq!(config, Config::default());
        assert_eq!(warnings.len(), 1);
        assert!(
            matches!(&warnings[0], ConfigWarning::SyntaxError { message } if !message.is_empty()),
            "expected SyntaxError, got {warnings:?}"
        );
        let (pairs, warnings) = parse_registry_pairs("[update\nauto_check=");
        assert_eq!(pairs, Vec::new());
        assert_eq!(warnings.len(), 1);
    }

    // 5. Unknown key and unknown table → UnknownKey warnings; the rest still parses.
    #[test]
    fn unknown_key_and_table_warn_but_rest_parses() {
        let text = "[terminal]\nfont_sise = 13\ncursor_blink = true\n\n[nope]\nx = 1\n";
        let (config, warnings) = parse_config(text);
        assert!(config.terminal.cursor_blink, "known key must still apply");
        assert!(
            warnings.contains(&ConfigWarning::UnknownKey {
                key: "terminal.font_sise".to_string()
            }),
            "missing unknown-key warning: {warnings:?}"
        );
        assert!(
            warnings.contains(&ConfigWarning::UnknownKey {
                key: "nope".to_string()
            }),
            "missing unknown-table warning: {warnings:?}"
        );
        assert_eq!(warnings.len(), 2);
    }

    // 6. Wrong type per class → InvalidValue, default kept, key absent from pairs.
    #[test]
    fn bool_key_with_string_keeps_default_and_warns() {
        let text = "[terminal]\ncursor_blink = \"yes\"\n";
        let (config, warnings) = parse_config(text);
        assert!(!config.terminal.cursor_blink);
        assert_eq!(warnings.len(), 1);
        assert!(matches!(
            &warnings[0],
            ConfigWarning::InvalidValue { key, .. } if key == "terminal.cursor_blink"
        ));
        let (pairs, _) = parse_registry_pairs(text);
        assert!(value_for(&pairs, "terminal.cursorBlink").is_none());
    }

    // trmx-91: terminal.activityIndicator defaults to TRUE; explicit false parses
    // and surfaces the registry pair (tolerant read_bool, same as cursor_blink).
    #[test]
    fn activity_indicator_defaults_to_true_and_false_surfaces_pair() {
        // A [terminal] table with no activity_indicator keeps the default (true).
        let (config, warnings) = parse_config("[terminal]\n");
        assert!(
            config.terminal.activity_indicator,
            "terminal.activity_indicator defaults to true"
        );
        assert_eq!(warnings, Vec::new());
        assert!(Config::default().terminal.activity_indicator);

        // Explicit false parses to false and surfaces the registry pair.
        let text = "[terminal]\nactivity_indicator = false\n";
        let (config, warnings) = parse_config(text);
        assert!(!config.terminal.activity_indicator);
        assert_eq!(warnings, Vec::new());
        let (pairs, warnings) = parse_registry_pairs(text);
        assert_eq!(warnings, Vec::new());
        assert_eq!(
            value_for(&pairs, "terminal.activityIndicator"),
            Some(&RegistryValue::Bool(false))
        );
    }

    // trmx-95: terminal.copyOnSelect defaults to TRUE (iTerm2 parity); explicit false parses +
    // surfaces the pair; a wrong-typed value keeps the default and warns (tolerant read_bool).
    #[test]
    fn copy_on_select_defaults_true_false_surfaces_and_wrong_type_warns() {
        assert!(Config::default().terminal.copy_on_select);
        let (config, warnings) = parse_config("[terminal]\n");
        assert!(config.terminal.copy_on_select, "defaults to true");
        assert_eq!(warnings, Vec::new());

        let text = "[terminal]\ncopy_on_select = false\n";
        let (config, _) = parse_config(text);
        assert!(!config.terminal.copy_on_select);
        let (pairs, _) = parse_registry_pairs(text);
        assert_eq!(
            value_for(&pairs, "terminal.copyOnSelect"),
            Some(&RegistryValue::Bool(false))
        );

        // A non-bool value keeps the default (true) and warns; the key is absent from the pairs.
        let (config, warnings) = parse_config("[terminal]\ncopy_on_select = \"yes\"\n");
        assert!(config.terminal.copy_on_select);
        assert!(matches!(
            &warnings[0],
            ConfigWarning::InvalidValue { key, .. } if key == "terminal.copy_on_select"
        ));
    }

    // trmx-144: terminal.confirmClose — tri-state confirm-before-close ("never" | "when-busy" |
    // "always"). Defaults to WhenBusy; each valid spelling parses + surfaces the pair; an invalid
    // value keeps the default and warns with the allowed values listed (tolerant read_enum).
    #[test]
    fn confirm_close_parses_all_three_values() {
        let cases = [
            ("never", ConfirmClose::Never),
            ("when-busy", ConfirmClose::WhenBusy),
            ("always", ConfirmClose::Always),
        ];
        for (spelling, expected) in cases {
            let text = format!("[terminal]\nconfirm_close = \"{spelling}\"\n");
            let (config, warnings) = parse_config(&text);
            assert_eq!(warnings, Vec::new(), "for {spelling}");
            assert_eq!(config.terminal.confirm_close, expected, "for {spelling}");
            let (pairs, _) = parse_registry_pairs(&text);
            assert_eq!(
                value_for(&pairs, "terminal.confirmClose"),
                Some(&RegistryValue::Str(spelling.to_string())),
                "for {spelling}"
            );
        }
    }

    #[test]
    fn confirm_close_defaults_to_when_busy_when_absent() {
        assert_eq!(
            Config::default().terminal.confirm_close,
            ConfirmClose::WhenBusy
        );
        let (config, warnings) = parse_config("[terminal]\n");
        assert_eq!(config.terminal.confirm_close, ConfirmClose::WhenBusy);
        assert_eq!(warnings, Vec::new());
        let (pairs, _) = parse_registry_pairs("[terminal]\n");
        assert!(value_for(&pairs, "terminal.confirmClose").is_none());
    }

    #[test]
    fn unknown_confirm_close_warns_with_valid_values_listed() {
        let text = "[terminal]\nconfirm_close = \"sometimes\"\n";
        let (config, warnings) = parse_config(text);
        assert_eq!(config.terminal.confirm_close, ConfirmClose::WhenBusy);
        assert_eq!(warnings.len(), 1);
        match &warnings[0] {
            ConfigWarning::InvalidValue { key, got, expected } => {
                assert_eq!(key, "terminal.confirm_close");
                assert!(got.contains("sometimes"));
                for valid in ["never", "when-busy", "always"] {
                    assert!(expected.contains(valid), "expected must list {valid}");
                }
            }
            other => panic!("expected InvalidValue, got {other:?}"),
        }
        let (pairs, _) = parse_registry_pairs(text);
        assert!(value_for(&pairs, "terminal.confirmClose").is_none());
    }

    #[test]
    fn confirm_close_diffs_maps_and_template_documents_it() {
        let old = Config::default();
        assert_eq!(
            diff_configs(&old, &old),
            Vec::new(),
            "unchanged emits nothing"
        );
        let mut new = Config::default();
        new.terminal.confirm_close = ConfirmClose::Always;
        assert_eq!(
            diff_configs(&old, &new),
            vec![(
                "terminal.confirmClose".to_string(),
                RegistryValue::Str("always".to_string())
            )]
        );
        assert_eq!(
            toml_path_for("terminal.confirmClose"),
            Some(("terminal", "confirm_close"))
        );
        assert!(
            DEFAULT_TEMPLATE.contains("# confirm_close = \"when-busy\""),
            "the template must document terminal.confirm_close (commented out)"
        );
    }

    // trmx-93: scripts.startup is a free string (""=unset). Present-only pair; wrong-type keeps the
    // default and warns (absent from pairs); an unknown scripts.* key warns; diff yields the pair.
    #[test]
    fn scripts_startup_present_only_pair_and_default() {
        assert_eq!(Config::default().scripts.startup, "");
        let text = "[scripts]\nstartup = \"work/proj-x.sh\"\n";
        let (config, warnings) = parse_config(text);
        assert_eq!(config.scripts.startup, "work/proj-x.sh");
        assert_eq!(warnings, Vec::new());
        let (pairs, warnings) = parse_registry_pairs(text);
        assert_eq!(warnings, Vec::new());
        assert_eq!(
            pairs,
            vec![(
                "scripts.startup".to_string(),
                RegistryValue::Str("work/proj-x.sh".to_string())
            )]
        );
    }

    #[test]
    fn scripts_startup_wrong_type_keeps_default_and_warns() {
        let text = "[scripts]\nstartup = 3\n";
        let (config, warnings) = parse_config(text);
        assert_eq!(config.scripts.startup, "");
        assert_eq!(warnings.len(), 1);
        assert!(matches!(
            &warnings[0],
            ConfigWarning::InvalidValue { key, .. } if key == "scripts.startup"
        ));
        let (pairs, _) = parse_registry_pairs(text);
        assert!(value_for(&pairs, "scripts.startup").is_none());
    }

    #[test]
    fn scripts_unknown_key_warns() {
        let (_, warnings) = parse_config("[scripts]\nfoo = 1\n");
        assert!(warnings.contains(&ConfigWarning::UnknownKey {
            key: "scripts.foo".to_string()
        }));
    }

    #[test]
    fn scripts_startup_diff_yields_the_pair_and_template_documents_it() {
        let old = Config::default();
        let mut new = Config::default();
        new.scripts.startup = "work/proj-x.sh".to_string();
        assert_eq!(
            diff_configs(&old, &new),
            vec![(
                "scripts.startup".to_string(),
                RegistryValue::Str("work/proj-x.sh".to_string())
            )]
        );
        assert!(
            DEFAULT_TEMPLATE.contains("# [scripts]"),
            "template must document the [scripts] table (commented)"
        );
        assert_eq!(
            toml_path_for("scripts.startup"),
            Some(("scripts", "startup"))
        );
    }

    // trmx-101 (FR-9.4): the [remote_control] table — OFF by default, round-trips, diffs, documented.
    #[test]
    fn remote_control_defaults_off_and_round_trips() {
        assert!(!Config::default().remote_control.enabled);
        assert_eq!(Config::default().remote_control.socket_path, "");
        let (config, warnings) =
            parse_config("[remote_control]\nenabled = true\nsocket_path = \"/tmp/tmx.sock\"\n");
        assert!(config.remote_control.enabled);
        assert_eq!(config.remote_control.socket_path, "/tmp/tmx.sock");
        assert!(warnings.is_empty());
    }

    #[test]
    fn remote_control_diffs_and_maps_and_template_documents_it() {
        let old = Config::default();
        let mut new = Config::default();
        new.remote_control.enabled = true;
        assert_eq!(
            diff_configs(&old, &new),
            vec![(
                "remote_control.enabled".to_string(),
                RegistryValue::Bool(true)
            )]
        );
        assert_eq!(
            toml_path_for("remote_control.enabled"),
            Some(("remote_control", "enabled"))
        );
        assert_eq!(
            toml_path_for("remote_control.socketPath"),
            Some(("remote_control", "socket_path"))
        );
        assert!(DEFAULT_TEMPLATE.contains("# [remote_control]"));
    }

    #[test]
    fn remote_control_wrong_type_keeps_default_and_warns() {
        let (config, warnings) = parse_config("[remote_control]\nenabled = \"yes\"\n");
        assert!(!config.remote_control.enabled); // default kept
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn int_key_with_bool_keeps_default_and_warns() {
        let text = "[terminal]\nfont_size = true\n";
        let (config, warnings) = parse_config(text);
        assert_eq!(config.terminal.font_size, 12);
        assert_eq!(warnings.len(), 1);
        assert!(matches!(
            &warnings[0],
            ConfigWarning::InvalidValue { key, .. } if key == "terminal.font_size"
        ));
        let (pairs, _) = parse_registry_pairs(text);
        assert!(value_for(&pairs, "terminal.fontSize").is_none());
    }

    #[test]
    fn string_key_with_int_keeps_default_and_warns() {
        let text = "[appearance]\ntheme = 3\n";
        let (config, warnings) = parse_config(text);
        assert_eq!(config.appearance.theme, "white");
        assert_eq!(warnings.len(), 1);
        assert!(matches!(
            &warnings[0],
            ConfigWarning::InvalidValue { key, .. } if key == "appearance.theme"
        ));
        let (pairs, _) = parse_registry_pairs(text);
        assert!(value_for(&pairs, "appearance.theme").is_none());
    }

    // 7. Unknown enum values → InvalidValue with `expected` listing the valid values.
    #[test]
    fn unknown_cursor_style_warns_with_valid_values_listed() {
        let (config, warnings) = parse_config("[terminal]\ncursor_style = \"wide\"\n");
        assert_eq!(config.terminal.cursor_style, CursorStyle::Underline);
        assert_eq!(warnings.len(), 1);
        match &warnings[0] {
            ConfigWarning::InvalidValue { key, got, expected } => {
                assert_eq!(key, "terminal.cursor_style");
                assert!(got.contains("wide"));
                for valid in ["bar", "block", "underline"] {
                    assert!(expected.contains(valid), "expected must list {valid}");
                }
            }
            other => panic!("expected InvalidValue, got {other:?}"),
        }
    }

    #[test]
    fn tab_bar_position_parses_all_four_values() {
        let cases = [
            ("top", TabBarPosition::Top),
            ("bottom", TabBarPosition::Bottom),
            ("left", TabBarPosition::Left),
            ("right", TabBarPosition::Right),
        ];
        for (spelling, expected) in cases {
            let text = format!("[tabs]\nbar_position = \"{spelling}\"\n");
            let (config, warnings) = parse_config(&text);
            assert_eq!(warnings, Vec::new(), "for {spelling}");
            assert_eq!(config.tabs.bar_position, expected, "for {spelling}");
            let (pairs, _) = parse_registry_pairs(&text);
            assert_eq!(
                value_for(&pairs, "tabs.barPosition"),
                Some(&RegistryValue::Str(spelling.to_string())),
                "for {spelling}"
            );
        }
    }

    #[test]
    fn unknown_tab_bar_position_warns_with_valid_values_listed() {
        let text = "[tabs]\nbar_position = \"middle\"\n";
        let (config, warnings) = parse_config(text);
        assert_eq!(config.tabs.bar_position, TabBarPosition::Bottom);
        assert_eq!(warnings.len(), 1);
        match &warnings[0] {
            ConfigWarning::InvalidValue { key, got, expected } => {
                assert_eq!(key, "tabs.bar_position");
                assert!(got.contains("middle"));
                for valid in ["top", "bottom", "left", "right"] {
                    assert!(expected.contains(valid), "expected must list {valid}");
                }
            }
            other => panic!("expected InvalidValue, got {other:?}"),
        }
        let (pairs, _) = parse_registry_pairs(text);
        assert!(value_for(&pairs, "tabs.barPosition").is_none());
    }

    #[test]
    fn label_orientation_parses_both_values() {
        let cases = [
            ("horizontal", LabelOrientation::Horizontal),
            ("vertical", LabelOrientation::Vertical),
        ];
        for (spelling, expected) in cases {
            let text = format!("[tabs]\nside_label_orientation = \"{spelling}\"\n");
            let (config, warnings) = parse_config(&text);
            assert_eq!(warnings, Vec::new(), "for {spelling}");
            assert_eq!(
                config.tabs.side_label_orientation, expected,
                "for {spelling}"
            );
            let (pairs, _) = parse_registry_pairs(&text);
            assert_eq!(
                value_for(&pairs, "tabs.sideLabelOrientation"),
                Some(&RegistryValue::Str(spelling.to_string())),
                "for {spelling}"
            );
        }
    }

    // trmx-151: tabs.showShortcutHints defaults to TRUE (the ⌘1–⌘9 tab prefixes show); explicit
    // false parses + surfaces the pair; a wrong-typed value keeps the default and warns
    // (tolerant read_bool, same as terminal.activity_indicator).
    #[test]
    fn show_shortcut_hints_defaults_true_false_surfaces_and_wrong_type_warns() {
        assert!(Config::default().tabs.show_shortcut_hints);
        let (config, warnings) = parse_config("[tabs]\n");
        assert!(config.tabs.show_shortcut_hints, "defaults to true");
        assert_eq!(warnings, Vec::new());

        let text = "[tabs]\nshow_shortcut_hints = false\n";
        let (config, warnings) = parse_config(text);
        assert!(!config.tabs.show_shortcut_hints);
        assert_eq!(warnings, Vec::new());
        let (pairs, warnings) = parse_registry_pairs(text);
        assert_eq!(warnings, Vec::new());
        assert_eq!(
            pairs,
            vec![(
                "tabs.showShortcutHints".to_string(),
                RegistryValue::Bool(false)
            )]
        );

        // A non-bool value keeps the default (true) and warns; the key is absent from the pairs.
        let (config, warnings) = parse_config("[tabs]\nshow_shortcut_hints = \"yes\"\n");
        assert!(config.tabs.show_shortcut_hints);
        assert_eq!(warnings.len(), 1);
        assert!(matches!(
            &warnings[0],
            ConfigWarning::InvalidValue { key, .. } if key == "tabs.show_shortcut_hints"
        ));
        let (pairs, _) = parse_registry_pairs("[tabs]\nshow_shortcut_hints = \"yes\"\n");
        assert!(value_for(&pairs, "tabs.showShortcutHints").is_none());
    }

    #[test]
    fn unknown_label_orientation_warns_with_valid_values_listed() {
        let text = "[tabs]\nside_label_orientation = \"diagonal\"\n";
        let (config, warnings) = parse_config(text);
        assert_eq!(
            config.tabs.side_label_orientation,
            LabelOrientation::Horizontal
        );
        assert_eq!(warnings.len(), 1);
        match &warnings[0] {
            ConfigWarning::InvalidValue { key, got, expected } => {
                assert_eq!(key, "tabs.side_label_orientation");
                assert!(got.contains("diagonal"));
                for valid in ["horizontal", "vertical"] {
                    assert!(expected.contains(valid), "expected must list {valid}");
                }
            }
            other => panic!("expected InvalidValue, got {other:?}"),
        }
        let (pairs, _) = parse_registry_pairs(text);
        assert!(value_for(&pairs, "tabs.sideLabelOrientation").is_none());
    }

    #[test]
    fn unknown_check_frequency_warns_with_valid_values_listed() {
        let (config, warnings) = parse_config("[update]\ncheck_frequency = \"hourly\"\n");
        assert_eq!(config.update.check_frequency, CheckFrequency::OnStartup);
        assert_eq!(warnings.len(), 1);
        match &warnings[0] {
            ConfigWarning::InvalidValue { key, got, expected } => {
                assert_eq!(key, "update.check_frequency");
                assert!(got.contains("hourly"));
                for valid in ["on-startup", "daily", "weekly", "manual"] {
                    assert!(expected.contains(valid), "expected must list {valid}");
                }
            }
            other => panic!("expected InvalidValue, got {other:?}"),
        }
    }

    // 8. Clamps at both bounds; clamped values ARE present in registry pairs.
    #[test]
    fn scrollback_lines_clamps_at_both_bounds() {
        let (config, warnings) = parse_config("[terminal]\nscrollback_lines = -5\n");
        assert_eq!(config.terminal.scrollback_lines, 0);
        assert_eq!(
            warnings,
            vec![ConfigWarning::OutOfRange {
                key: "terminal.scrollback_lines".to_string(),
                got: -5,
                clamped_to: 0,
            }]
        );
        let (pairs, _) = parse_registry_pairs("[terminal]\nscrollback_lines = -5\n");
        assert_eq!(
            value_for(&pairs, "terminal.scrollbackLines"),
            Some(&RegistryValue::Int(0))
        );

        let (config, warnings) = parse_config("[terminal]\nscrollback_lines = 999999\n");
        assert_eq!(config.terminal.scrollback_lines, 200_000);
        assert_eq!(
            warnings,
            vec![ConfigWarning::OutOfRange {
                key: "terminal.scrollback_lines".to_string(),
                got: 999_999,
                clamped_to: 200_000,
            }]
        );
        let (pairs, _) = parse_registry_pairs("[terminal]\nscrollback_lines = 999999\n");
        assert_eq!(
            value_for(&pairs, "terminal.scrollbackLines"),
            Some(&RegistryValue::Int(200_000))
        );
    }

    #[test]
    fn shell_table_defaults_on_and_round_trips_toggles() {
        let d = ShellConfig::default();
        assert!(d.enhancements && d.autosuggestions && d.syntax_highlighting);
        let (config, warnings) =
            parse_config("[shell]\nenhancements = false\nsyntax_highlighting = false\n");
        assert!(!config.shell.enhancements);
        assert!(config.shell.autosuggestions);
        assert!(!config.shell.syntax_highlighting);
        assert_eq!(warnings, Vec::new());
        let (config, warnings) = parse_config("[shell]\nenhancements = 3\n");
        assert!(config.shell.enhancements);
        assert_eq!(warnings.len(), 1);
        let (pairs, _) = parse_registry_pairs("[shell]\nautosuggestions = false\n");
        assert_eq!(
            value_for(&pairs, "shell.autosuggestions"),
            Some(&RegistryValue::Bool(false))
        );
    }

    #[test]
    fn shell_table_reports_unknown_keys_like_every_fixed_schema_table() {
        let (_, warnings) = parse_config("[shell]\ntypo_key = true\n");
        assert_eq!(
            warnings,
            vec![ConfigWarning::UnknownKey {
                key: "shell.typo_key".to_string()
            }]
        );
    }

    #[test]
    fn shell_prompt_parses_tolerantly_and_round_trips() {
        // trmx-207: default existing; junk warns + keeps existing; valid values round-trip.
        assert_eq!(ShellConfig::default().prompt, PromptChoice::Existing);
        let (config, warnings) = parse_config("[shell]\nprompt = \"pure\"\n");
        assert_eq!(config.shell.prompt, PromptChoice::Pure);
        assert_eq!(warnings, Vec::new());
        let (config, warnings) = parse_config("[shell]\nprompt = \"ohmyposh\"\n");
        assert_eq!(config.shell.prompt, PromptChoice::Existing);
        assert_eq!(warnings.len(), 1);
        let (pairs, _) = parse_registry_pairs("[shell]\nprompt = \"starship\"\n");
        assert_eq!(
            value_for(&pairs, "shell.prompt"),
            Some(&RegistryValue::Str("starship".to_string()))
        );
    }

    #[test]
    fn shell_table_changes_surface_in_the_watcher_diff() {
        let old = Config::default();
        let mut new = Config::default();
        new.shell.enhancements = false;
        let changed = diff_configs(&old, &new);
        assert_eq!(
            changed,
            vec![("shell.enhancements".to_string(), RegistryValue::Bool(false))]
        );
    }

    #[test]
    fn shell_defaults_empty_and_round_trips_a_configured_path() {
        // trmx-205: "" = System default; a persisted absolute path parses verbatim and emits the
        // registry pair; junk types warn + keep the default (tolerant-parser contract).
        assert_eq!(TerminalConfig::default().shell, "");
        let (config, warnings) = parse_config("[terminal]\nshell = \"/opt/homebrew/bin/bash\"\n");
        assert_eq!(config.terminal.shell, "/opt/homebrew/bin/bash");
        assert_eq!(warnings, Vec::new());
        let (pairs, _) = parse_registry_pairs("[terminal]\nshell = \"/bin/zsh\"\n");
        assert_eq!(
            value_for(&pairs, "terminal.shell"),
            Some(&RegistryValue::Str("/bin/zsh".to_string()))
        );
        let (config, warnings) = parse_config("[terminal]\nshell = 3\n");
        assert_eq!(config.terminal.shell, "");
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn shell_changes_surface_in_the_watcher_diff() {
        let old = Config::default();
        let mut new = Config::default();
        new.terminal.shell = "/opt/homebrew/bin/fish".to_string();
        let changed = diff_configs(&old, &new);
        assert_eq!(
            changed,
            vec![(
                "terminal.shell".to_string(),
                RegistryValue::Str("/opt/homebrew/bin/fish".to_string())
            )]
        );
    }

    #[test]
    fn font_family_defaults_to_the_bundled_sauce_code_pro_face() {
        // trmx-204: an ABSENT key gets the bundled default; the dropdown's System-default entry
        // persists an explicit "" which must survive parsing untouched (no default substitution).
        assert_eq!(
            TerminalConfig::default().font_family,
            "SauceCodePro Nerd Font Mono"
        );
        let (config, warnings) = parse_config("");
        assert_eq!(config.terminal.font_family, "SauceCodePro Nerd Font Mono");
        assert_eq!(warnings, Vec::new());
    }

    #[test]
    fn font_family_explicit_empty_stays_empty_after_the_trmx_204_default_flip() {
        let (config, warnings) = parse_config("[terminal]\nfont_family = \"\"\n");
        assert_eq!(config.terminal.font_family, "");
        assert_eq!(warnings, Vec::new());
        let (pairs, _) = parse_registry_pairs("[terminal]\nfont_family = \"\"\n");
        assert_eq!(
            value_for(&pairs, "terminal.fontFamily"),
            Some(&RegistryValue::Str(String::new()))
        );
    }

    #[test]
    fn font_size_clamps_at_both_bounds() {
        let (config, warnings) = parse_config("[terminal]\nfont_size = 2\n");
        assert_eq!(config.terminal.font_size, 6);
        assert_eq!(
            warnings,
            vec![ConfigWarning::OutOfRange {
                key: "terminal.font_size".to_string(),
                got: 2,
                clamped_to: 6,
            }]
        );
        let (pairs, _) = parse_registry_pairs("[terminal]\nfont_size = 2\n");
        assert_eq!(
            value_for(&pairs, "terminal.fontSize"),
            Some(&RegistryValue::Int(6))
        );

        let (config, warnings) = parse_config("[terminal]\nfont_size = 100\n");
        assert_eq!(config.terminal.font_size, 72);
        assert_eq!(
            warnings,
            vec![ConfigWarning::OutOfRange {
                key: "terminal.font_size".to_string(),
                got: 100,
                clamped_to: 72,
            }]
        );
        let (pairs, _) = parse_registry_pairs("[terminal]\nfont_size = 100\n");
        assert_eq!(
            value_for(&pairs, "terminal.fontSize"),
            Some(&RegistryValue::Int(72))
        );
    }

    // 9. Present-only semantics: only keys present in the file yield pairs.
    #[test]
    fn present_only_pairs_for_a_single_key_file() {
        let (pairs, warnings) = parse_registry_pairs("[terminal]\nfont_size = 14\n");
        assert_eq!(warnings, Vec::new());
        assert_eq!(
            pairs,
            vec![("terminal.fontSize".to_string(), RegistryValue::Int(14))]
        );
    }

    #[test]
    fn present_only_pair_for_a_single_tabs_key_file() {
        let (pairs, warnings) = parse_registry_pairs("[tabs]\nbar_position = \"left\"\n");
        assert_eq!(warnings, Vec::new());
        assert_eq!(
            pairs,
            vec![(
                "tabs.barPosition".to_string(),
                RegistryValue::Str("left".to_string())
            )]
        );
    }

    #[test]
    fn present_only_pair_for_a_single_side_label_orientation_key_file() {
        let (pairs, warnings) =
            parse_registry_pairs("[tabs]\nside_label_orientation = \"vertical\"\n");
        assert_eq!(warnings, Vec::new());
        assert_eq!(
            pairs,
            vec![(
                "tabs.sideLabelOrientation".to_string(),
                RegistryValue::Str("vertical".to_string())
            )]
        );
    }

    // 10. toml_path_for maps all 11 registry keys and rejects junk.
    #[test]
    fn toml_path_for_maps_every_registry_key() {
        let expected: [(&str, (&str, &str)); 15] = [
            ("update.autoCheck", ("update", "auto_check")),
            ("update.checkFrequency", ("update", "check_frequency")),
            ("update.autoDownload", ("update", "auto_download")),
            ("terminal.cursorStyle", ("terminal", "cursor_style")),
            ("terminal.cursorBlink", ("terminal", "cursor_blink")),
            ("terminal.scrollbackLines", ("terminal", "scrollback_lines")),
            ("terminal.fontFamily", ("terminal", "font_family")),
            ("terminal.fontSize", ("terminal", "font_size")),
            (
                "terminal.activityIndicator",
                ("terminal", "activity_indicator"),
            ),
            ("terminal.copyOnSelect", ("terminal", "copy_on_select")),
            ("terminal.confirmClose", ("terminal", "confirm_close")),
            ("appearance.theme", ("appearance", "theme")),
            ("tabs.barPosition", ("tabs", "bar_position")),
            (
                "tabs.sideLabelOrientation",
                ("tabs", "side_label_orientation"),
            ),
            ("tabs.showShortcutHints", ("tabs", "show_shortcut_hints")),
        ];
        for (registry_key, path) in expected {
            assert_eq!(
                toml_path_for(registry_key),
                Some(path),
                "for {registry_key}"
            );
        }
        assert_eq!(toml_path_for("junk"), None);
        assert_eq!(toml_path_for("terminal.font_size"), None);
        assert_eq!(toml_path_for(""), None);
    }

    #[test]
    fn toml_path_for_round_trips_through_the_parser() {
        // A minimal file written at toml_path_for's answer must surface exactly
        // that registry key in the pairs.
        let samples: [(&str, &str); 15] = [
            ("update.autoCheck", "false"),
            ("update.checkFrequency", "\"manual\""),
            ("update.autoDownload", "false"),
            ("terminal.cursorStyle", "\"bar\""),
            ("terminal.cursorBlink", "true"),
            ("terminal.scrollbackLines", "42"),
            ("terminal.fontFamily", "\"Menlo\""),
            ("terminal.fontSize", "20"),
            ("terminal.activityIndicator", "false"),
            ("terminal.copyOnSelect", "false"),
            ("terminal.confirmClose", "\"never\""),
            ("appearance.theme", "\"night\""),
            ("tabs.barPosition", "\"right\""),
            ("tabs.sideLabelOrientation", "\"vertical\""),
            ("tabs.showShortcutHints", "false"),
        ];
        for (registry_key, literal) in samples {
            let Some((table, key)) = toml_path_for(registry_key) else {
                panic!("no toml path for {registry_key}");
            };
            let text = format!("[{table}]\n{key} = {literal}\n");
            let (pairs, warnings) = parse_registry_pairs(&text);
            assert_eq!(warnings, Vec::new(), "for {registry_key}");
            assert_eq!(pairs.len(), 1, "for {registry_key}");
            assert_eq!(pairs[0].0, registry_key);
        }
    }

    // 11. diff_configs: identical → empty; changes → exactly the changed registry pairs.
    #[test]
    fn diff_identical_configs_is_empty() {
        let config = Config::default();
        assert_eq!(diff_configs(&config, &config), Vec::new());
    }

    #[test]
    fn diff_single_key_change_yields_that_pair() {
        let old = Config::default();
        let mut new = Config::default();
        new.terminal.font_size = 14;
        assert_eq!(
            diff_configs(&old, &new),
            vec![("terminal.fontSize".to_string(), RegistryValue::Int(14))]
        );
    }

    #[test]
    fn diff_bar_position_change_yields_that_pair() {
        let old = Config::default();
        let mut new = Config::default();
        new.tabs.bar_position = TabBarPosition::Top;
        assert_eq!(
            diff_configs(&old, &new),
            vec![(
                "tabs.barPosition".to_string(),
                RegistryValue::Str("top".to_string())
            )]
        );
    }

    #[test]
    fn diff_side_label_orientation_change_yields_that_pair() {
        let old = Config::default();
        let mut new = Config::default();
        new.tabs.side_label_orientation = LabelOrientation::Vertical;
        assert_eq!(
            diff_configs(&old, &new),
            vec![(
                "tabs.sideLabelOrientation".to_string(),
                RegistryValue::Str("vertical".to_string())
            )]
        );
    }

    // trmx-151: the diff pin — without the diff_configs arm a hand-edited TOML parses but never
    // live-applies (the watcher's settings:changed ride diff_configs, not the parse pairs).
    #[test]
    fn diff_show_shortcut_hints_change_yields_that_pair() {
        let old = Config::default();
        let mut new = Config::default();
        new.tabs.show_shortcut_hints = false;
        assert_eq!(
            diff_configs(&old, &new),
            vec![(
                "tabs.showShortcutHints".to_string(),
                RegistryValue::Bool(false)
            )]
        );
        assert_eq!(
            toml_path_for("tabs.showShortcutHints"),
            Some(("tabs", "show_shortcut_hints"))
        );
        assert!(
            DEFAULT_TEMPLATE.contains("# show_shortcut_hints = true"),
            "the template must document tabs.show_shortcut_hints (commented out)"
        );
    }

    #[test]
    fn diff_multi_key_change_yields_all_changed_pairs() {
        let old = Config::default();
        let mut new = Config::default();
        new.update.auto_check = false;
        new.update.check_frequency = CheckFrequency::Daily;
        new.appearance.theme = "night".to_string();
        let diff = diff_configs(&old, &new);
        assert_eq!(diff.len(), 3);
        assert_eq!(
            value_for(&diff, "update.autoCheck"),
            Some(&RegistryValue::Bool(false))
        );
        assert_eq!(
            value_for(&diff, "update.checkFrequency"),
            Some(&RegistryValue::Str("daily".to_string()))
        );
        assert_eq!(
            value_for(&diff, "appearance.theme"),
            Some(&RegistryValue::Str("night".to_string()))
        );
    }

    // 12. Junk bytes → defaults + SyntaxError, no panic.
    #[test]
    fn junk_bytes_yield_defaults_and_a_syntax_warning() {
        let junk = "\u{0}\u{1}garbage";
        let (config, warnings) = parse_config(junk);
        assert_eq!(config, Config::default());
        assert_eq!(warnings.len(), 1);
        assert!(matches!(&warnings[0], ConfigWarning::SyntaxError { .. }));
        let (pairs, warnings) = parse_registry_pairs(junk);
        assert_eq!(pairs, Vec::new());
        assert_eq!(warnings.len(), 1);
    }

    // Warnings are human-readable (Display) and carry the TOML path.
    #[test]
    fn warnings_display_readably() {
        let warning = ConfigWarning::UnknownKey {
            key: "terminal.font_sise".to_string(),
        };
        assert!(warning.to_string().contains("terminal.font_sise"));
        let warning = ConfigWarning::InvalidValue {
            key: "terminal.cursor_blink".to_string(),
            got: "\"yes\"".to_string(),
            expected: "a boolean (true or false)".to_string(),
        };
        let text = warning.to_string();
        assert!(text.contains("terminal.cursor_blink"));
        assert!(text.contains("yes"));
        let warning = ConfigWarning::OutOfRange {
            key: "terminal.font_size".to_string(),
            got: 100,
            clamped_to: 72,
        };
        let text = warning.to_string();
        assert!(text.contains("100"));
        assert!(text.contains("72"));
        let warning = ConfigWarning::SyntaxError {
            message: "unexpected end of input".to_string(),
        };
        assert!(warning.to_string().contains("unexpected end of input"));
    }
}
