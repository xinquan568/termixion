// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-80 (FR-13): the config file's I/O edge — path resolution, tolerant reads, comment-
//! preserving `toml_edit` writes, and the parent-directory watcher that live-applies external
//! edits as `settings:changed` events (riding the trmx-51/53 registry plumbing).
//!
//! The file lives at `$XDG_CONFIG_HOME/termixion/termixion.toml` (default
//! `~/.config/termixion/termixion.toml`) — the Kitty-precedent, user-editable dotfile location,
//! deliberately NOT the Tauri app-data dir (that is for caches/state, not a hand-edited config).
//!
//! Discipline mirrors `main.rs`: every DECISION is a pure, unit-tested function
//! ([`config_path_from`], [`edit_document`], [`read_response_from`]); the filesystem / `notify`
//! edge around them is thin runtime glue (validated by the packaged smoke). trmx-244 moved the
//! watcher's own decision — `text_hash` / `should_apply` / [`apply_file_text`] — down into
//! [`termixion_core::config`], so the headless Linux job covers it; this module keeps the edge that
//! calls in.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use crate::enhancements_io::EnhancementsStatus;
use crate::ipc_error::IpcError;
use serde_json::{Map, Value as JsonValue};
use tauri::{Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use termixion_core::{
    Config, ConfigWarning, DEFAULT_TEMPLATE, FileApplication, RegistryValue, apply_file_text,
    parse_config, parse_registry_pairs, text_hash, toml_path_for,
};

/// The config file's basename, shared by the path resolver and the watcher's event filter.
const CONFIG_FILE_NAME: &str = "termixion.toml";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/// Resolve the config file path from the given environment values (pure).
/// A non-empty `$XDG_CONFIG_HOME` wins; otherwise `<home>/.config` (the XDG default).
pub fn config_path_from(xdg_config_home: Option<&str>, home: &str) -> PathBuf {
    let base = match xdg_config_home.filter(|dir| !dir.is_empty()) {
        Some(xdg) => PathBuf::from(xdg),
        None => Path::new(home).join(".config"),
    };
    base.join("termixion").join(CONFIG_FILE_NAME)
}

/// The real config file path, from the process environment.
pub fn config_path() -> PathBuf {
    let xdg = std::env::var("XDG_CONFIG_HOME").ok();
    let home = std::env::var("HOME").unwrap_or_default();
    config_path_from(xdg.as_deref(), &home)
}

// ---------------------------------------------------------------------------
// Managed state
// ---------------------------------------------------------------------------

/// The config backbone's managed state: the last config the app applied (the diff base for
/// file-watch events) and the hash of the last bytes WE wrote (the self-echo latch, D6).
#[derive(Default)]
pub struct ConfigState(Mutex<ConfigInner>);

#[derive(Default)]
struct ConfigInner {
    last: Config,
    last_write_hash: Option<u64>,
    /// trmx-205: the parse warnings of the last applied read/watch — the base the spawn-time
    /// shell-fallback re-emission layers the fresh shell warning onto (no file change happens
    /// when a configured shell is uninstalled, so the cached set is the only honest base).
    last_warnings: Vec<ConfigWarning>,
    /// trmx-238 (M15): the READ HEALTH of the last read — `Some(reason)` while the file is present
    /// but unreadable. Tracked separately from `last_warnings` (which stays parse-only) because
    /// the warning surface is rebuilt wholesale on every read, wake and re-emission: without this,
    /// the first unrelated re-emission (an enhancement-status transition, a shell fallback) would
    /// publish a set with no `Unreadable` in it and silently clear the banner while the file was
    /// still unreadable.
    last_unreadable: Option<String>,
}

/// The TOML value class a registry key expects — the shell-side type gate for writes.
#[derive(Clone, Copy, Debug, PartialEq)]
enum ValueKind {
    Bool,
    Int,
    Str,
}

impl ValueKind {
    fn expected(self) -> &'static str {
        match self {
            Self::Bool => "a boolean",
            Self::Int => "an integer",
            Self::Str => "a string",
        }
    }
}

/// The value class for a registry key; `None` for unknown keys. Must stay in lockstep with
/// core's `toml_path_for` (pinned by test).
fn value_kind_for(registry_key: &str) -> Option<ValueKind> {
    match registry_key {
        "update.autoCheck"
        | "update.autoDownload"
        | "terminal.cursorBlink"
        | "terminal.activityIndicator"
        | "terminal.copyOnSelect"
        | "terminal.focusFollowsMouse" // trmx-225
        | "tabs.showShortcutHints" // trmx-151
        | "titleBar.aiCounter" // trmx-190
        | "shell.enhancements" // trmx-206
        | "shell.autosuggestions"
        | "shell.syntaxHighlighting"
        | "remote_control.enabled" => Some(ValueKind::Bool),
        "terminal.scrollbackLines" | "terminal.fontSize" => Some(ValueKind::Int),
        "update.checkFrequency"
        | "terminal.cursorStyle"
        | "terminal.fontFamily"
        | "terminal.shell" // trmx-205
        | "shell.prompt" // trmx-207
        | "terminal.confirmClose"
        | "terminal.clipboardWrite" // trmx-252
        | "appearance.theme"
        | "tabs.barPosition"
        | "tabs.sideLabelOrientation"
        | "scripts.startup"
        | "remote_control.socketPath" => Some(ValueKind::Str),
        _ => None,
    }
}

/// A short description of a JSON value for error messages.
fn describe_json(value: &JsonValue) -> String {
    match value {
        JsonValue::Null => "null".to_string(),
        JsonValue::Bool(flag) => flag.to_string(),
        JsonValue::Number(number) => number.to_string(),
        JsonValue::String(text) => format!("\"{text}\""),
        JsonValue::Array(_) => "an array".to_string(),
        JsonValue::Object(_) => "an object".to_string(),
    }
}

/// The `toml_edit` item for `value` if it matches the key's expected class; the typed
/// rejection otherwise (fractional/overflowing JSON numbers are NOT integers).
fn toml_item_for(
    key: &str,
    kind: ValueKind,
    value: &JsonValue,
) -> Result<toml_edit::Item, IpcError> {
    // trmx-249: a caller-supplied value we reject on inspection — `invalid`, not `io`.
    let mismatch = || {
        IpcError::invalid(format!(
            "wrong value type for `{key}`: expected {}, got {}",
            kind.expected(),
            describe_json(value)
        ))
    };
    match (kind, value) {
        (ValueKind::Bool, JsonValue::Bool(flag)) => Ok(toml_edit::value(*flag)),
        (ValueKind::Int, JsonValue::Number(number)) => {
            let int = number.as_i64().ok_or_else(mismatch)?;
            Ok(toml_edit::value(int))
        }
        (ValueKind::Str, JsonValue::String(text)) => Ok(toml_edit::value(text.as_str())),
        _ => Err(mismatch()),
    }
}

/// Comment-preserving single-key edit (pure): parse `text` with `toml_edit`, set the mapped
/// `(table, key)` to `value` (creating a missing table), and render the document back.
/// Unknown registry key or a JSON value of the wrong type for the key → `Err`, nothing written.
fn edit_document(text: &str, key: &str, value: &JsonValue) -> Result<String, IpcError> {
    let (table_name, toml_key) = toml_path_for(key)
        .ok_or_else(|| IpcError::invalid(format!("unknown settings key `{key}`")))?;
    let kind = value_kind_for(key)
        .ok_or_else(|| IpcError::invalid(format!("unknown settings key `{key}`")))?;
    let item = toml_item_for(key, kind, value)?;

    // Refuse to clobber a file we cannot parse losslessly: a broken file is the user's to fix
    // (config_read surfaces the SyntaxError warning), not ours to silently rewrite.
    let mut doc: toml_edit::DocumentMut = text
        .parse()
        .map_err(|error| IpcError::invalid(format!("config file is not editable TOML: {error}")))?;

    let table_existed = doc.get(table_name).is_some();
    let table_item = doc.entry(table_name).or_insert(toml_edit::table());
    let table = table_item
        .as_table_mut()
        .ok_or_else(|| IpcError::invalid(format!("config: `{table_name}` is not a table")))?;
    match table.get_mut(toml_key) {
        // In-place value swap keeps the line's decor (inline `# comment`, spacing) — replacing
        // the whole Item would drop it.
        Some(existing) if existing.is_value() => {
            if let (Some(existing_value), Some(new_value)) =
                (existing.as_value_mut(), item.as_value())
            {
                let mut new_value = new_value.clone();
                *new_value.decor_mut() = existing_value.decor().clone();
                *existing_value = new_value;
            }
        }
        _ => {
            table.insert(toml_key, item);
        }
    }
    if !table_existed {
        hoist_trailing_before_new_table(&mut doc, table_name);
    }
    Ok(doc.to_string())
}

/// A table CREATED by an edit renders after the document body but BEFORE the document's
/// trailing decor — and in a comments-only file (the fully-commented [`DEFAULT_TEMPLATE`])
/// *every* comment is trailing decor, which would push the reference header underneath the new
/// table. Hoist the trailing decor into the new table's prefix so the original text stays on
/// top and the new `[table]` lands at the true end of the file.
fn hoist_trailing_before_new_table(doc: &mut toml_edit::DocumentMut, table_name: &str) {
    let trailing = doc.trailing().as_str().unwrap_or_default().to_string();
    if trailing.is_empty() {
        return;
    }
    doc.set_trailing("");
    if let Some(table) = doc.get_mut(table_name).and_then(|item| item.as_table_mut()) {
        let prefix = table
            .decor()
            .prefix()
            .and_then(toml_edit::RawString::as_str)
            .unwrap_or_default()
            .to_string();
        table.decor_mut().set_prefix(format!("{trailing}{prefix}"));
    }
}

/// `RegistryValue` → its JSON wire value (`true`, `14`, `"night"`).
fn json_value(value: &RegistryValue) -> JsonValue {
    match value {
        RegistryValue::Bool(flag) => JsonValue::Bool(*flag),
        RegistryValue::Int(number) => JsonValue::from(*number),
        RegistryValue::Str(text) => JsonValue::String(text.clone()),
    }
}

/// The `settings:changed` payload for one changed key, `source: "config-file"` — the same wire
/// shape the settings registry broadcasts for its own writes (trmx-51/53).
fn settings_changed_payload(key: &str, value: &RegistryValue) -> JsonValue {
    let mut payload = Map::new();
    payload.insert("key".to_string(), JsonValue::String(key.to_string()));
    payload.insert("value".to_string(), json_value(value));
    payload.insert(
        "source".to_string(),
        JsonValue::String("config-file".to_string()),
    );
    JsonValue::Object(payload)
}

/// The (event, payload) broadcasts for one APPLIED watcher wake (pure — trmx-80 review R2): one
/// `settings:changed` per changed pair, then ALWAYS one `config:warnings` carrying the fresh
/// warning set — INCLUDING when it is empty. The emit decision is "applied ⇒ publish", not
/// "warned ⇒ publish": once the user fixes a typo'd file, the empty set is what lets the
/// frontend clear its stale warnings banner.
fn emissions_for(application: &FileApplication) -> Vec<(&'static str, JsonValue)> {
    let mut emissions: Vec<(&'static str, JsonValue)> = application
        .changed
        .iter()
        .map(|(key, value)| ("settings:changed", settings_changed_payload(key, value)))
        .collect();
    let warnings = serde_json::to_value(&application.warnings)
        .unwrap_or_else(|_| JsonValue::Array(Vec::new()));
    emissions.push(("config:warnings", warnings));
    emissions
}

/// trmx-94 (FR-9.3): the `[keys]` map read pieces. The map is NOT a flat registry pair (it's a
/// dynamic chord→command map), so it rides its own read command + `keys:changed` watcher signal,
/// mirroring themes:changed/scripts:changed. Pure: `read_keys_from` parses text → the raw map;
/// `keys_map_changed` is the watcher's emit decision.
fn read_keys_from(text: Option<&str>) -> BTreeMap<String, String> {
    match text {
        Some(text) => parse_config(text).0.keys,
        None => BTreeMap::new(),
    }
}

/// Whether the `[keys]` map differs between two configs — the `keys:changed` emit decision. The
/// scalar `diff_configs`/`settings:changed` path is blind to the map, so the watcher needs this.
fn keys_map_changed(old: &Config, new: &Config) -> bool {
    old.keys != new.keys
}

/// What `config_read` returns to the webview.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigReadResponse {
    exists: bool,
    path: String,
    values: Map<String, JsonValue>,
    warnings: Vec<ConfigWarning>,
}

/// trmx-238 (M15): the three outcomes of reading the config file. `Option<String>` could not
/// express the middle one, which is exactly the bug: an unreadable file was indistinguishable
/// from an absent one, so the user's settings silently became "defaults" (and, on hydration,
/// re-triggered the one-time legacy-storage migration).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileRead {
    /// No such file — the legitimate first-launch case; defaults apply.
    Absent,
    /// The file is there but could not be read (EACCES, a directory in the way, an I/O error).
    /// The payload is the human-readable reason, already stringified on this (shell) side so
    /// `std::io` never enters `termixion-core`.
    Unreadable(String),
    /// The file was read.
    Text(String),
}

/// trmx-238 (M15): what a watcher wake should do with one classified read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadOutcome {
    /// Apply this text.
    Text(String),
    /// The file was absent — re-read once before believing it, because an editor saving by
    /// rename-then-create leaves a sub-millisecond window where it legitimately is not there.
    RetryAbsent,
    /// Unreadable: do nothing at all. Applying defaults would revert the user's live UI over a
    /// permissions accident, and re-reading cannot fix EACCES.
    Skip,
}

/// The PURE half of the transient-read guard (trmx-238 M15): no sleeping, no filesystem.
pub fn read_outcome(read: &FileRead) -> ReadOutcome {
    match read {
        FileRead::Text(text) => ReadOutcome::Text(text.clone()),
        FileRead::Absent => ReadOutcome::RetryAbsent,
        FileRead::Unreadable(_) => ReadOutcome::Skip,
    }
}

/// How long to wait before believing a file vanished (trmx-238 M15). Long enough to outlast an
/// editor's rename-then-create window, short enough to be invisible on a real delete.
const CONFIG_ABSENT_RETRY: Duration = Duration::from_millis(100);

/// The IMPURE half: drive [`read_outcome`], re-reading ONCE on absence. `None` = skip this wake
/// entirely; `Some(text)` = apply it (an empty string is a real delete ⇒ defaults). The single
/// `sleep` lives here so every decision above stays testable without wall-clock dependence —
/// tests drive [`wake_text_with`] with a scripted reader instead.
fn wake_text_with(mut read: impl FnMut() -> FileRead) -> Option<String> {
    match read_outcome(&read()) {
        ReadOutcome::Text(text) => Some(text),
        ReadOutcome::Skip => None,
        ReadOutcome::RetryAbsent => match read_outcome(&read()) {
            ReadOutcome::Text(text) => Some(text),
            // Still absent after the retry: a REAL delete — empty text applies defaults.
            ReadOutcome::RetryAbsent => Some(String::new()),
            ReadOutcome::Skip => None,
        },
    }
}

/// The production reader for [`wake_text_with`]: the real file, with the real 100 ms pause
/// between the two attempts.
fn wake_text(path: &Path) -> Option<String> {
    let mut attempt = 0u8;
    wake_text_with(|| {
        if attempt > 0 {
            std::thread::sleep(CONFIG_ABSENT_RETRY);
        }
        attempt += 1;
        classify_read(std::fs::read_to_string(path))
    })
}

/// trmx-238 (M15): classify one filesystem read. A named seam rather than an inline `.ok()` so
/// the absent/unreadable split is unit-testable without a filesystem.
pub fn classify_read(result: Result<String, std::io::Error>) -> FileRead {
    match result {
        Ok(text) => FileRead::Text(text),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => FileRead::Absent,
        Err(err) => FileRead::Unreadable(err.to_string()),
    }
}

/// Build the `config_read` response from one classified read (pure): registry-keyed PRESENT-ONLY
/// values plus the parse warnings. An UNREADABLE file reports `exists: true` with no values and an
/// `Unreadable` warning — the file is really there, so the frontend must NOT treat this as a
/// first launch (that would re-run the legacy-storage migration, trmx-238 M15).
fn read_response_from(read: FileRead, path: &Path) -> ConfigReadResponse {
    let path = path.display().to_string();
    let text = match read {
        FileRead::Absent => {
            return ConfigReadResponse {
                exists: false,
                path,
                values: Map::new(),
                warnings: Vec::new(),
            };
        }
        FileRead::Unreadable(message) => {
            return ConfigReadResponse {
                exists: true,
                path,
                values: Map::new(),
                warnings: vec![ConfigWarning::Unreadable { message }],
            };
        }
        FileRead::Text(text) => text,
    };
    let (pairs, warnings) = parse_registry_pairs(&text);
    let mut values = Map::new();
    for (key, value) in &pairs {
        values.insert(key.clone(), json_value(value));
    }
    ConfigReadResponse {
        exists: true,
        path,
        values,
        warnings,
    }
}

// ---------------------------------------------------------------------------
// Filesystem glue (path-parameterized so tests can drive it against a temp dir)
// ---------------------------------------------------------------------------

/// Write `contents` ATOMICALLY: temp file in the SAME directory, then `rename` over the target
/// (a reader/watcher can never observe a torn file). Creates the parent directory. Returns the
/// hash of the written text for the self-echo latch.
fn write_atomic(path: &Path, contents: &str) -> Result<u64, IpcError> {
    let parent = path
        .parent()
        // A path WE construct having no parent is our invariant, not the caller's mistake.
        .ok_or_else(|| {
            IpcError::internal(format!(
                "config path has no parent directory: {}",
                path.display()
            ))
        })?;
    std::fs::create_dir_all(parent)
        .map_err(|error| IpcError::io(format!("could not create {}: {error}", parent.display())))?;
    // Same directory as the target so the rename is same-filesystem (atomic); pid-suffixed so
    // two Termixion processes can never collide on it.
    let temp = parent.join(format!(".{CONFIG_FILE_NAME}.tmp-{}", std::process::id()));
    std::fs::write(&temp, contents)
        .map_err(|error| IpcError::io(format!("could not write {}: {error}", temp.display())))?;
    if let Err(error) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp); // best-effort: never leave residue behind
        return Err(IpcError::io(format!(
            "could not replace {}: {error}",
            path.display()
        )));
    }
    Ok(text_hash(contents))
}

/// Read the file (absent → template) and edit `key` into it — the lazy file creation: the first
/// write materializes the fully-commented [`DEFAULT_TEMPLATE`] so the user's file always carries
/// the reference header. Returns the written text's hash + its parsed config for the state.
fn write_key_at(
    path: &Path,
    key: &str,
    value: &JsonValue,
) -> Result<(u64, Config, Vec<ConfigWarning>), IpcError> {
    let current = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => DEFAULT_TEMPLATE.to_string(),
        Err(error) => {
            return Err(IpcError::io(format!(
                "could not read {}: {error}",
                path.display()
            )));
        }
    };
    let edited = edit_document(&current, key, value)?;
    let hash = write_atomic(path, &edited)?;
    let (config, warnings) = parse_config(&edited);
    Ok((hash, config, warnings))
}

/// Reset the file to the pristine [`DEFAULT_TEMPLATE`], atomically. Returns the written hash.
fn reset_all_at(path: &Path) -> Result<u64, IpcError> {
    write_atomic(path, DEFAULT_TEMPLATE)
}

/// trmx-148: ensure the file EXISTS without touching existing content — present → `Ok(false)`,
/// bytes untouched; absent → materialize the fully-commented [`DEFAULT_TEMPLATE`] atomically →
/// `Ok(true)`. The write's hash is deliberately dropped (never latched) — see
/// [`config_open_file`] for why.
fn ensure_config_file_at(path: &Path) -> Result<bool, IpcError> {
    match std::fs::metadata(path) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            write_atomic(path, DEFAULT_TEMPLATE)?;
            Ok(true)
        }
        Err(error) => Err(IpcError::io(format!(
            "could not read {}: {error}",
            path.display()
        ))),
    }
}

/// trmx-205: the warning set a surface (config_read response / watcher emission / spawn
/// re-emission) publishes: the PARSE-ONLY base plus at most ONE fresh shell-validity warning.
/// Every publisher derives from a parse-only base through this one function, so the shell
/// warning can never stack no matter how many times a surface re-emits (pure, testable).
fn warnings_for_surface(
    parse: &[ConfigWarning],
    config: &Config,
    valid: impl Fn(&str) -> bool,
    enhancements: &EnhancementsStatus,
    unreadable: Option<&str>,
) -> Vec<ConfigWarning> {
    let mut out = parse.to_vec();
    // trmx-238 (M15): synthesized on EVERY rebuild from the tracked read health, so an unrelated
    // re-emission cannot clear it — and so it self-clears the moment a read succeeds.
    if let Some(message) = unreadable {
        out.push(ConfigWarning::Unreadable {
            message: message.to_string(),
        });
    }
    if let Some(warning) = shell_validity_warning(config, valid) {
        out.push(warning);
    }
    // trmx-238 (M18/D3): the enhancement verdict is SYNTHESIZED here rather than cached into
    // `last_warnings`, for the same reason the shell warning is (trmx-205): this ledger is
    // rebuilt wholesale on every read and every watcher wake, so a cached entry would either
    // stack duplicates or — worse — be erased by the next unrelated config broadcast. Synthesizing
    // makes it survive every rebuild AND self-clear the moment the status recovers.
    if let EnhancementsStatus::Unavailable { reason } = enhancements {
        out.push(ConfigWarning::EnhancementsUnavailable {
            reason: reason.clone(),
        });
    }
    out
}

/// trmx-205: the IMPURE validity warning for a configured shell. `None` for the empty (System
/// default) value or a path that passes the probe; otherwise an `InvalidValue` shaped exactly
/// like the parser's own warnings so it rides the existing `config:warnings` surface unchanged.
fn shell_validity_warning(config: &Config, valid: impl Fn(&str) -> bool) -> Option<ConfigWarning> {
    let shell = config.terminal.shell.as_str();
    if shell.is_empty() || valid(shell) {
        return None;
    }
    Some(ConfigWarning::InvalidValue {
        key: "terminal.shell".to_string(),
        got: format!("\"{shell}\""),
        expected:
            "an absolute path to an executable shell (new sessions fall back to the system default)"
                .to_string(),
    })
}

/// trmx-205: the configured shell for the spawn path — `None` for empty/unset (System default).
/// Reads the cached `last` config; before the first `config_read`/watch apply this is the
/// default (empty), which is benign: the frontend hydrates before any terminal mounts.
/// trmx-206: the [shell] enhancement config for the spawn path (defaults before hydration —
/// benign for the same reason as configured_shell below).
pub fn shell_config(state: &ConfigState) -> termixion_core::config::ShellConfig {
    state
        .0
        .lock()
        .ok()
        .map(|inner| inner.last.shell.clone())
        .unwrap_or_default()
}

pub fn configured_shell(state: &ConfigState) -> Option<String> {
    state
        .0
        .lock()
        .ok()
        .map(|inner| inner.last.terminal.shell.clone())
        .filter(|shell| !shell.is_empty())
}

/// trmx-205: best-effort re-emission of `config:warnings` when a spawn falls back because the
/// configured shell turned invalid AFTER the last read/watch (uninstalled — no file change, so
/// no watcher wake). Cached parse warnings + the fresh shell warning; emit failure never fails
/// the spawn.
pub fn emit_shell_fallback_warning(
    app: &tauri::AppHandle,
    state: &ConfigState,
    valid: impl Fn(&str) -> bool,
) {
    emit_config_warnings_with(app, state, valid);
}

/// trmx-238 (M18): re-publish the CURRENT warning surface. Extracted from
/// [`emit_shell_fallback_warning`] so an enhancement-status transition can refresh the banner and
/// the main-window badge without waiting for an unrelated config event.
pub fn emit_config_warnings(app: &tauri::AppHandle, state: &ConfigState) {
    emit_config_warnings_with(app, state, crate::shells_io::is_executable_file);
}

fn emit_config_warnings_with(
    app: &tauri::AppHandle,
    state: &ConfigState,
    valid: impl Fn(&str) -> bool,
) {
    let Ok(inner) = state.0.lock() else { return };
    let warnings = warnings_for_surface(
        &inner.last_warnings,
        &inner.last,
        valid,
        &enhancements_status_of(app),
        inner.last_unreadable.as_deref(),
    );
    drop(inner);
    let payload = serde_json::to_value(&warnings).unwrap_or_else(|_| JsonValue::Array(Vec::new()));
    let _ = app.emit("config:warnings", payload);
}

/// The app's recorded enhancement status, or `NotObserved` before the state is managed (every
/// unit test and the earliest start-up moments).
fn enhancements_status_of(app: &tauri::AppHandle) -> EnhancementsStatus {
    app.try_state::<crate::enhancements_io::EnhancementsState>()
        .map(|state| crate::enhancements_io::read_status(&state))
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Read the config file for the frontend registry: present-only registry-keyed values +
/// warnings. Also (re)bases the watcher's diff state on what was read.
#[tauri::command]
pub fn config_read(app: tauri::AppHandle, state: State<'_, ConfigState>) -> ConfigReadResponse {
    let path = config_path();
    // trmx-238 (M15): classify, never `.ok()` — an unreadable file must not masquerade as absent.
    let read = classify_read(std::fs::read_to_string(&path));
    let text = match &read {
        FileRead::Text(text) => text.clone(),
        FileRead::Absent | FileRead::Unreadable(_) => String::new(),
    };
    let mut response = read_response_from(read, &path);
    // trmx-238 (M15/D4): the Unreadable warning is SYNTHESIZED from the tracked read health, never
    // cached into `last_warnings` — it describes this READ, not a parse. Recording it on the state
    // (rather than splicing it onto this one response) is what keeps it alive across the wholesale
    // rebuilds every later re-emission performs.
    let unreadable: Option<String> = response.warnings.iter().find_map(|w| match w {
        ConfigWarning::Unreadable { message } => Some(message.clone()),
        _ => None,
    });
    let (config, _) = parse_config(&text);
    // trmx-205: the cached base stays PARSE-ONLY (the spawn-time re-emission recomputes the
    // shell check freshly over it — caching the synthesized warning would stack duplicates);
    // the published response carries parse + at most one fresh shell warning.
    let parse_warnings: Vec<ConfigWarning> = response
        .warnings
        .iter()
        .filter(|w| !matches!(w, ConfigWarning::Unreadable { .. }))
        .cloned()
        .collect();
    response.warnings = warnings_for_surface(
        &parse_warnings,
        &config,
        crate::shells_io::is_executable_file,
        &enhancements_status_of(&app),
        unreadable.as_deref(),
    );
    match state.0.lock() {
        Ok(mut inner) => {
            inner.last = config;
            inner.last_warnings = parse_warnings;
            inner.last_unreadable = unreadable;
        }
        Err(_) => log::warn!("termixion: config state poisoned; skipping diff-base update"),
    }
    response
}

/// trmx-94 (FR-9.3): read the `[keys]` map for the frontend keymap (chord → command id, or `"none"`).
/// A missing file is an empty map. Re-read by the frontend on the `keys:changed` watcher signal.
#[tauri::command]
pub fn keys_read() -> BTreeMap<String, String> {
    let text = std::fs::read_to_string(config_path()).ok();
    read_keys_from(text.as_deref())
}

/// Persist one registry-keyed setting into the config file (comment-preserving, atomic,
/// lazily creating the file from the commented template).
#[tauri::command]
pub fn config_write(
    app: tauri::AppHandle,
    state: State<'_, ConfigState>,
    control_state: State<'_, crate::control::ControlState>,
    key: String,
    value: JsonValue,
) -> Result<(), IpcError> {
    let (hash, config, parse_warnings) = write_key_at(&config_path(), &key, &value)?;
    // trmx-101: an app-originated write suppresses the watcher's self-echo, so apply remote_control here.
    let new_remote_control = config.remote_control.clone();
    let mut inner = state
        .0
        .lock()
        .map_err(|_| IpcError::internal("config state poisoned"))?;
    inner.last_write_hash = Some(hash);
    inner.last = config;
    // trmx-205: keep the parse-only warnings cache fresh across local writes, so a later
    // spawn-time re-emission reflects the just-written file, not a stale read.
    inner.last_warnings = parse_warnings;
    drop(inner);
    crate::control::apply_remote_control(&app, &new_remote_control, &control_state);
    Ok(())
}

/// Reset the config file to the pristine commented template (every key back to its default).
#[tauri::command]
pub fn config_reset_all(
    app: tauri::AppHandle,
    state: State<'_, ConfigState>,
    control_state: State<'_, crate::control::ControlState>,
) -> Result<(), IpcError> {
    let hash = reset_all_at(&config_path())?;
    let mut inner = state
        .0
        .lock()
        .map_err(|_| IpcError::internal("config state poisoned"))?;
    inner.last_write_hash = Some(hash);
    inner.last = Config::default();
    inner.last_warnings = Vec::new(); // trmx-205: pristine template ⇒ no stale warning base
    drop(inner);
    // A reset restores every default → remote control OFF.
    crate::control::apply_remote_control(&app, &Config::default().remote_control, &control_state);
    Ok(())
}

/// trmx-148: the About page's "Open config file" row — materialize the file if absent (so the
/// OS always has something to open), then open it in the default editor via the opener plugin,
/// backend-side like [`crate::themes_io::themes_open_dir`] (the webview's own `openPath` command
/// is capability-denied).
#[tauri::command]
pub fn config_open_file(app: tauri::AppHandle) -> Result<(), IpcError> {
    let path = config_path();
    // Deliberately NO ConfigState touch (no last_write_hash latch, no diff-base update): the
    // watcher must observe the materialization write and apply it normally — the template parses
    // to pure defaults, and latching would wrongly suppress the default-state transition after
    // an external delete.
    ensure_config_file_at(&path)?;
    app.opener()
        .open_path(path.display().to_string(), None::<&str>)
        .map_err(|error| IpcError::io(format!("could not open {}: {error}", path.display())))
}

// ---------------------------------------------------------------------------
// The file watcher (spawned once from `setup`, like the title poller)
// ---------------------------------------------------------------------------

/// Quiet period after the last filesystem event before the file is (re)read: editors save via
/// write-temp + rename bursts, and one coalesced apply beats N intermediate ones.
const CONFIG_DEBOUNCE: Duration = Duration::from_millis(250);

/// Watch the config file's PARENT DIRECTORY for changes and live-apply them. Watching the dir
/// (not the file) survives the rename-replace dance editors and our own atomic writes do.
/// Best-effort decoration like the title poller: any setup failure logs and disables watching
/// rather than failing the app.
pub fn run_config_watcher(app: tauri::AppHandle) {
    let Some(spec) = config_watch_spec() else {
        log::warn!("termixion: config path has no parent; config file watching disabled");
        return;
    };
    // Ensure the directory exists so the watch can attach before the first lazy write
    // (create_dir_all is harmless — it creates no file).
    if let Err(err) = std::fs::create_dir_all(&spec.dir) {
        log::warn!(
            "termixion: could not create {}: {err}; config file watching disabled",
            spec.dir.display()
        );
        return;
    }
    let path = config_path();
    crate::fs_watch::run_debounced(&spec, || on_config_file_event(&app, &path));
}

/// trmx-238 (L7): this watcher's parameters, named so a unit test can pin them without starting a
/// watcher. We watch the config file's PARENT (`NonRecursive`) because editors replace the file by
/// rename; the filter keeps the temp-file traffic of atomic writes (ours and editors') out.
pub fn config_watch_spec() -> Option<crate::fs_watch::WatchSpec> {
    let parent = config_path().parent().map(Path::to_path_buf)?;
    Some(crate::fs_watch::WatchSpec {
        dir: parent,
        mode: notify::RecursiveMode::NonRecursive,
        debounce: CONFIG_DEBOUNCE,
        filter: std::sync::Arc::new(is_config_file),
    })
}

/// The config watcher's path filter: only `termixion.toml` itself counts.
fn is_config_file(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name == CONFIG_FILE_NAME)
}

/// One debounced watcher wake: read the file (unreadable/absent → empty text → pure defaults),
/// run the pure [`apply_file_text`] decision, and broadcast the outcome.
fn on_config_file_event(app: &tauri::AppHandle, path: &Path) {
    // trmx-238 (M15): an unreadable file skips the wake outright, and a briefly-absent one is
    // re-read once before we believe it — `unwrap_or_default()` used to turn both into "" and
    // broadcast a full revert-to-defaults over the user's live UI.
    let Some(text) = wake_text(path) else {
        return;
    };
    let state = app.state::<ConfigState>();
    let Ok(mut inner) = state.0.lock() else {
        log::warn!("termixion: config state poisoned; dropping a config file event");
        return;
    };
    let Some(application) = apply_file_text(&text, &inner.last, inner.last_write_hash) else {
        return; // self-echo of our own write (D6)
    };
    // trmx-205: publish parse + at most one fresh shell warning; the cached base stays
    // PARSE-ONLY so the spawn-time re-emission can never stack duplicates.
    let mut application = application;
    let parse_warnings = application.warnings.clone();
    // A wake only reaches here when the file was READ (wake_text returns None for unreadable), so
    // the read health is provably clear — record that, or a stale Unreadable would outlive the fix.
    inner.last_unreadable = None;
    application.warnings = warnings_for_surface(
        &parse_warnings,
        &application.config,
        crate::shells_io::is_executable_file,
        &enhancements_status_of(app),
        None,
    );
    // The pure decision, computed before `application.config` moves into the diff base.
    let mut emissions = emissions_for(&application);
    // trmx-94: the scalar diff/settings:changed path is blind to the [keys] map — emit a bare
    // keys:changed when the map changed so the frontend re-reads the effective keymap (live rebind).
    if keys_map_changed(&inner.last, &application.config) {
        emissions.push(("keys:changed", JsonValue::Null));
    }
    // trmx-101: capture the new remote-control config before `application.config` moves into `last`, so
    // the socket listener is (re)started/stopped AFTER the config lock is released (never held across it).
    let new_remote_control = application.config.remote_control.clone();
    inner.last_warnings = parse_warnings;
    inner.last = application.config;
    // An EXTERNAL edit was applied: clear the self-echo latch so a stale hash can never
    // suppress a later external edit that happens to restore our last-written bytes.
    inner.last_write_hash = None;
    drop(inner);
    // Rides the trmx-51/53 live-apply plumbing — settings:changed per changed pair, then the
    // warning set EVEN WHEN EMPTY (emissions_for); best-effort like session:title-hint (a
    // webview may be mid-teardown).
    for (event, payload) in emissions {
        let _ = app.emit(event, payload);
    }
    // trmx-101 (FR-9.4): an external edit to remote_control.enabled starts/stops the socket live.
    crate::control::apply_remote_control(
        app,
        &new_remote_control,
        &app.state::<crate::control::ControlState>(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc_error::IpcErrorKind;
    use serde_json::json;
    // trmx-244: diff_configs moved out of this module's production path with apply_file_text; only
    // this suite's keys-map test still needs it, so it is imported here rather than crate-wide.
    use termixion_core::diff_configs;

    // --- path resolution -----------------------------------------------------------------

    #[test]
    fn config_path_prefers_a_non_empty_xdg_config_home() {
        assert_eq!(
            config_path_from(Some("/custom/xdg"), "/Users/me"),
            PathBuf::from("/custom/xdg/termixion/termixion.toml")
        );
    }

    #[test]
    fn config_path_falls_back_to_home_dot_config_when_xdg_unset() {
        assert_eq!(
            config_path_from(None, "/Users/me"),
            PathBuf::from("/Users/me/.config/termixion/termixion.toml")
        );
    }

    #[test]
    fn config_path_treats_an_empty_xdg_as_unset() {
        assert_eq!(
            config_path_from(Some(""), "/Users/me"),
            PathBuf::from("/Users/me/.config/termixion/termixion.toml")
        );
    }

    // --- echo suppression ----------------------------------------------------------------

    // --- the pure watcher decision ---------------------------------------------------------

    // trmx-94: the [keys] read + the keys:changed emit decision (the map is invisible to the scalar
    // diff, so the watcher needs keys_map_changed).
    #[test]
    fn read_keys_from_parses_the_map_and_missing_is_empty() {
        assert!(read_keys_from(None).is_empty());
        let keys = read_keys_from(Some(
            "[keys]\n\"cmd+d\" = \"pane.split-below\"\n\"cmd+j\" = \"none\"\n",
        ));
        assert_eq!(keys.get("cmd+d"), Some(&"pane.split-below".to_string()));
        assert_eq!(keys.get("cmd+j"), Some(&"none".to_string()));
    }

    #[test]
    fn keys_map_changed_detects_a_binding_edit_the_scalar_diff_misses() {
        let old = parse_config("[terminal]\nfont_size = 12\n").0;
        // Same scalars, but a [keys] entry added → scalar diff is empty, keys_map_changed is true.
        let new =
            parse_config("[terminal]\nfont_size = 12\n[keys]\n\"cmd+d\" = \"pane.split-below\"\n")
                .0;
        assert!(diff_configs(&old, &new).is_empty(), "no scalar changed");
        assert!(keys_map_changed(&old, &new), "the [keys] map changed");
        assert!(
            !keys_map_changed(&new, &new),
            "identical maps do not change"
        );
    }

    // --- edit_document (the pure write logic) ----------------------------------------------

    /// Comments + custom key order + an unknown key toml_edit must not touch.
    const FIXTURE: &str = "# my config header\n\n[appearance]\ntheme = \"night\" # the theme\n\n[terminal]\nfont_size = 14 # points\ncursor_blink = true\n";

    #[test]
    fn edit_document_preserves_comments_and_key_order() {
        let edited = edit_document(FIXTURE, "terminal.fontSize", &json!(16)).expect("edit");
        assert!(edited.contains("# my config header"), "{edited}");
        assert!(edited.contains("# the theme"), "{edited}");
        assert!(edited.contains("# points"), "inline comment lost: {edited}");
        assert!(edited.contains("font_size = 16"), "{edited}");
        assert!(edited.contains("cursor_blink = true"), "{edited}");
        let appearance = edited.find("[appearance]").expect("[appearance] kept");
        let terminal = edited.find("[terminal]").expect("[terminal] kept");
        assert!(
            appearance < terminal,
            "custom table order must be preserved: {edited}"
        );
        let (config, warnings) = parse_config(&edited);
        assert_eq!(config.terminal.font_size, 16);
        assert_eq!(warnings, Vec::new());
    }

    #[test]
    fn edit_document_creates_a_missing_table() {
        let text = "[appearance]\ntheme = \"night\"\n";
        let edited = edit_document(text, "terminal.fontSize", &json!(14)).expect("edit");
        assert!(edited.contains("[terminal]"), "{edited}");
        let (pairs, warnings) = parse_registry_pairs(&edited);
        assert_eq!(warnings, Vec::new());
        assert_eq!(pairs.len(), 2, "{edited}");
        assert!(
            pairs.contains(&("terminal.fontSize".to_string(), RegistryValue::Int(14))),
            "{edited}"
        );
        assert!(pairs.contains(&(
            "appearance.theme".to_string(),
            RegistryValue::Str("night".to_string())
        )));
    }

    #[test]
    fn edit_document_on_the_default_template_keeps_its_header() {
        // The lazy-created file starts from DEFAULT_TEMPLATE; the first write must keep the
        // commented reference header intact.
        let edited =
            edit_document(DEFAULT_TEMPLATE, "appearance.theme", &json!("night")).expect("edit");
        assert!(
            edited.starts_with("# Termixion configuration (TOML)."),
            "{edited}"
        );
        assert!(edited.contains("docs/config.md"), "{edited}");
        let (pairs, warnings) = parse_registry_pairs(&edited);
        assert_eq!(warnings, Vec::new());
        assert_eq!(
            pairs,
            vec![(
                "appearance.theme".to_string(),
                RegistryValue::Str("night".to_string())
            )]
        );
    }

    #[test]
    fn edit_document_writes_every_value_class_round_trip() {
        // bool, int, and string (incl. enum-valued strings) all land in the right TOML type.
        let step1 = edit_document("", "update.autoCheck", &json!(false)).expect("bool");
        let step2 = edit_document(&step1, "terminal.scrollbackLines", &json!(5000)).expect("int");
        let step3 = edit_document(&step2, "update.checkFrequency", &json!("weekly")).expect("str");
        let (config, warnings) = parse_config(&step3);
        assert_eq!(warnings, Vec::new(), "{step3}");
        assert!(!config.update.auto_check);
        assert_eq!(config.terminal.scrollback_lines, 5000);
        assert_eq!(
            config.update.check_frequency,
            termixion_core::config::CheckFrequency::Weekly
        );
    }

    #[test]
    fn edit_document_persists_terminal_shell() {
        // trmx-205 write-path lockstep: the registry key routes through value_kind_for
        // (ValueKind::Str) into a comment-preserving [terminal] shell = "…" edit.
        let out = edit_document(
            "# my config\n[terminal]\nfont_size = 14\n",
            "terminal.shell",
            &JsonValue::String("/opt/homebrew/bin/bash".to_string()),
        )
        .expect("writes");
        assert!(out.contains("# my config"));
        assert!(out.contains("shell = \"/opt/homebrew/bin/bash\""));
        let (config, warnings) = parse_config(&out);
        assert_eq!(config.terminal.shell, "/opt/homebrew/bin/bash");
        assert_eq!(warnings, Vec::new());
    }

    #[test]
    fn spawn_reemission_never_stacks_the_shell_warning() {
        // Step-8 finding: every publisher derives from a PARSE-ONLY base through
        // warnings_for_surface, so re-deriving any number of times yields exactly one
        // terminal.shell warning — never two.
        let mut config = Config::default();
        config.terminal.shell = "/bin/gone".to_string();
        let parse_only = vec![ConfigWarning::InvalidValue {
            key: "terminal.font_size".to_string(),
            got: "\"big\"".to_string(),
            expected: "an integer".to_string(),
        }];
        let first = warnings_for_surface(
            &parse_only,
            &config,
            |_| false,
            &EnhancementsStatus::NotObserved,
            None,
        );
        assert_eq!(first.len(), 2); // the parse warning + ONE shell warning
        // A second derivation from the same parse-only base (the spawn re-emission) is
        // identical — deriving from `first` would be the stacking bug.
        let second = warnings_for_surface(
            &parse_only,
            &config,
            |_| false,
            &EnhancementsStatus::NotObserved,
            None,
        );
        assert_eq!(second, first);
        let shell_count = second
            .iter()
            .filter(
                |w| matches!(w, ConfigWarning::InvalidValue { key, .. } if key == "terminal.shell"),
            )
            .count();
        assert_eq!(shell_count, 1);
        // A fixed shell clears it wholesale.
        config.terminal.shell = String::new();
        assert_eq!(
            warnings_for_surface(
                &parse_only,
                &config,
                |_| false,
                &EnhancementsStatus::NotObserved,
                None
            ),
            parse_only
        );
    }

    #[test]
    fn write_key_at_returns_the_parse_warnings_of_the_written_file() {
        // trmx-205: config_write refreshes the parse-only cache from the just-written text.
        let dir = test_dir("shell-write-warnings");
        let path = dir.join("termixion.toml");
        let (_, config, warnings) = write_key_at(
            &path,
            "terminal.shell",
            &JsonValue::String("/bin/zsh".into()),
        )
        .expect("writes");
        assert_eq!(config.terminal.shell, "/bin/zsh");
        assert_eq!(warnings, Vec::new()); // a clean write parses warning-free
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn shell_validity_warning_fires_only_for_nonempty_invalid_values() {
        // trmx-205: "" (System default) and probe-passing paths are silent; anything else warns
        // with the parser's own InvalidValue shape (same warnings surface, zero new frontend).
        let mut config = Config::default();
        assert_eq!(shell_validity_warning(&config, |_| false), None);
        config.terminal.shell = "/bin/zsh".to_string();
        assert_eq!(shell_validity_warning(&config, |_| true), None);
        config.terminal.shell = "/bin/gone".to_string();
        let warning = shell_validity_warning(&config, |_| false).expect("warns");
        assert!(matches!(
            &warning,
            ConfigWarning::InvalidValue { key, .. } if key == "terminal.shell"
        ));
    }

    #[test]
    fn watcher_wake_surfaces_and_clears_the_invalid_shell_warning() {
        // trmx-205 lifecycle: an external edit to an invalid shell path joins that wake's
        // config:warnings emission; a later valid/empty edit recomputes wholesale and clears it.
        let mut application = apply_file_text(
            "[terminal]\nshell = \"/bin/gone\"\n",
            &Config::default(),
            None,
        )
        .expect("applies");
        if let Some(warning) = shell_validity_warning(&application.config, |_| false) {
            application.warnings.push(warning);
        }
        let emissions = emissions_for(&application);
        let warnings_payload = &emissions.last().expect("has warnings emission").1;
        assert!(warnings_payload.to_string().contains("terminal.shell"));

        let mut cleared = apply_file_text("[terminal]\nshell = \"\"\n", &application.config, None)
            .expect("applies");
        if let Some(warning) = shell_validity_warning(&cleared.config, |_| false) {
            cleared.warnings.push(warning);
        }
        let emissions = emissions_for(&cleared);
        assert_eq!(emissions.last().expect("emission").1, serde_json::json!([]));
    }

    #[test]
    fn edit_document_rejects_a_wrong_json_type_for_the_key() {
        // Wrong JSON type per class → Err, and the text is never produced (no write).
        for (key, value) in [
            ("terminal.fontSize", json!("big")),
            ("terminal.fontSize", json!(true)),
            ("terminal.cursorBlink", json!(1)),
            ("terminal.cursorBlink", json!("yes")),
            ("appearance.theme", json!(true)),
            ("appearance.theme", json!(3)),
            ("appearance.theme", json!(null)),
            ("terminal.fontSize", json!([14])),
        ] {
            let result = edit_document(FIXTURE, key, &value);
            let err = result.expect_err(&format!("{key} = {value} must be rejected"));
            assert!(err.message.contains(key), "error must name the key: {err}");
        }
    }

    #[test]
    fn edit_document_rejects_a_float_for_an_integer_key() {
        let err = edit_document(FIXTURE, "terminal.fontSize", &json!(12.5))
            .expect_err("a fractional font size must be rejected");
        assert!(err.message.contains("terminal.fontSize"), "{err}");
    }

    #[test]
    fn edit_document_rejects_an_unknown_key() {
        let err = edit_document(FIXTURE, "nope.key", &json!(1)).expect_err("unknown key");
        assert!(
            err.message.contains("nope.key"),
            "error must name the key: {err}"
        );
        let err = edit_document(FIXTURE, "terminal.font_size", &json!(14))
            .expect_err("TOML spelling is not a registry key");
        assert!(err.message.contains("terminal.font_size"), "{err}");
    }

    #[test]
    fn edit_document_refuses_to_clobber_unparseable_toml() {
        // A syntactically broken file cannot be comment-preservingly edited; refusing beats
        // silently rewriting (and losing) whatever the user had.
        let err = edit_document("[terminal\nfont_size=", "terminal.fontSize", &json!(14))
            .expect_err("broken TOML must not be clobbered");
        assert!(!err.message.is_empty());
    }

    #[test]
    fn value_kind_covers_exactly_the_registry_keys() {
        // The shell-side type gate must stay in lockstep with core's key map.
        let keys = [
            ("update.autoCheck", ValueKind::Bool),
            ("update.checkFrequency", ValueKind::Str),
            ("update.autoDownload", ValueKind::Bool),
            ("terminal.cursorStyle", ValueKind::Str),
            ("terminal.cursorBlink", ValueKind::Bool),
            ("terminal.activityIndicator", ValueKind::Bool),
            ("terminal.copyOnSelect", ValueKind::Bool),
            ("terminal.focusFollowsMouse", ValueKind::Bool),
            ("terminal.confirmClose", ValueKind::Str),
            ("terminal.clipboardWrite", ValueKind::Str), // trmx-252
            ("terminal.scrollbackLines", ValueKind::Int),
            ("terminal.fontFamily", ValueKind::Str),
            ("terminal.shell", ValueKind::Str),      // trmx-205
            ("shell.enhancements", ValueKind::Bool), // trmx-206
            ("shell.autosuggestions", ValueKind::Bool),
            ("shell.syntaxHighlighting", ValueKind::Bool),
            ("shell.prompt", ValueKind::Str), // trmx-207
            ("terminal.fontSize", ValueKind::Int),
            ("appearance.theme", ValueKind::Str),
            ("tabs.barPosition", ValueKind::Str),
            ("tabs.sideLabelOrientation", ValueKind::Str),
            ("tabs.showShortcutHints", ValueKind::Bool), // trmx-151
            ("titleBar.aiCounter", ValueKind::Bool),     // trmx-190
            ("scripts.startup", ValueKind::Str),
            ("remote_control.enabled", ValueKind::Bool),
            ("remote_control.socketPath", ValueKind::Str),
        ];
        for (key, kind) in keys {
            assert_eq!(value_kind_for(key), Some(kind), "for {key}");
            assert!(
                toml_path_for(key).is_some(),
                "core must know {key} too (lockstep)"
            );
        }
        assert_eq!(value_kind_for("junk"), None);
        assert_eq!(value_kind_for("terminal.font_size"), None);
    }

    // --- read_response_from ------------------------------------------------------------------

    #[test]
    fn read_response_for_a_missing_file_is_exists_false_with_no_values() {
        let response = read_response_from(FileRead::Absent, Path::new("/tmp/x/termixion.toml"));
        let value = serde_json::to_value(&response).expect("serializes");
        assert_eq!(
            value,
            json!({
                "exists": false,
                "path": "/tmp/x/termixion.toml",
                "values": {},
                "warnings": [],
            })
        );
    }

    #[test]
    fn read_response_values_are_registry_keyed_and_present_only() {
        let response = read_response_from(
            FileRead::Text("[terminal]\nfont_size = 14\ncursor_blink = true\n".to_string()),
            Path::new("/tmp/x/termixion.toml"),
        );
        let value = serde_json::to_value(&response).expect("serializes");
        assert_eq!(
            value,
            json!({
                "exists": true,
                "path": "/tmp/x/termixion.toml",
                "values": { "terminal.fontSize": 14, "terminal.cursorBlink": true },
                "warnings": [],
            })
        );
    }

    #[test]
    fn read_response_carries_typed_warnings() {
        let response = read_response_from(
            FileRead::Text("[terminal]\nfont_sise = 13\n".to_string()),
            Path::new("/tmp/x/termixion.toml"),
        );
        let value = serde_json::to_value(&response).expect("serializes");
        assert_eq!(
            value,
            json!({
                "exists": true,
                "path": "/tmp/x/termixion.toml",
                "values": {},
                "warnings": [ { "type": "UnknownKey", "key": "terminal.font_sise" } ],
            })
        );
    }

    // trmx-238 (M18/D3): an enhancement failure rides the SAME config:warnings surface as the
    // parse warnings, and it must SURVIVE the wholesale rebuild that surface does on every read
    // and every watcher wake — which is why it is synthesized here rather than cached.
    #[test]
    fn an_unavailable_enhancement_status_is_synthesized_into_the_warning_surface() {
        let config = Config::default();
        let down = EnhancementsStatus::Unavailable {
            reason: "plugins dir is read-only".to_string(),
        };
        let surfaced = warnings_for_surface(&[], &config, |_| true, &down, None);
        assert_eq!(
            surfaced,
            vec![ConfigWarning::EnhancementsUnavailable {
                reason: "plugins dir is read-only".to_string()
            }]
        );
        // Deriving again from the same (parse-only, empty) base is identical — no stacking.
        assert_eq!(
            warnings_for_surface(&[], &config, |_| true, &down, None),
            surfaced
        );

        // Recovery self-clears: nothing cached means nothing to evict.
        for recovered in [EnhancementsStatus::Active, EnhancementsStatus::NotObserved] {
            assert!(
                warnings_for_surface(&[], &config, |_| true, &recovered, None).is_empty(),
                "a recovered status must stop being surfaced ({recovered:?})"
            );
        }
    }

    // trmx-238 (M15) REGRESSION (step-8 finding 1): the warning surface is rebuilt WHOLESALE on
    // every read, wake and re-emission. An earlier revision spliced the Unreadable warning onto
    // the config_read response only, so the very next unrelated re-emission — an enhancement-status
    // transition, a shell fallback — published a set without it and silently cleared the banner
    // while the file was still unreadable. It must be synthesized from the tracked read health.
    #[test]
    fn an_unreadable_file_keeps_warning_across_an_unrelated_re_emission() {
        let config = Config::default();
        let unreadable = Some("Permission denied (os error 13)");
        let has_unreadable = |set: &[ConfigWarning]| {
            set.iter()
                .any(|w| matches!(w, ConfigWarning::Unreadable { .. }))
        };

        // The read itself surfaces it...
        let first = warnings_for_surface(
            &[],
            &config,
            |_| true,
            &EnhancementsStatus::NotObserved,
            unreadable,
        );
        assert!(has_unreadable(&first));

        // ...and so does a rebuild triggered by something else entirely, while the file is still
        // unreadable. This is the assertion the old splice-onto-the-response design failed.
        let reemitted = warnings_for_surface(
            &[],
            &config,
            |_| true,
            &EnhancementsStatus::Unavailable {
                reason: "plugins dir is read-only".to_string(),
            },
            unreadable,
        );
        assert!(has_unreadable(&reemitted), "{reemitted:?}");
        assert!(
            reemitted
                .iter()
                .any(|w| matches!(w, ConfigWarning::EnhancementsUnavailable { .. })),
            "both degraded modes coexist: {reemitted:?}"
        );

        // A successful read clears the health, and the warning stops being synthesized.
        assert!(!has_unreadable(&warnings_for_surface(
            &[],
            &config,
            |_| true,
            &EnhancementsStatus::NotObserved,
            None
        )));
    }

    // --- trmx-238 (M15): absent vs unreadable ------------------------------------------------

    #[test]
    fn classify_read_separates_absent_from_unreadable() {
        use std::io::{Error, ErrorKind};
        assert_eq!(
            classify_read(Ok("x = 1\n".to_string())),
            FileRead::Text("x = 1\n".to_string())
        );
        // An absent file legitimately means "defaults" — the pre-FR-13 first-launch case.
        assert_eq!(
            classify_read(Err(Error::from(ErrorKind::NotFound))),
            FileRead::Absent
        );
        // EACCES / a directory in the way / any other I/O error means the user's settings exist
        // and are NOT in effect. Collapsing this into Absent is the M15 bug.
        match classify_read(Err(Error::new(ErrorKind::PermissionDenied, "boom"))) {
            FileRead::Unreadable(message) => assert!(message.contains("boom"), "{message}"),
            other => panic!("EACCES must classify as Unreadable, got {other:?}"),
        }
    }

    #[test]
    fn read_response_for_an_unreadable_file_reports_exists_true_and_warns() {
        // exists:true is load-bearing beyond the warning: hydrateSettings runs the legacy
        // localStorage migration ONLY when the file does not exist, so reporting false here
        // would silently re-run a one-time migration over a merely unreadable file.
        let response = read_response_from(
            FileRead::Unreadable("Permission denied (os error 13)".to_string()),
            Path::new("/tmp/x/termixion.toml"),
        );
        let value = serde_json::to_value(&response).expect("serializes");
        assert_eq!(
            value,
            json!({
                "exists": true,
                "path": "/tmp/x/termixion.toml",
                "values": {},
                "warnings": [
                    { "type": "Unreadable", "message": "Permission denied (os error 13)" }
                ],
            })
        );
    }

    // trmx-238 (L7): pin this watcher's parameters across the dedupe. Its wake ACTION is
    // `on_config_file_event`, already covered by the transient-read-guard tests below.
    #[test]
    fn config_watch_spec_watches_the_parent_dir_for_termixion_toml_only() {
        let spec = config_watch_spec().expect("the config path has a parent");
        assert_eq!(spec.dir, config_path().parent().expect("parent"));
        assert_eq!(spec.mode, notify::RecursiveMode::NonRecursive);
        assert_eq!(spec.debounce, CONFIG_DEBOUNCE);
        assert!((spec.filter)(&spec.dir.join(CONFIG_FILE_NAME)));
        // The temp file of an atomic write must not wake us.
        assert!(!(spec.filter)(&spec.dir.join("termixion.toml.tmp")));
    }

    // --- trmx-238 (M15): the transient-read guard on a watcher wake --------------------------

    #[test]
    fn read_outcome_retries_a_missing_file_and_skips_other_errors() {
        // An editor that saves by rename-then-create (vim `backupcopy=no`, "safe write" modes)
        // unlinks the file for a sub-millisecond window. Reading "" there is indistinguishable
        // from a real delete, and "" parses to Config::default() — which is why the live UI
        // reverted every customized key on a routine :w (M15).
        assert_eq!(read_outcome(&FileRead::Absent), ReadOutcome::RetryAbsent);
        assert_eq!(
            read_outcome(&FileRead::Text("x = 1\n".to_string())),
            ReadOutcome::Text("x = 1\n".to_string())
        );
        // EACCES is not a transient rename window; re-reading cannot help and applying defaults
        // would be a lie. Skip the wake entirely.
        assert_eq!(
            read_outcome(&FileRead::Unreadable("EACCES".to_string())),
            ReadOutcome::Skip
        );
    }

    #[test]
    fn wake_text_reretries_once_when_the_file_is_briefly_absent() {
        // absent → present: the rename window. The SECOND read wins; no defaults burst.
        let reads = std::cell::RefCell::new(vec![
            FileRead::Absent,
            FileRead::Text("[terminal]\nfont_size = 14\n".to_string()),
        ]);
        let got = wake_text_with(|| reads.borrow_mut().remove(0));
        assert_eq!(got, Some("[terminal]\nfont_size = 14\n".to_string()));
        assert!(reads.borrow().is_empty(), "both reads were consumed");
    }

    #[test]
    fn wake_text_applies_defaults_when_the_file_is_really_gone() {
        // absent → still absent: a REAL delete must still take effect (empty text ⇒ defaults).
        let reads = std::cell::RefCell::new(vec![FileRead::Absent, FileRead::Absent]);
        let got = wake_text_with(|| reads.borrow_mut().remove(0));
        assert_eq!(got, Some(String::new()));
    }

    #[test]
    fn wake_text_skips_the_wake_entirely_on_an_unreadable_file() {
        // No re-read, no application: None means on_config_file_event returns before emitting,
        // so an EACCES file produces no settings:changed burst at all.
        let reads = std::cell::RefCell::new(vec![FileRead::Unreadable("EACCES".to_string())]);
        let got = wake_text_with(|| reads.borrow_mut().remove(0));
        assert_eq!(got, None);
        assert!(reads.borrow().is_empty(), "exactly one read, no retry");
    }

    // --- the emit decision for one applied wake (trmx-80 review R2) ---------------------------

    #[test]
    fn emissions_end_with_config_warnings_even_when_empty_so_a_fixed_file_clears_the_banner() {
        // The user fixed their typo'd file: the applied clean reparse must still publish the
        // (now empty) warning set — "applied ⇒ publish", not "warned ⇒ publish" — otherwise a
        // stale warnings banner can never clear in the UI.
        let application = apply_file_text("[terminal]\nfont_size = 14\n", &Config::default(), None)
            .expect("applies");
        let emissions = emissions_for(&application);
        assert_eq!(
            emissions,
            vec![
                (
                    "settings:changed",
                    json!({ "key": "terminal.fontSize", "value": 14, "source": "config-file" })
                ),
                ("config:warnings", json!([])),
            ]
        );
    }

    #[test]
    fn emissions_carry_the_fresh_warning_set_after_the_changed_pairs() {
        let application =
            apply_file_text("[nope]\nx = 1\n", &Config::default(), None).expect("applies");
        let emissions = emissions_for(&application);
        assert_eq!(
            emissions,
            vec![(
                "config:warnings",
                json!([ { "type": "UnknownKey", "key": "nope" } ])
            )]
        );
    }

    // --- the settings:changed wire shape ------------------------------------------------------

    #[test]
    fn settings_changed_payload_matches_the_registry_wire_shape() {
        assert_eq!(
            settings_changed_payload("terminal.fontSize", &RegistryValue::Int(14)),
            json!({ "key": "terminal.fontSize", "value": 14, "source": "config-file" })
        );
        assert_eq!(
            settings_changed_payload("update.autoCheck", &RegistryValue::Bool(false)),
            json!({ "key": "update.autoCheck", "value": false, "source": "config-file" })
        );
        assert_eq!(
            settings_changed_payload("appearance.theme", &RegistryValue::Str("night".into())),
            json!({ "key": "appearance.theme", "value": "night", "source": "config-file" })
        );
    }

    /// trmx-251: the section of the shared command-response golden this module owns.
    ///
    /// One file, asserted here and read verbatim by `app/e2e/fixtures/tauriFake.ts`. The fake
    /// answers the Playwright suite with these exact values, so a DTO whose serialization drifts
    /// breaks this assertion — and a fake that drifts from the file breaks the TypeScript test.
    /// Neither side can move alone, which a hand-written double could.
    fn golden_section(name: &str) -> serde_json::Value {
        let golden: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/command-responses-golden.json"
        ))
        .expect("the command-response golden parses");
        golden
            .get(name)
            .unwrap_or_else(|| panic!("the golden has a `{name}` section"))
            .clone()
    }

    #[test]
    fn config_read_response_matches_the_shared_golden() {
        let response = read_response_from(
            FileRead::Text("[terminal]\nfont_size = 14\ncursor_blink = true\n".to_string()),
            Path::new("/x/termixion.toml"),
        );
        let actual = serde_json::to_value(&response).expect("ConfigReadResponse serializes");
        assert_eq!(
            actual,
            golden_section("configRead"),
            "config_read's wire shape drifted from tests/fixtures/command-responses-golden.json"
        );
    }

    // --- trmx-249: kind fidelity -------------------------------------------------------------
    //
    // `write_key_at` is the busiest fallible path in the app AND the one that mixes the most
    // classes: validation from `edit_document`, filesystem from `write_atomic`, and an invariant
    // from `write_atomic`'s parentless-path branch. Asserting the kinds DIFFER would pass with the
    // labels swapped, so each case asserts its EXACT kind.

    #[test]
    fn write_key_at_rejects_an_unknown_key_as_invalid() {
        let dir = test_dir("kind-invalid");
        let path = dir.join("termixion.toml");
        let err = write_key_at(&path, "nope.key", &json!(1)).expect_err("unknown key is rejected");
        assert_eq!(err.kind, IpcErrorKind::Invalid);
        assert!(err.message.contains("nope.key"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_key_at_rejects_a_wrong_value_type_as_invalid() {
        let dir = test_dir("kind-invalid-type");
        let path = dir.join("termixion.toml");
        let err = write_key_at(&path, "terminal.fontSize", &json!("big"))
            .expect_err("a string for an int key is rejected");
        assert_eq!(err.kind, IpcErrorKind::Invalid);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_key_at_reports_a_filesystem_failure_as_io() {
        let dir = test_dir("kind-io");
        // A FILE where the config's parent directory should be: every read/write below it fails.
        let blocker = dir.join("blocker");
        std::fs::write(&blocker, b"not a directory").expect("seed blocker");
        let err = write_key_at(
            &blocker.join("termixion.toml"),
            "terminal.fontSize",
            &json!(16),
        )
        .expect_err("a path under a file cannot be written");
        assert_eq!(err.kind, IpcErrorKind::Io, "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_atomic_reports_a_parentless_path_as_internal() {
        // Not reachable through write_key_at (the read fails first), so the invariant branch is
        // asserted directly — a path we construct having no parent is our bug, not the caller's.
        let err = write_atomic(Path::new("/"), "x").expect_err("`/` has no parent");
        assert_eq!(err.kind, IpcErrorKind::Internal, "{err}");
        assert!(err.message.contains("no parent directory"), "{err}");
    }

    // --- filesystem glue (deterministic: private temp dirs, no watcher, no races) -------------

    fn test_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("termixion-config-io-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create test dir");
        dir
    }

    #[test]
    fn write_atomic_writes_the_content_creates_parents_and_returns_its_hash() {
        let dir = test_dir("atomic");
        let path = dir.join("nested").join(CONFIG_FILE_NAME);
        let hash = write_atomic(&path, "content-1").expect("write");
        assert_eq!(
            std::fs::read_to_string(&path).expect("read back"),
            "content-1"
        );
        assert_eq!(hash, text_hash("content-1"));
        // No temp-file residue next to the target.
        let residue = std::fs::read_dir(path.parent().expect("parent"))
            .expect("read dir")
            .count();
        assert_eq!(residue, 1, "only the target file may remain");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_key_at_lazily_creates_the_file_from_the_commented_template() {
        let dir = test_dir("lazy-create");
        let path = dir.join("nested").join(CONFIG_FILE_NAME);
        let (hash, config, _warnings) =
            write_key_at(&path, "terminal.fontSize", &json!(16)).expect("first write creates");
        let on_disk = std::fs::read_to_string(&path).expect("read back");
        assert!(
            on_disk.starts_with("# Termixion configuration (TOML)."),
            "lazy creation must start from DEFAULT_TEMPLATE: {on_disk}"
        );
        assert_eq!(hash, text_hash(&on_disk));
        assert_eq!(config.terminal.font_size, 16);
        let (pairs, warnings) = parse_registry_pairs(&on_disk);
        assert_eq!(warnings, Vec::new());
        assert_eq!(
            pairs,
            vec![("terminal.fontSize".to_string(), RegistryValue::Int(16))]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_key_at_rejects_an_unknown_key_without_creating_the_file() {
        let dir = test_dir("no-write-on-err");
        let path = dir.join(CONFIG_FILE_NAME);
        assert!(write_key_at(&path, "nope.key", &json!(1)).is_err());
        assert!(
            !path.exists(),
            "a rejected write must not materialize the file"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_config_file_at_materializes_the_template_when_absent() {
        let dir = test_dir("ensure-absent");
        let path = dir.join("nested").join(CONFIG_FILE_NAME);
        let created = ensure_config_file_at(&path).expect("ensure");
        assert!(created, "an absent file must report created = true");
        assert_eq!(
            std::fs::read_to_string(&path).expect("read back"),
            DEFAULT_TEMPLATE
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ensure_config_file_at_leaves_an_existing_file_untouched() {
        let dir = test_dir("ensure-existing");
        let path = dir.join(CONFIG_FILE_NAME);
        std::fs::write(&path, "[terminal]\nfont_size = 40\n").expect("seed");
        let created = ensure_config_file_at(&path).expect("ensure");
        assert!(!created, "an existing file must report created = false");
        assert_eq!(
            std::fs::read_to_string(&path).expect("read back"),
            "[terminal]\nfont_size = 40\n",
            "existing content must be left byte-for-byte untouched"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reset_all_at_writes_exactly_the_default_template() {
        let dir = test_dir("reset");
        let path = dir.join(CONFIG_FILE_NAME);
        std::fs::write(&path, "[terminal]\nfont_size = 40\n").expect("seed");
        let hash = reset_all_at(&path).expect("reset");
        assert_eq!(
            std::fs::read_to_string(&path).expect("read back"),
            DEFAULT_TEMPLATE
        );
        assert_eq!(hash, text_hash(DEFAULT_TEMPLATE));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
