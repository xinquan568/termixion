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
//! ([`config_path_from`], [`should_apply`], [`edit_document`], [`read_response_from`],
//! [`apply_file_text`]); the filesystem / `notify` edge around them is thin runtime glue
//! (validated by the packaged smoke).

use std::collections::BTreeMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{Map, Value as JsonValue};
use tauri::{Emitter, Manager, State};
use termixion_core::{
    Config, ConfigWarning, DEFAULT_TEMPLATE, RegistryValue, diff_configs, parse_config,
    parse_registry_pairs, toml_path_for,
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
}

// ---------------------------------------------------------------------------
// Pure decision pieces
// ---------------------------------------------------------------------------

/// Hash of a file's text content (std `DefaultHasher` — cheap, in-process only, never persisted).
fn text_hash(text: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

/// Should a watcher wake apply the file content with this hash? `false` exactly when it equals
/// the hash of the last bytes we ourselves wrote (the self-echo, D6).
fn should_apply(file_hash: u64, last_write_hash: Option<u64>) -> bool {
    last_write_hash != Some(file_hash)
}

/// What one applied watcher wake yields: the new diff base, the changed registry pairs to
/// broadcast, and any parse warnings to surface.
struct FileApplication {
    config: Config,
    changed: Vec<(String, RegistryValue)>,
    warnings: Vec<ConfigWarning>,
}

/// The pure core of one watcher wake: drop the self-echo (D6), otherwise parse + diff.
fn apply_file_text(
    text: &str,
    last: &Config,
    last_write_hash: Option<u64>,
) -> Option<FileApplication> {
    if !should_apply(text_hash(text), last_write_hash) {
        return None;
    }
    let (config, warnings) = parse_config(text);
    let changed = diff_configs(last, &config);
    Some(FileApplication {
        config,
        changed,
        warnings,
    })
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
        "update.autoCheck" | "update.autoDownload" | "terminal.cursorBlink" => {
            Some(ValueKind::Bool)
        }
        "terminal.scrollbackLines" | "terminal.fontSize" => Some(ValueKind::Int),
        "update.checkFrequency"
        | "terminal.cursorStyle"
        | "terminal.fontFamily"
        | "appearance.theme"
        | "tabs.barPosition"
        | "tabs.sideLabelOrientation"
        | "scripts.startup" => Some(ValueKind::Str),
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
fn toml_item_for(key: &str, kind: ValueKind, value: &JsonValue) -> Result<toml_edit::Item, String> {
    let mismatch = || {
        format!(
            "wrong value type for `{key}`: expected {}, got {}",
            kind.expected(),
            describe_json(value)
        )
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
fn edit_document(text: &str, key: &str, value: &JsonValue) -> Result<String, String> {
    let (table_name, toml_key) =
        toml_path_for(key).ok_or_else(|| format!("unknown settings key `{key}`"))?;
    let kind = value_kind_for(key).ok_or_else(|| format!("unknown settings key `{key}`"))?;
    let item = toml_item_for(key, kind, value)?;

    // Refuse to clobber a file we cannot parse losslessly: a broken file is the user's to fix
    // (config_read surfaces the SyntaxError warning), not ours to silently rewrite.
    let mut doc: toml_edit::DocumentMut = text
        .parse()
        .map_err(|error| format!("config file is not editable TOML: {error}"))?;

    let table_existed = doc.get(table_name).is_some();
    let table_item = doc.entry(table_name).or_insert(toml_edit::table());
    let table = table_item
        .as_table_mut()
        .ok_or_else(|| format!("config: `{table_name}` is not a table"))?;
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

/// Build the `config_read` response from the file's text (pure; `None` = the file is absent):
/// registry-keyed PRESENT-ONLY values plus the parse warnings.
fn read_response_from(text: Option<&str>, path: &Path) -> ConfigReadResponse {
    let path = path.display().to_string();
    let Some(text) = text else {
        return ConfigReadResponse {
            exists: false,
            path,
            values: Map::new(),
            warnings: Vec::new(),
        };
    };
    let (pairs, warnings) = parse_registry_pairs(text);
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
fn write_atomic(path: &Path, contents: &str) -> Result<u64, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("config path has no parent directory: {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    // Same directory as the target so the rename is same-filesystem (atomic); pid-suffixed so
    // two Termixion processes can never collide on it.
    let temp = parent.join(format!(".{CONFIG_FILE_NAME}.tmp-{}", std::process::id()));
    std::fs::write(&temp, contents)
        .map_err(|error| format!("could not write {}: {error}", temp.display()))?;
    if let Err(error) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp); // best-effort: never leave residue behind
        return Err(format!("could not replace {}: {error}", path.display()));
    }
    Ok(text_hash(contents))
}

/// Read the file (absent → template) and edit `key` into it — the lazy file creation: the first
/// write materializes the fully-commented [`DEFAULT_TEMPLATE`] so the user's file always carries
/// the reference header. Returns the written text's hash + its parsed config for the state.
fn write_key_at(path: &Path, key: &str, value: &JsonValue) -> Result<(u64, Config), String> {
    let current = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => DEFAULT_TEMPLATE.to_string(),
        Err(error) => return Err(format!("could not read {}: {error}", path.display())),
    };
    let edited = edit_document(&current, key, value)?;
    let hash = write_atomic(path, &edited)?;
    let (config, _warnings) = parse_config(&edited);
    Ok((hash, config))
}

/// Reset the file to the pristine [`DEFAULT_TEMPLATE`], atomically. Returns the written hash.
fn reset_all_at(path: &Path) -> Result<u64, String> {
    write_atomic(path, DEFAULT_TEMPLATE)
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Read the config file for the frontend registry: present-only registry-keyed values +
/// warnings. Also (re)bases the watcher's diff state on what was read.
#[tauri::command]
pub fn config_read(state: State<'_, ConfigState>) -> ConfigReadResponse {
    let path = config_path();
    let text = std::fs::read_to_string(&path).ok();
    let response = read_response_from(text.as_deref(), &path);
    let (config, _) = parse_config(text.as_deref().unwrap_or_default());
    match state.0.lock() {
        Ok(mut inner) => inner.last = config,
        Err(_) => eprintln!("termixion: config state poisoned; skipping diff-base update"),
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
    state: State<'_, ConfigState>,
    key: String,
    value: JsonValue,
) -> Result<(), String> {
    let (hash, config) = write_key_at(&config_path(), &key, &value)?;
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "config state poisoned".to_string())?;
    inner.last_write_hash = Some(hash);
    inner.last = config;
    Ok(())
}

/// Reset the config file to the pristine commented template (every key back to its default).
#[tauri::command]
pub fn config_reset_all(state: State<'_, ConfigState>) -> Result<(), String> {
    let hash = reset_all_at(&config_path())?;
    let mut inner = state
        .0
        .lock()
        .map_err(|_| "config state poisoned".to_string())?;
    inner.last_write_hash = Some(hash);
    inner.last = Config::default();
    Ok(())
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
    use notify::{RecursiveMode, Watcher};

    let path = config_path();
    let Some(parent) = path.parent().map(Path::to_path_buf) else {
        eprintln!("termixion: config path has no parent; config file watching disabled");
        return;
    };
    // Ensure the directory exists so the watch can attach before the first lazy write
    // (create_dir_all is harmless — it creates no file).
    if let Err(err) = std::fs::create_dir_all(&parent) {
        eprintln!(
            "termixion: could not create {}: {err}; config file watching disabled",
            parent.display()
        );
        return;
    }
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let mut watcher =
        match notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
            // Only events touching termixion.toml count; the temp-file traffic of atomic
            // writes (ours and editors') filters out here.
            if let Ok(event) = event
                && event
                    .paths
                    .iter()
                    .any(|p| p.file_name().is_some_and(|name| name == CONFIG_FILE_NAME))
            {
                let _ = tx.send(());
            }
        }) {
            Ok(watcher) => watcher,
            Err(err) => {
                eprintln!("termixion: could not create the config watcher: {err}");
                return;
            }
        };
    if let Err(err) = watcher.watch(&parent, RecursiveMode::NonRecursive) {
        eprintln!(
            "termixion: could not watch {}: {err}; config file watching disabled",
            parent.display()
        );
        return;
    }
    // Debounce: block for the first event, then drain until CONFIG_DEBOUNCE of quiet before
    // acting — the same std-thread + mpsc recv_timeout style as the rest of this shell.
    loop {
        if rx.recv().is_err() {
            return; // channel closed — the watcher is gone, nothing left to do
        }
        while rx.recv_timeout(CONFIG_DEBOUNCE).is_ok() {}
        on_config_file_event(&app, &path);
    }
}

/// One debounced watcher wake: read the file (unreadable/absent → empty text → pure defaults),
/// run the pure [`apply_file_text`] decision, and broadcast the outcome.
fn on_config_file_event(app: &tauri::AppHandle, path: &Path) {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let state = app.state::<ConfigState>();
    let Ok(mut inner) = state.0.lock() else {
        eprintln!("termixion: config state poisoned; dropping a config file event");
        return;
    };
    let Some(application) = apply_file_text(&text, &inner.last, inner.last_write_hash) else {
        return; // self-echo of our own write (D6)
    };
    // The pure decision, computed before `application.config` moves into the diff base.
    let mut emissions = emissions_for(&application);
    // trmx-94: the scalar diff/settings:changed path is blind to the [keys] map — emit a bare
    // keys:changed when the map changed so the frontend re-reads the effective keymap (live rebind).
    if keys_map_changed(&inner.last, &application.config) {
        emissions.push(("keys:changed", JsonValue::Null));
    }
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    #[test]
    fn should_apply_drops_the_self_echo_hash() {
        assert!(!should_apply(42, Some(42)));
    }

    #[test]
    fn should_apply_applies_a_different_hash() {
        assert!(should_apply(42, Some(7)));
    }

    #[test]
    fn should_apply_applies_when_no_write_hash_is_recorded() {
        assert!(should_apply(42, None));
    }

    #[test]
    fn text_hash_is_stable_and_content_sensitive() {
        assert_eq!(text_hash("abc"), text_hash("abc"));
        assert_ne!(text_hash("abc"), text_hash("abd"));
    }

    // --- the pure watcher decision ---------------------------------------------------------

    #[test]
    fn apply_file_text_drops_the_self_echo() {
        let text = "[terminal]\nfont_size = 14\n";
        let application = apply_file_text(text, &Config::default(), Some(text_hash(text)));
        assert!(
            application.is_none(),
            "our own write echoing back must be dropped (D6)"
        );
    }

    #[test]
    fn apply_file_text_diffs_against_last_and_reports_changed_pairs() {
        let text = "[terminal]\nfont_size = 14\n";
        let application =
            apply_file_text(text, &Config::default(), None).expect("an external edit applies");
        assert_eq!(
            application.changed,
            vec![("terminal.fontSize".to_string(), RegistryValue::Int(14))]
        );
        assert_eq!(application.config.terminal.font_size, 14);
        assert!(application.warnings.is_empty());
    }

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

    #[test]
    fn apply_file_text_surfaces_warnings() {
        let application = apply_file_text("[nope]\nx = 1\n", &Config::default(), None)
            .expect("a warned parse still applies");
        assert!(application.changed.is_empty(), "defaults did not change");
        assert_eq!(
            application.warnings,
            vec![ConfigWarning::UnknownKey {
                key: "nope".to_string()
            }]
        );
    }

    #[test]
    fn apply_file_text_empty_text_returns_to_defaults() {
        // A deleted/unreadable file reads as "" — the world goes back to defaults, and the
        // diff against the previous state carries exactly the keys that must revert.
        let mut last = Config::default();
        last.terminal.font_size = 14;
        let application = apply_file_text("", &last, None).expect("applies");
        assert_eq!(
            application.changed,
            vec![("terminal.fontSize".to_string(), RegistryValue::Int(12))]
        );
        assert_eq!(application.config, Config::default());
        assert!(application.warnings.is_empty());
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
            assert!(err.contains(key), "error must name the key: {err}");
        }
    }

    #[test]
    fn edit_document_rejects_a_float_for_an_integer_key() {
        let err = edit_document(FIXTURE, "terminal.fontSize", &json!(12.5))
            .expect_err("a fractional font size must be rejected");
        assert!(err.contains("terminal.fontSize"), "{err}");
    }

    #[test]
    fn edit_document_rejects_an_unknown_key() {
        let err = edit_document(FIXTURE, "nope.key", &json!(1)).expect_err("unknown key");
        assert!(err.contains("nope.key"), "error must name the key: {err}");
        let err = edit_document(FIXTURE, "terminal.font_size", &json!(14))
            .expect_err("TOML spelling is not a registry key");
        assert!(err.contains("terminal.font_size"), "{err}");
    }

    #[test]
    fn edit_document_refuses_to_clobber_unparseable_toml() {
        // A syntactically broken file cannot be comment-preservingly edited; refusing beats
        // silently rewriting (and losing) whatever the user had.
        let err = edit_document("[terminal\nfont_size=", "terminal.fontSize", &json!(14))
            .expect_err("broken TOML must not be clobbered");
        assert!(!err.is_empty());
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
            ("terminal.scrollbackLines", ValueKind::Int),
            ("terminal.fontFamily", ValueKind::Str),
            ("terminal.fontSize", ValueKind::Int),
            ("appearance.theme", ValueKind::Str),
            ("tabs.barPosition", ValueKind::Str),
            ("tabs.sideLabelOrientation", ValueKind::Str),
            ("scripts.startup", ValueKind::Str),
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
        let response = read_response_from(None, Path::new("/tmp/x/termixion.toml"));
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
            Some("[terminal]\nfont_size = 14\ncursor_blink = true\n"),
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
            Some("[terminal]\nfont_sise = 13\n"),
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
        let (hash, config) =
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
