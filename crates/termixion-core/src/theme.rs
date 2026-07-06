// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-89 (FR-6): the pure theme-file parse — a tolerant TOML reader for user theme files that
//! **never panics and never hard-fails**. It mirrors [`crate::config`]: parse to a `toml::Table`,
//! then hand-walk each KNOWN table/key, collecting [`ThemeWarning`]s (warn-not-abort) instead of
//! rejecting the whole file on the first problem.
//!
//! Split of responsibility (FR-6): the **core** (here) parses theme *strings* into a validated
//! [`ThemeSpec`] — no filesystem, no paths, no platform (the shell owns I/O and hands text in). The
//! **tauri** shell reads the theme file off disk. The **frontend** (`app/src/theme/themeDerive.ts`)
//! fills the optional/derived fields a user omits, so this parser only enforces the REQUIRED set and
//! passes optionals through when present-and-valid.
//!
//! A theme is "valid" (`Some(spec)`) only when every required field — `is_dark`,
//! `color.bg.primary`, `color.text.primary`, and all 16 `terminal.ansi.*` — is present and a
//! well-formed color. A missing or malformed required field makes the whole theme invalid (`None`);
//! a malformed OPTIONAL color is dropped with a warning and the rest of the theme still parses.
//!
//! The user writes snake_case TOML keys (`is_dark`, `bright_black`, `active_border`); the serialized
//! [`ThemeSpec`] is camelCase (via serde) so it matches the `ThemeTokens` shape in
//! `app/src/theme/tokens.ts` that the frontend consumes.

use std::collections::HashSet;
use std::fmt;

use serde::Serialize;

/// A parsed, validated user theme. Serializes to the camelCase `ThemeTokens` wire shape consumed by
/// `app/src/theme/tokens.ts`. Required fields are always present; optionals are omitted when absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeSpec {
    /// Whether this theme is dark — the single source of dark/light classification.
    pub is_dark: bool,
    pub color: ColorSpec,
    pub terminal: TerminalSpec,
}

/// The `[color]` slice: UI color tiers plus the required text/background primaries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ColorSpec {
    pub bg: BgSpec,
    pub text: TextSpec,
    pub accent: AccentSpec,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub border: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<String>,
    pub semantic: SemanticSpec,
}

/// `[color.bg]`: `primary` (window/content background) is required; the elevated tiers are optional.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BgSpec {
    pub primary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secondary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tertiary: Option<String>,
}

/// `[color.text]`: `primary` is required; the muted tiers are optional.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TextSpec {
    pub primary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secondary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tertiary: Option<String>,
}

/// `[color.accent]`: the accent color and its translucent background wash (both optional/derivable).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AccentSpec {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bg: Option<String>,
}

/// `[color.semantic]`: error/success tints (all optional; the frontend fills sensible defaults).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticSpec {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_bg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub success: Option<String>,
}

/// The `[terminal]` slice: the required 16-color ANSI palette plus optional cursor/selection/badge
/// tints.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSpec {
    pub ansi: AnsiSpec,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_accent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_background: Option<String>,
    /// The translucent per-pane badge/watermark color (iTerm2-style overlay). A single-word key, so
    /// the TOML `badge` and JSON `badge` spellings match with no serde rename.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub badge: Option<String>,
    pub scrollbar: ScrollbarSpec,
    pub pane: PaneSpec,
    pub search: SearchSpec,
}

/// `[terminal.ansi]`: the 16-color ANSI palette. Every color is REQUIRED — the xterm terminal has no
/// sensible fallback for a missing ANSI slot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnsiSpec {
    pub black: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub blue: String,
    pub magenta: String,
    pub cyan: String,
    pub white: String,
    pub bright_black: String,
    pub bright_red: String,
    pub bright_green: String,
    pub bright_yellow: String,
    pub bright_blue: String,
    pub bright_magenta: String,
    pub bright_cyan: String,
    pub bright_white: String,
}

/// `[terminal.scrollbar]`: the Kitty-style scrollbar overlay triple (all optional/derivable).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScrollbarSpec {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hover: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<String>,
}

/// `[terminal.pane]`: the multi-pane border colors (both optional/derivable).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneSpec {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_border: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inactive_border: Option<String>,
}

/// `[terminal.search]`: the find-bar highlight colors (both optional/derivable). trmx-98 (FR-1.5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSpec {
    // `match` is a Rust keyword — the raw identifier serializes as camelCase "match" for the frontend.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#match: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_match: Option<String>,
}

/// A non-fatal problem found while reading a theme file. `key` is always the TOML path (snake_case
/// dotted, e.g. `"color.bg.primary"`) — the spelling the user edits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type")]
pub enum ThemeWarning {
    /// The file is not valid TOML at all; there is no theme to build.
    SyntaxError { message: String },
    /// A required field is absent; the theme is invalid.
    MissingRequired { key: String },
    /// A color field holds a malformed value. A required color counts as missing (the theme is
    /// invalid); an optional color is dropped and the rest of the theme still parses.
    InvalidColor { key: String, got: String },
    /// A known key holding a value of the wrong type (e.g. `is_dark` that is not a boolean, or a
    /// table-typed key that is not a table).
    InvalidValue {
        key: String,
        got: String,
        expected: String,
    },
    /// An unrecognized table or key (forward compat: ignored, not fatal).
    UnknownKey { key: String },
}

impl fmt::Display for ThemeWarning {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::SyntaxError { message } => {
                write!(f, "theme file is not valid TOML: {message}")
            }
            Self::MissingRequired { key } => {
                write!(f, "missing required theme key `{key}`")
            }
            Self::InvalidColor { key, got } => {
                write!(f, "invalid color for `{key}`: {got} is not a valid color")
            }
            Self::InvalidValue { key, got, expected } => {
                write!(
                    f,
                    "invalid value for `{key}`: got {got}, expected {expected}"
                )
            }
            Self::UnknownKey { key } => write!(f, "unknown theme key `{key}` (ignored)"),
        }
    }
}

/// The catalog id for a user theme loaded from `<config>/themes/<stem>.toml` (e.g. `"user:dracula"`).
/// Kept here so the id spelling has one source of truth shared by core and shell.
pub fn user_theme_id(stem: &str) -> String {
    format!("user:{stem}")
}

/// Tolerantly parse `text` into a validated [`ThemeSpec`]. Never panics.
///
/// Returns `Some(spec)` only when every required field is present and well-formed; otherwise `None`.
/// The [`ThemeWarning`]s describe every problem found (missing/invalid required fields, dropped
/// optional colors, unknown keys), whether or not the theme ended up valid.
pub fn parse_theme(text: &str) -> (Option<ThemeSpec>, Vec<ThemeWarning>) {
    let table = match text.parse::<toml::Table>() {
        Ok(table) => table,
        Err(error) => {
            return (
                None,
                vec![ThemeWarning::SyntaxError {
                    message: error.message().to_string(),
                }],
            );
        }
    };

    let mut draft = Draft::default();
    let mut sink = Sink::default();
    for (name, value) in &table {
        match name.as_str() {
            "is_dark" => read_bool(value, "is_dark", &mut draft.is_dark, &mut sink),
            "color" => walk_color(value, &mut draft, &mut sink),
            "terminal" => walk_terminal(value, &mut draft, &mut sink),
            _ => sink
                .warnings
                .push(ThemeWarning::UnknownKey { key: name.clone() }),
        }
    }
    draft.finish(sink)
}

// ---------------------------------------------------------------------------
// The tolerant walk: parse to a toml::Table, then read each KNOWN table/key
// explicitly (serde would abort on the first unknown/invalid field; the walk
// warns and keeps going). Present-and-valid fields land in the Draft; the Draft
// is validated into a ThemeSpec (or None) once the whole file has been read.
// ---------------------------------------------------------------------------

/// The 16 ANSI color names, in the order [`AnsiSpec`] declares them. Used both to look a key up
/// during the walk and to reassemble the palette in [`require_ansi`].
const ANSI_KEYS: [&str; 16] = [
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "bright_black",
    "bright_red",
    "bright_green",
    "bright_yellow",
    "bright_blue",
    "bright_magenta",
    "bright_cyan",
    "bright_white",
];

/// Every color/`is_dark` field, in its present-and-valid state, plus the set of keys actually seen
/// in the file (so a required field can tell "absent" from "present-but-invalid").
#[derive(Default)]
struct Draft {
    is_dark: Option<bool>,
    bg_primary: Option<String>,
    bg_secondary: Option<String>,
    bg_tertiary: Option<String>,
    text_primary: Option<String>,
    text_secondary: Option<String>,
    text_tertiary: Option<String>,
    accent_primary: Option<String>,
    accent_bg: Option<String>,
    border: Option<String>,
    selection: Option<String>,
    semantic_error: Option<String>,
    semantic_error_bg: Option<String>,
    semantic_success: Option<String>,
    ansi: [Option<String>; 16],
    cursor: Option<String>,
    cursor_accent: Option<String>,
    selection_background: Option<String>,
    badge: Option<String>,
    scrollbar_idle: Option<String>,
    scrollbar_hover: Option<String>,
    scrollbar_active: Option<String>,
    pane_active_border: Option<String>,
    pane_inactive_border: Option<String>,
    search_match: Option<String>,
    search_active_match: Option<String>,
}

/// Collects the walk's outputs so the field readers stay small.
#[derive(Default)]
struct Sink {
    warnings: Vec<ThemeWarning>,
    /// TOML paths that appeared in the file (valid or not) — lets a required field distinguish a
    /// truly-absent key (→ `MissingRequired`) from one present-but-invalid (already warned).
    seen: HashSet<String>,
}

impl Draft {
    /// Validate the accumulated draft: emit `MissingRequired` for any truly-absent required field,
    /// then build a [`ThemeSpec`] iff every required field is present-and-valid (else `None`).
    fn finish(self, mut sink: Sink) -> (Option<ThemeSpec>, Vec<ThemeWarning>) {
        // Extract every required field FIRST, so all `MissingRequired` warnings are recorded before
        // the assembly short-circuits on the first missing one.
        let is_dark = require_bool(self.is_dark, "is_dark", &mut sink);
        let bg_primary = require_color(self.bg_primary, "color.bg.primary", &mut sink);
        let text_primary = require_color(self.text_primary, "color.text.primary", &mut sink);
        let ansi = require_ansi(self.ansi, &mut sink);

        let spec = match (is_dark, bg_primary, text_primary, ansi) {
            (Some(is_dark), Some(bg_primary), Some(text_primary), Some(ansi)) => Some(ThemeSpec {
                is_dark,
                color: ColorSpec {
                    bg: BgSpec {
                        primary: bg_primary,
                        secondary: self.bg_secondary,
                        tertiary: self.bg_tertiary,
                    },
                    text: TextSpec {
                        primary: text_primary,
                        secondary: self.text_secondary,
                        tertiary: self.text_tertiary,
                    },
                    accent: AccentSpec {
                        primary: self.accent_primary,
                        bg: self.accent_bg,
                    },
                    border: self.border,
                    selection: self.selection,
                    semantic: SemanticSpec {
                        error: self.semantic_error,
                        error_bg: self.semantic_error_bg,
                        success: self.semantic_success,
                    },
                },
                terminal: TerminalSpec {
                    ansi,
                    cursor: self.cursor,
                    cursor_accent: self.cursor_accent,
                    selection_background: self.selection_background,
                    badge: self.badge,
                    scrollbar: ScrollbarSpec {
                        idle: self.scrollbar_idle,
                        hover: self.scrollbar_hover,
                        active: self.scrollbar_active,
                    },
                    pane: PaneSpec {
                        active_border: self.pane_active_border,
                        inactive_border: self.pane_inactive_border,
                    },
                    search: SearchSpec {
                        r#match: self.search_match,
                        active_match: self.search_active_match,
                    },
                },
            }),
            _ => None,
        };
        (spec, sink.warnings)
    }
}

fn walk_color(value: &toml::Value, draft: &mut Draft, sink: &mut Sink) {
    let Some(table) = as_table_or_warn(value, "color", sink) else {
        return;
    };
    for (key, value) in table {
        match key.as_str() {
            "bg" => walk_color_bg(value, draft, sink),
            "text" => walk_color_text(value, draft, sink),
            "accent" => walk_color_accent(value, draft, sink),
            "semantic" => walk_color_semantic(value, draft, sink),
            "border" => read_color(value, "color.border", &mut draft.border, sink),
            "selection" => read_color(value, "color.selection", &mut draft.selection, sink),
            _ => sink.warnings.push(ThemeWarning::UnknownKey {
                key: format!("color.{key}"),
            }),
        }
    }
}

fn walk_color_bg(value: &toml::Value, draft: &mut Draft, sink: &mut Sink) {
    let Some(table) = as_table_or_warn(value, "color.bg", sink) else {
        return;
    };
    for (key, value) in table {
        match key.as_str() {
            "primary" => read_color(value, "color.bg.primary", &mut draft.bg_primary, sink),
            "secondary" => read_color(value, "color.bg.secondary", &mut draft.bg_secondary, sink),
            "tertiary" => read_color(value, "color.bg.tertiary", &mut draft.bg_tertiary, sink),
            _ => sink.warnings.push(ThemeWarning::UnknownKey {
                key: format!("color.bg.{key}"),
            }),
        }
    }
}

fn walk_color_text(value: &toml::Value, draft: &mut Draft, sink: &mut Sink) {
    let Some(table) = as_table_or_warn(value, "color.text", sink) else {
        return;
    };
    for (key, value) in table {
        match key.as_str() {
            "primary" => read_color(value, "color.text.primary", &mut draft.text_primary, sink),
            "secondary" => read_color(
                value,
                "color.text.secondary",
                &mut draft.text_secondary,
                sink,
            ),
            "tertiary" => read_color(value, "color.text.tertiary", &mut draft.text_tertiary, sink),
            _ => sink.warnings.push(ThemeWarning::UnknownKey {
                key: format!("color.text.{key}"),
            }),
        }
    }
}

fn walk_color_accent(value: &toml::Value, draft: &mut Draft, sink: &mut Sink) {
    let Some(table) = as_table_or_warn(value, "color.accent", sink) else {
        return;
    };
    for (key, value) in table {
        match key.as_str() {
            "primary" => read_color(
                value,
                "color.accent.primary",
                &mut draft.accent_primary,
                sink,
            ),
            "bg" => read_color(value, "color.accent.bg", &mut draft.accent_bg, sink),
            _ => sink.warnings.push(ThemeWarning::UnknownKey {
                key: format!("color.accent.{key}"),
            }),
        }
    }
}

fn walk_color_semantic(value: &toml::Value, draft: &mut Draft, sink: &mut Sink) {
    let Some(table) = as_table_or_warn(value, "color.semantic", sink) else {
        return;
    };
    for (key, value) in table {
        match key.as_str() {
            "error" => read_color(
                value,
                "color.semantic.error",
                &mut draft.semantic_error,
                sink,
            ),
            "error_bg" => read_color(
                value,
                "color.semantic.error_bg",
                &mut draft.semantic_error_bg,
                sink,
            ),
            "success" => read_color(
                value,
                "color.semantic.success",
                &mut draft.semantic_success,
                sink,
            ),
            _ => sink.warnings.push(ThemeWarning::UnknownKey {
                key: format!("color.semantic.{key}"),
            }),
        }
    }
}

fn walk_terminal(value: &toml::Value, draft: &mut Draft, sink: &mut Sink) {
    let Some(table) = as_table_or_warn(value, "terminal", sink) else {
        return;
    };
    for (key, value) in table {
        match key.as_str() {
            "ansi" => walk_terminal_ansi(value, draft, sink),
            "scrollbar" => walk_terminal_scrollbar(value, draft, sink),
            "pane" => walk_terminal_pane(value, draft, sink),
            "search" => walk_terminal_search(value, draft, sink),
            "cursor" => read_color(value, "terminal.cursor", &mut draft.cursor, sink),
            "cursor_accent" => read_color(
                value,
                "terminal.cursor_accent",
                &mut draft.cursor_accent,
                sink,
            ),
            "selection_background" => read_color(
                value,
                "terminal.selection_background",
                &mut draft.selection_background,
                sink,
            ),
            "badge" => read_color(value, "terminal.badge", &mut draft.badge, sink),
            _ => sink.warnings.push(ThemeWarning::UnknownKey {
                key: format!("terminal.{key}"),
            }),
        }
    }
}

fn walk_terminal_ansi(value: &toml::Value, draft: &mut Draft, sink: &mut Sink) {
    let Some(table) = as_table_or_warn(value, "terminal.ansi", sink) else {
        return;
    };
    for (key, value) in table {
        match ANSI_KEYS.iter().position(|&name| name == key.as_str()) {
            Some(index) => read_color(
                value,
                &format!("terminal.ansi.{key}"),
                &mut draft.ansi[index],
                sink,
            ),
            None => sink.warnings.push(ThemeWarning::UnknownKey {
                key: format!("terminal.ansi.{key}"),
            }),
        }
    }
}

fn walk_terminal_scrollbar(value: &toml::Value, draft: &mut Draft, sink: &mut Sink) {
    let Some(table) = as_table_or_warn(value, "terminal.scrollbar", sink) else {
        return;
    };
    for (key, value) in table {
        match key.as_str() {
            "idle" => read_color(
                value,
                "terminal.scrollbar.idle",
                &mut draft.scrollbar_idle,
                sink,
            ),
            "hover" => read_color(
                value,
                "terminal.scrollbar.hover",
                &mut draft.scrollbar_hover,
                sink,
            ),
            "active" => read_color(
                value,
                "terminal.scrollbar.active",
                &mut draft.scrollbar_active,
                sink,
            ),
            _ => sink.warnings.push(ThemeWarning::UnknownKey {
                key: format!("terminal.scrollbar.{key}"),
            }),
        }
    }
}

fn walk_terminal_pane(value: &toml::Value, draft: &mut Draft, sink: &mut Sink) {
    let Some(table) = as_table_or_warn(value, "terminal.pane", sink) else {
        return;
    };
    for (key, value) in table {
        match key.as_str() {
            "active_border" => read_color(
                value,
                "terminal.pane.active_border",
                &mut draft.pane_active_border,
                sink,
            ),
            "inactive_border" => read_color(
                value,
                "terminal.pane.inactive_border",
                &mut draft.pane_inactive_border,
                sink,
            ),
            _ => sink.warnings.push(ThemeWarning::UnknownKey {
                key: format!("terminal.pane.{key}"),
            }),
        }
    }
}

/// `[terminal.search]`: the find-bar highlight colors (trmx-98, FR-1.5) — both optional/derivable.
fn walk_terminal_search(value: &toml::Value, draft: &mut Draft, sink: &mut Sink) {
    let Some(table) = as_table_or_warn(value, "terminal.search", sink) else {
        return;
    };
    for (key, value) in table {
        match key.as_str() {
            "match" => read_color(
                value,
                "terminal.search.match",
                &mut draft.search_match,
                sink,
            ),
            "active_match" => read_color(
                value,
                "terminal.search.active_match",
                &mut draft.search_active_match,
                sink,
            ),
            _ => sink.warnings.push(ThemeWarning::UnknownKey {
                key: format!("terminal.search.{key}"),
            }),
        }
    }
}

/// Read a color-valued field: mark the key as seen, then store it iff the value is a string that
/// passes [`is_valid_color`]. A non-string or malformed color records an `InvalidColor` and leaves
/// the slot empty (treated as absent by the required/optional logic).
fn read_color(value: &toml::Value, key: &str, slot: &mut Option<String>, sink: &mut Sink) {
    sink.seen.insert(key.to_string());
    match value.as_str() {
        Some(text) if is_valid_color(text) => *slot = Some(text.to_string()),
        _ => sink.warnings.push(ThemeWarning::InvalidColor {
            key: key.to_string(),
            got: describe_value(value),
        }),
    }
}

/// Read the boolean `is_dark`: mark it seen, then store it iff the value is a boolean (else warn).
fn read_bool(value: &toml::Value, key: &str, slot: &mut Option<bool>, sink: &mut Sink) {
    sink.seen.insert(key.to_string());
    match value.as_bool() {
        Some(flag) => *slot = Some(flag),
        None => sink.warnings.push(ThemeWarning::InvalidValue {
            key: key.to_string(),
            got: describe_value(value),
            expected: "a boolean (true or false)".to_string(),
        }),
    }
}

/// Resolve a required color slot: pass a present-and-valid value through; for an empty slot, warn
/// `MissingRequired` only when the key was never seen (a present-but-invalid one already warned).
fn require_color(slot: Option<String>, key: &str, sink: &mut Sink) -> Option<String> {
    if slot.is_some() {
        return slot;
    }
    if !sink.seen.contains(key) {
        sink.warnings.push(ThemeWarning::MissingRequired {
            key: key.to_string(),
        });
    }
    None
}

/// Resolve the required `is_dark` slot — the boolean analogue of [`require_color`].
fn require_bool(slot: Option<bool>, key: &str, sink: &mut Sink) -> Option<bool> {
    if slot.is_some() {
        return slot;
    }
    if !sink.seen.contains(key) {
        sink.warnings.push(ThemeWarning::MissingRequired {
            key: key.to_string(),
        });
    }
    None
}

/// Assemble the required 16-color ANSI palette. Every slot is resolved first (so every absent color
/// warns `MissingRequired`); the palette is `Some` only when all 16 are present-and-valid.
fn require_ansi(slots: [Option<String>; 16], sink: &mut Sink) -> Option<AnsiSpec> {
    let mut colors: Vec<Option<String>> = Vec::with_capacity(ANSI_KEYS.len());
    for (slot, name) in slots.into_iter().zip(ANSI_KEYS) {
        colors.push(require_color(slot, &format!("terminal.ansi.{name}"), sink));
    }
    if colors.iter().any(Option::is_none) {
        return None;
    }
    // All 16 are present (checked above); `next()?` unwraps without a panic (R3: no unwrap/expect).
    let mut it = colors.into_iter().flatten();
    Some(AnsiSpec {
        black: it.next()?,
        red: it.next()?,
        green: it.next()?,
        yellow: it.next()?,
        blue: it.next()?,
        magenta: it.next()?,
        cyan: it.next()?,
        white: it.next()?,
        bright_black: it.next()?,
        bright_red: it.next()?,
        bright_green: it.next()?,
        bright_yellow: it.next()?,
        bright_blue: it.next()?,
        bright_magenta: it.next()?,
        bright_cyan: it.next()?,
        bright_white: it.next()?,
    })
}

/// Borrow `value` as a table, or record an `InvalidValue` (a table-typed key holding a non-table)
/// and return `None` so the caller skips that sub-tree.
fn as_table_or_warn<'a>(
    value: &'a toml::Value,
    key: &str,
    sink: &mut Sink,
) -> Option<&'a toml::Table> {
    match value.as_table() {
        Some(table) => Some(table),
        None => {
            sink.warnings.push(ThemeWarning::InvalidValue {
                key: key.to_string(),
                got: describe_value(value),
                expected: "a table".to_string(),
            });
            None
        }
    }
}

/// Whether `s` is a color Termixion accepts: `#` + exactly 3/4/6/8 hex digits, or a whitespace-
/// tolerant `rgb(i,i,i)` (each `i` in `0..=255`), or `rgba(i,i,i,a)` (`a` a float in `0.0..=1.0`).
fn is_valid_color(s: &str) -> bool {
    let s = s.trim();
    if let Some(hex) = s.strip_prefix('#') {
        return matches!(hex.len(), 3 | 4 | 6 | 8) && hex.bytes().all(|b| b.is_ascii_hexdigit());
    }
    if let Some(inner) = s
        .strip_prefix("rgb(")
        .and_then(|rest| rest.strip_suffix(')'))
    {
        let parts: Vec<&str> = inner.split(',').collect();
        return parts.len() == 3 && parts.iter().all(|part| is_u8_component(part));
    }
    if let Some(inner) = s
        .strip_prefix("rgba(")
        .and_then(|rest| rest.strip_suffix(')'))
    {
        let parts: Vec<&str> = inner.split(',').collect();
        return parts.len() == 4
            && parts[..3].iter().all(|part| is_u8_component(part))
            && is_alpha_component(parts[3]);
    }
    false
}

/// Whether `part` (whitespace-tolerant) is an integer in `0..=255`.
fn is_u8_component(part: &str) -> bool {
    part.trim().parse::<u8>().is_ok()
}

/// Whether `part` (whitespace-tolerant) is a float alpha in `0.0..=1.0`.
fn is_alpha_component(part: &str) -> bool {
    matches!(part.trim().parse::<f64>(), Ok(alpha) if (0.0..=1.0).contains(&alpha))
}

/// A short human description of a TOML value for a warning's `got` field.
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

    /// A minimal VALID theme: exactly the required set (`is_dark`, `color.bg.primary`,
    /// `color.text.primary`, all 16 `terminal.ansi.*`) and nothing else. Every ansi value is
    /// distinct enough that the `replace`-based tests below can surgically drop/mutate one line.
    const MINIMAL: &str = r##"
is_dark = false

[color.bg]
primary = "#000000"

[color.text]
primary = "#ffffff"

[terminal.ansi]
black = "#000000"
red = "#ff0000"
green = "#00ff00"
yellow = "#ffff00"
blue = "#0000ff"
magenta = "#ff00ff"
cyan = "#00ffff"
white = "#ffffff"
bright_black = "#808080"
bright_red = "#ff8080"
bright_green = "#80ff80"
bright_yellow = "#ffff80"
bright_blue = "#8080ff"
bright_magenta = "#ff80ff"
bright_cyan = "#80ffff"
bright_white = "#f0f6fc"
"##;

    /// A full VALID theme (the `night` palette): every required field plus a representative set of
    /// optionals, including `rgba(...)` values on the derived/translucent slots.
    const FULL: &str = r##"
is_dark = true

[color]
border = "#3a3f46"
selection = "rgba(90, 168, 255, 0.22)"

[color.bg]
primary = "#23262b"
secondary = "#2a2e34"
tertiary = "#32363d"

[color.text]
primary = "#d6d9de"
secondary = "#9aa0a6"
tertiary = "#6b7078"

[color.accent]
primary = "#58a6ff"
bg = "rgba(88, 166, 255, 0.12)"

[color.semantic]
error = "#f85149"
error_bg = "rgba(248, 81, 73, 0.15)"
success = "#4ade80"

[terminal]
cursor = "#d6d9de"
cursor_accent = "#23262b"
selection_background = "rgba(90, 168, 255, 0.22)"

[terminal.ansi]
black = "#1a1d22"
red = "#f85149"
green = "#3fb950"
yellow = "#d29922"
blue = "#58a6ff"
magenta = "#bc8cff"
cyan = "#39c5cf"
white = "#b1bac4"
bright_black = "#6e7681"
bright_red = "#ff7b72"
bright_green = "#56d364"
bright_yellow = "#e3b341"
bright_blue = "#79c0ff"
bright_magenta = "#d2a8ff"
bright_cyan = "#56d4dd"
bright_white = "#f0f6fc"

[terminal.scrollbar]
idle = "rgba(255, 255, 255, 0.12)"
hover = "rgba(255, 255, 255, 0.20)"
active = "rgba(255, 255, 255, 0.30)"

[terminal.pane]
active_border = "#58a6ff"
inactive_border = "#3a3f46"
"##;

    // 1. Minimal valid file → Some(spec), zero warnings, every optional is None.
    #[test]
    fn minimal_valid_file_parses_with_no_warnings_and_none_optionals() {
        let (spec, warnings) = parse_theme(MINIMAL);
        assert_eq!(warnings, Vec::new(), "expected no warnings");
        let spec = spec.expect("minimal theme must be valid");
        assert!(!spec.is_dark);
        assert_eq!(spec.color.bg.primary, "#000000");
        assert_eq!(spec.color.text.primary, "#ffffff");
        assert_eq!(spec.terminal.ansi.black, "#000000");
        assert_eq!(spec.terminal.ansi.bright_white, "#f0f6fc");
        // Every optional is omitted.
        assert_eq!(spec.color.bg.secondary, None);
        assert_eq!(spec.color.bg.tertiary, None);
        assert_eq!(spec.color.text.secondary, None);
        assert_eq!(spec.color.text.tertiary, None);
        assert_eq!(spec.color.accent.primary, None);
        assert_eq!(spec.color.accent.bg, None);
        assert_eq!(spec.color.border, None);
        assert_eq!(spec.color.selection, None);
        assert_eq!(spec.color.semantic.error, None);
        assert_eq!(spec.color.semantic.error_bg, None);
        assert_eq!(spec.color.semantic.success, None);
        assert_eq!(spec.terminal.cursor, None);
        assert_eq!(spec.terminal.cursor_accent, None);
        assert_eq!(spec.terminal.selection_background, None);
        assert_eq!(spec.terminal.badge, None);
        assert_eq!(spec.terminal.scrollbar.idle, None);
        assert_eq!(spec.terminal.scrollbar.hover, None);
        assert_eq!(spec.terminal.scrollbar.active, None);
        assert_eq!(spec.terminal.pane.active_border, None);
        assert_eq!(spec.terminal.pane.inactive_border, None);
    }

    // 2. Full valid file (with rgba optionals) → Some(spec), zero warnings, optionals Some.
    #[test]
    fn full_valid_file_parses_with_no_warnings_and_some_optionals() {
        let (spec, warnings) = parse_theme(FULL);
        assert_eq!(warnings, Vec::new(), "expected no warnings");
        let spec = spec.expect("full theme must be valid");
        assert!(spec.is_dark);
        assert_eq!(spec.color.bg.primary, "#23262b");
        assert_eq!(spec.color.bg.secondary, Some("#2a2e34".to_string()));
        assert_eq!(spec.color.bg.tertiary, Some("#32363d".to_string()));
        assert_eq!(spec.color.text.secondary, Some("#9aa0a6".to_string()));
        assert_eq!(spec.color.text.tertiary, Some("#6b7078".to_string()));
        assert_eq!(spec.color.accent.primary, Some("#58a6ff".to_string()));
        assert_eq!(
            spec.color.accent.bg,
            Some("rgba(88, 166, 255, 0.12)".to_string())
        );
        assert_eq!(spec.color.border, Some("#3a3f46".to_string()));
        assert_eq!(
            spec.color.selection,
            Some("rgba(90, 168, 255, 0.22)".to_string())
        );
        assert_eq!(spec.color.semantic.error, Some("#f85149".to_string()));
        assert_eq!(
            spec.color.semantic.error_bg,
            Some("rgba(248, 81, 73, 0.15)".to_string())
        );
        assert_eq!(spec.color.semantic.success, Some("#4ade80".to_string()));
        assert_eq!(spec.terminal.ansi.bright_black, "#6e7681");
        assert_eq!(spec.terminal.cursor, Some("#d6d9de".to_string()));
        assert_eq!(spec.terminal.cursor_accent, Some("#23262b".to_string()));
        assert_eq!(
            spec.terminal.selection_background,
            Some("rgba(90, 168, 255, 0.22)".to_string())
        );
        assert_eq!(
            spec.terminal.scrollbar.idle,
            Some("rgba(255, 255, 255, 0.12)".to_string())
        );
        assert_eq!(
            spec.terminal.scrollbar.hover,
            Some("rgba(255, 255, 255, 0.20)".to_string())
        );
        assert_eq!(
            spec.terminal.scrollbar.active,
            Some("rgba(255, 255, 255, 0.30)".to_string())
        );
        assert_eq!(
            spec.terminal.pane.active_border,
            Some("#58a6ff".to_string())
        );
        assert_eq!(
            spec.terminal.pane.inactive_border,
            Some("#3a3f46".to_string())
        );
    }

    // 3. A missing required field (color.text.primary) → None + MissingRequired for it.
    #[test]
    fn missing_required_text_primary_makes_theme_invalid() {
        let text = MINIMAL.replace("primary = \"#ffffff\"", "");
        let (spec, warnings) = parse_theme(&text);
        assert!(
            spec.is_none(),
            "a missing required field invalidates the theme"
        );
        assert!(
            warnings.contains(&ThemeWarning::MissingRequired {
                key: "color.text.primary".to_string()
            }),
            "warnings: {warnings:?}"
        );
    }

    // 4. A missing ansi color → None + MissingRequired for that ansi key.
    #[test]
    fn missing_ansi_color_makes_theme_invalid() {
        let text = MINIMAL.replace("cyan = \"#00ffff\"\n", "");
        let (spec, warnings) = parse_theme(&text);
        assert!(spec.is_none());
        assert!(
            warnings.contains(&ThemeWarning::MissingRequired {
                key: "terminal.ansi.cyan".to_string()
            }),
            "warnings: {warnings:?}"
        );
    }

    // 5. An invalid REQUIRED color (bg.primary = "#gg") → None + InvalidColor (NOT MissingRequired).
    #[test]
    fn invalid_required_color_makes_theme_invalid() {
        let text = MINIMAL.replace("primary = \"#000000\"", "primary = \"#gg\"");
        let (spec, warnings) = parse_theme(&text);
        assert!(spec.is_none());
        assert!(
            warnings.iter().any(|w| matches!(
                w,
                ThemeWarning::InvalidColor { key, .. } if key == "color.bg.primary"
            )),
            "warnings: {warnings:?}"
        );
        // Present-but-invalid does not also warn MissingRequired.
        assert!(!warnings.contains(&ThemeWarning::MissingRequired {
            key: "color.bg.primary".to_string()
        }));
    }

    // 6. An invalid OPTIONAL color (scrollbar.idle) → still Some, + InvalidColor, and the field None.
    #[test]
    fn invalid_optional_color_warns_but_theme_stays_valid() {
        let text = format!("{MINIMAL}\n[terminal.scrollbar]\nidle = \"nope\"\n");
        let (spec, warnings) = parse_theme(&text);
        let spec = spec.expect("a bad optional color must not invalidate the theme");
        assert_eq!(spec.terminal.scrollbar.idle, None);
        assert!(
            warnings.iter().any(|w| matches!(
                w,
                ThemeWarning::InvalidColor { key, .. } if key == "terminal.scrollbar.idle"
            )),
            "warnings: {warnings:?}"
        );
    }

    // 6a. An optional badge, present and valid → Some(spec), the field Some, zero warnings.
    #[test]
    fn badge_present_and_valid_parses_to_some_with_no_warnings() {
        let text = MINIMAL.replace(
            "[terminal.ansi]",
            "[terminal]\nbadge = \"rgba(255, 255, 255, 0.08)\"\n\n[terminal.ansi]",
        );
        let (spec, warnings) = parse_theme(&text);
        assert_eq!(warnings, Vec::new(), "a valid badge produces no warnings");
        let spec = spec.expect("a valid badge must not invalidate the theme");
        assert_eq!(
            spec.terminal.badge,
            Some("rgba(255, 255, 255, 0.08)".to_string())
        );
    }

    // 6b. An invalid badge color → still Some(spec) + InvalidColor, and the field None (non-fatal).
    #[test]
    fn invalid_badge_color_warns_but_theme_stays_valid() {
        let text = MINIMAL.replace(
            "[terminal.ansi]",
            "[terminal]\nbadge = \"nope\"\n\n[terminal.ansi]",
        );
        let (spec, warnings) = parse_theme(&text);
        let spec = spec.expect("a bad optional badge must not invalidate the theme");
        assert_eq!(spec.terminal.badge, None);
        assert!(
            warnings.iter().any(|w| matches!(
                w,
                ThemeWarning::InvalidColor { key, .. } if key == "terminal.badge"
            )),
            "warnings: {warnings:?}"
        );
    }

    // 7. Unknown key + unknown table → Some (required present) + UnknownKey; the rest parses.
    #[test]
    fn unknown_key_and_table_warn_but_theme_still_parses() {
        let text = format!("wat = 1\n{MINIMAL}\n[color.bogus]\nx = 1\n");
        let (spec, warnings) = parse_theme(&text);
        assert!(spec.is_some(), "required fields present → still Some");
        assert!(
            warnings.contains(&ThemeWarning::UnknownKey {
                key: "wat".to_string()
            }),
            "warnings: {warnings:?}"
        );
        assert!(
            warnings.contains(&ThemeWarning::UnknownKey {
                key: "color.bogus".to_string()
            }),
            "warnings: {warnings:?}"
        );
    }

    // 8. is_dark wrong type → None (is_dark required) + InvalidValue (NOT MissingRequired).
    #[test]
    fn is_dark_wrong_type_makes_theme_invalid() {
        let text = MINIMAL.replace("is_dark = false", "is_dark = \"yes\"");
        let (spec, warnings) = parse_theme(&text);
        assert!(spec.is_none());
        assert!(
            warnings.iter().any(|w| matches!(
                w,
                ThemeWarning::InvalidValue { key, .. } if key == "is_dark"
            )),
            "warnings: {warnings:?}"
        );
        assert!(!warnings.contains(&ThemeWarning::MissingRequired {
            key: "is_dark".to_string()
        }));
    }

    // 9. Junk bytes / non-TOML → None + SyntaxError, never panics.
    #[test]
    fn junk_bytes_yield_none_and_a_syntax_warning() {
        let (spec, warnings) = parse_theme("\u{0}\u{1}not [[[ toml");
        assert!(spec.is_none());
        assert_eq!(warnings.len(), 1);
        assert!(matches!(&warnings[0], ThemeWarning::SyntaxError { .. }));
    }

    // 10. Every color grammar form is accepted; malformed forms are rejected.
    #[test]
    fn color_grammar_accepts_and_rejects() {
        for good in [
            "#abc",
            "#abcd",
            "#aabbcc",
            "#aabbccdd",
            "rgb(1,2,3)",
            "rgba(1,2,3,0.5)",
            "rgb(0, 0, 0)",
            "rgba(255, 255, 255, 1)",
            "rgba(0, 0, 0, 0)",
        ] {
            assert!(is_valid_color(good), "should accept {good}");
        }
        for bad in [
            "#12345",
            "rgb()",
            "#gg",
            "123456",
            "",
            "#12",
            "rgb(1,2)",
            "rgba(1,2,3)",
            "rgb(256,0,0)",
            "rgba(0,0,0,1.5)",
            "rgba(0,0,0,-0.1)",
            "hsl(1,2,3)",
        ] {
            assert!(!is_valid_color(bad), "should reject {bad}");
        }
    }

    // 11. user_theme_id prefixes the stem with "user:".
    #[test]
    fn user_theme_id_prefixes_with_user() {
        assert_eq!(user_theme_id("foo"), "user:foo");
        assert_eq!(user_theme_id("dracula-pro"), "user:dracula-pro");
        assert_eq!(user_theme_id(""), "user:");
    }

    // 12. Each warning's Display is human-readable and carries its identifying field.
    #[test]
    fn warnings_display_carries_the_key() {
        let warning = ThemeWarning::MissingRequired {
            key: "color.bg.primary".to_string(),
        };
        assert!(warning.to_string().contains("color.bg.primary"));

        let warning = ThemeWarning::InvalidColor {
            key: "terminal.ansi.red".to_string(),
            got: "\"nope\"".to_string(),
        };
        let text = warning.to_string();
        assert!(text.contains("terminal.ansi.red"));
        assert!(text.contains("nope"));

        let warning = ThemeWarning::InvalidValue {
            key: "is_dark".to_string(),
            got: "\"yes\"".to_string(),
            expected: "a boolean (true or false)".to_string(),
        };
        let text = warning.to_string();
        assert!(text.contains("is_dark"));
        assert!(text.contains("yes"));

        let warning = ThemeWarning::UnknownKey {
            key: "wat".to_string(),
        };
        assert!(warning.to_string().contains("wat"));

        let warning = ThemeWarning::SyntaxError {
            message: "unexpected token".to_string(),
        };
        assert!(warning.to_string().contains("unexpected token"));
    }

    // A table-typed key holding a non-table warns InvalidValue and skips the sub-tree (no panic).
    #[test]
    fn non_table_for_a_table_key_warns_invalid_value() {
        // Replace the whole `[color.*]` section with a bare `color = 5` scalar.
        let text = MINIMAL.replace(
            "[color.bg]\nprimary = \"#000000\"\n\n[color.text]\nprimary = \"#ffffff\"",
            "color = 5",
        );
        let (spec, warnings) = parse_theme(&text);
        // `color` is a table-typed key holding an integer → InvalidValue, and its required children
        // (bg.primary/text.primary) are gone → the theme is invalid.
        assert!(spec.is_none());
        assert!(
            warnings.iter().any(|w| matches!(
                w,
                ThemeWarning::InvalidValue { key, expected, .. }
                    if key == "color" && expected == "a table"
            )),
            "warnings: {warnings:?}"
        );
    }

    // Serialization contract: camelCase keys, and absent optionals are omitted (skip_serializing_if).
    #[test]
    fn minimal_spec_json_is_camel_case_and_omits_absent_optionals() {
        let (spec, _) = parse_theme(MINIMAL);
        let spec = spec.expect("valid");
        let json = serde_json::to_value(&spec).expect("ThemeSpec serializes");
        assert_eq!(json["isDark"], serde_json::json!(false));
        assert_eq!(json["color"]["bg"]["primary"], serde_json::json!("#000000"));
        assert_eq!(
            json["terminal"]["ansi"]["brightBlack"],
            serde_json::json!("#808080")
        );
        // Absent optionals are omitted entirely (not serialized as null).
        assert!(json["color"]["bg"].get("secondary").is_none());
        assert!(json["color"].get("border").is_none());
        assert!(json["color"]["semantic"].get("errorBg").is_none());
        assert!(json["terminal"].get("cursor").is_none());
        assert!(json["terminal"].get("cursorAccent").is_none());
        assert!(json["terminal"]["scrollbar"].get("idle").is_none());
        assert!(json["terminal"]["pane"].get("activeBorder").is_none());
    }

    // Serialization contract: present optionals ARE serialized, in camelCase, incl. rgba values.
    #[test]
    fn full_spec_json_serializes_present_optionals_in_camel_case() {
        let (spec, _) = parse_theme(FULL);
        let spec = spec.expect("valid");
        let json = serde_json::to_value(&spec).expect("ThemeSpec serializes");
        assert_eq!(json["isDark"], serde_json::json!(true));
        assert_eq!(
            json["color"]["semantic"]["errorBg"],
            serde_json::json!("rgba(248, 81, 73, 0.15)")
        );
        assert_eq!(
            json["terminal"]["cursorAccent"],
            serde_json::json!("#23262b")
        );
        assert_eq!(
            json["terminal"]["selectionBackground"],
            serde_json::json!("rgba(90, 168, 255, 0.22)")
        );
        assert_eq!(
            json["terminal"]["pane"]["activeBorder"],
            serde_json::json!("#58a6ff")
        );
    }
}
