// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-89 (FR-6): the theme files' I/O edge — scan `~/.config/termixion/themes/*.toml`, tolerant
//! per-file [`parse_theme`](termixion_core::parse_theme) (core), atomic writes, and the themes-dir
//! watcher emitting `themes:changed`. Mirrors [`crate::config_io`]'s layering: the **core** parses
//! theme *strings* into a validated `ThemeSpec` (no filesystem), and this shell does the fs — it
//! reads the theme files off disk, writes them atomically, and watches the directory.
//!
//! Discipline mirrors `config_io`: every DECISION is a pure, unit-tested function
//! ([`themes_dir_from`], [`read_entry`], [`read_entries_in`], [`sanitize_stem`], [`is_theme_file`]);
//! the filesystem / `notify` edge around them is thin runtime glue.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::Emitter;
use tauri_plugin_opener::OpenerExt;
use termixion_core::{ThemeSpec, ThemeWarning, parse_theme, user_theme_id};

// ---------------------------------------------------------------------------
// Path resolution (the same XDG base as config_io, then `termixion/themes`)
// ---------------------------------------------------------------------------

/// Resolve the user themes directory from the given environment values (pure). A non-empty
/// `$XDG_CONFIG_HOME` wins; otherwise `<home>/.config` (the XDG default), then `termixion/themes`.
/// Shares config_io's base logic so the config file and the themes dir always sit side by side.
pub fn themes_dir_from(xdg_config_home: Option<&str>, home: &str) -> PathBuf {
    let base = match xdg_config_home.filter(|dir| !dir.is_empty()) {
        Some(xdg) => PathBuf::from(xdg),
        None => Path::new(home).join(".config"),
    };
    base.join("termixion").join("themes")
}

/// The real user themes directory, from the process environment.
pub fn themes_dir() -> PathBuf {
    let xdg = std::env::var("XDG_CONFIG_HOME").ok();
    let home = std::env::var("HOME").unwrap_or_default();
    themes_dir_from(xdg.as_deref(), &home)
}

// ---------------------------------------------------------------------------
// The response entry (one per theme file)
// ---------------------------------------------------------------------------

/// What `themes_read` returns for one theme file: its catalog `id` (`user:<stem>`), the fixed
/// `source` ("user"), whether it parsed to a valid [`ThemeSpec`], the spec itself when valid, and
/// every non-fatal [`ThemeWarning`] found. Serializes camelCase to match the frontend catalog shape.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeEntry {
    id: String,
    source: &'static str,
    valid: bool,
    /// Serialized always (the object when valid, `null` when not) so the frontend's
    /// `ThemeSpec | null` catalog type has a stable key; `valid` is the explicit gate.
    spec: Option<ThemeSpec>,
    warnings: Vec<ThemeWarning>,
}

// ---------------------------------------------------------------------------
// Pure decision pieces
// ---------------------------------------------------------------------------

/// Build the [`ThemeEntry`] for one theme file from its stem + text (pure): the id is
/// [`user_theme_id`], the spec/warnings come from core's tolerant [`parse_theme`], and a file is
/// "valid" exactly when a spec was produced.
fn read_entry(stem: &str, text: &str) -> ThemeEntry {
    let (spec, warnings) = parse_theme(text);
    ThemeEntry {
        id: user_theme_id(stem),
        source: "user",
        valid: spec.is_some(),
        spec,
        warnings,
    }
}

/// Whether a filesystem path names a theme file: a non-dotfile with a `.toml` extension. This is
/// both the directory-listing filter ([`read_entries_in`]) and the watcher's event filter — it
/// drops the temp-file traffic of atomic writes (`.<stem>.toml.tmp-<pid>`), dotfiles, and non-toml.
fn is_theme_file(path: &Path) -> bool {
    let is_toml = path.extension().and_then(|ext| ext.to_str()) == Some("toml");
    let is_dotfile = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with('.'));
    is_toml && !is_dotfile
}

/// Validate that `stem` is a safe single path component for a `<stem>.toml` theme file: non-empty
/// and free of any path separator or `.` — which also rules out `.`, `..` (traversal), hidden
/// dotfiles, and extension smuggling. Returns the stem unchanged when safe, else a descriptive Err.
fn sanitize_stem(stem: &str) -> Result<&str, String> {
    if stem.is_empty() {
        return Err("theme name must not be empty".to_string());
    }
    if let Some(bad) = stem
        .chars()
        .find(|&ch| ch == '/' || ch == '\\' || ch == '.')
    {
        return Err(format!(
            "invalid theme name `{stem}`: must not contain `{bad}` (use a plain file name, no path or extension)"
        ));
    }
    Ok(stem)
}

// ---------------------------------------------------------------------------
// Filesystem glue (path-parameterized so tests can drive it against a temp dir)
// ---------------------------------------------------------------------------

/// Write `contents` ATOMICALLY: temp file in the SAME directory, then `rename` over the target (a
/// reader/watcher can never observe a torn file). Creates the parent directory. Mirrors
/// config_io's `write_atomic`, minus the self-echo hash (the themes watcher is a bare re-read).
fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("theme path has no parent directory: {}", path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("theme path has no file name: {}", path.display()))?;
    // Same directory as the target so the rename is same-filesystem (atomic); pid-suffixed and
    // file-name-scoped so two writes (two Termixion processes, or two stems) never collide on it.
    let temp = parent.join(format!(".{file_name}.tmp-{}", std::process::id()));
    std::fs::write(&temp, contents)
        .map_err(|error| format!("could not write {}: {error}", temp.display()))?;
    if let Err(error) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp); // best-effort: never leave residue behind
        return Err(format!("could not replace {}: {error}", path.display()));
    }
    Ok(())
}

/// The core of `themes_write` (path-parameterized): sanitize the stem, then atomically write
/// `<dir>/<stem>.toml`. Returns the written file path string.
fn write_theme_in(dir: &Path, stem: &str, text: &str) -> Result<String, String> {
    let stem = sanitize_stem(stem)?;
    let path = dir.join(format!("{stem}.toml"));
    write_atomic(&path, text)?;
    Ok(path.display().to_string())
}

/// List `dir`'s `*.toml` theme files into [`ThemeEntry`]s (path-parameterized so tests drive it
/// against a temp dir). Skips non-files, dotfiles, and non-toml; an unreadable file is logged and
/// skipped (never a panic); a missing/unreadable directory yields an empty vec (not an error).
/// Returned SORTED by id so the catalog order is deterministic.
fn read_entries_in(dir: &Path) -> Vec<ThemeEntry> {
    let mut entries = Vec::new();
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return entries; // a missing/unreadable themes dir is simply "no user themes"
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        if !path.is_file() || !is_theme_file(&path) {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) => {
                eprintln!(
                    "termixion: could not read theme {}: {error}; skipping",
                    path.display()
                );
                continue;
            }
        };
        entries.push(read_entry(stem, &text));
    }
    entries.sort_by(|left, right| left.id.cmp(&right.id));
    entries
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Read every user theme file in the themes directory into the frontend catalog (sorted by id,
/// tolerant per file). A missing themes directory is not an error — it just means no user themes.
#[tauri::command]
pub fn themes_read() -> Vec<ThemeEntry> {
    read_entries_in(&themes_dir())
}

/// Atomically write a user theme file `<themes-dir>/<stem>.toml` with `text` (the frontend's
/// Duplicate flow hands a full-token TOML body). The stem must be a safe single path component.
/// Returns the written file path string.
#[tauri::command]
pub fn themes_write(stem: String, text: String) -> Result<String, String> {
    write_theme_in(&themes_dir(), &stem, &text)
}

/// Create the themes directory if absent, then open it in the OS file manager (Finder) via the
/// opener plugin — the "Open themes folder" affordance so a user can drop in / edit theme files.
#[tauri::command]
pub fn themes_open_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = themes_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("could not create {}: {error}", dir.display()))?;
    app.opener()
        .open_path(dir.display().to_string(), None::<&str>)
        .map_err(|error| format!("could not open {}: {error}", dir.display()))
}

// ---------------------------------------------------------------------------
// The themes-dir watcher (spawned once from `setup`, like the config watcher)
// ---------------------------------------------------------------------------

/// Quiet period after the last filesystem event before the change is signalled: editors save via
/// write-temp + rename bursts, and one coalesced signal beats N intermediate ones.
const THEMES_DEBOUNCE: Duration = Duration::from_millis(250);

/// Watch the themes DIRECTORY for `*.toml` changes and signal the frontend to re-read. Watching the
/// dir (not a file) survives the rename-replace dance editors and our own atomic writes do. Unlike
/// the config watcher there is no diff/self-echo state: `themes:changed` is a bare signal and the
/// frontend re-runs [`themes_read`]. Best-effort like the config watcher: any setup failure logs and
/// disables watching rather than failing the app.
pub fn run_themes_watcher(app: tauri::AppHandle) {
    use notify::{RecursiveMode, Watcher};

    let dir = themes_dir();
    // Ensure the directory exists so the watch can attach before the first theme is written
    // (create_dir_all is harmless — it creates no file).
    if let Err(err) = std::fs::create_dir_all(&dir) {
        eprintln!(
            "termixion: could not create {}: {err}; theme file watching disabled",
            dir.display()
        );
        return;
    }
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let mut watcher =
        match notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
            // Only events touching a *.toml theme file count; the temp-file traffic of atomic
            // writes (ours and editors') and non-toml/dotfile noise filters out here.
            if let Ok(event) = event
                && event.paths.iter().any(|path| is_theme_file(path))
            {
                let _ = tx.send(());
            }
        }) {
            Ok(watcher) => watcher,
            Err(err) => {
                eprintln!("termixion: could not create the themes watcher: {err}");
                return;
            }
        };
    if let Err(err) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
        eprintln!(
            "termixion: could not watch {}: {err}; theme file watching disabled",
            dir.display()
        );
        return;
    }
    // Debounce: block for the first event, then drain until THEMES_DEBOUNCE of quiet before
    // signalling — the same std-thread + mpsc recv_timeout style as the config watcher.
    loop {
        if rx.recv().is_err() {
            return; // channel closed — the watcher is gone, nothing left to do
        }
        while rx.recv_timeout(THEMES_DEBOUNCE).is_ok() {}
        // A bare signal — the frontend re-runs themes_read to pick up the change. Best-effort like
        // the config watcher's emits (a webview may be mid-teardown).
        let _ = app.emit("themes:changed", ());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal VALID theme: exactly the required set and nothing else (mirrors core's fixture).
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

    /// An INVALID theme: `is_dark` present but every required color absent → no spec.
    const INVALID: &str = "is_dark = true\n";

    // --- path resolution -----------------------------------------------------------------

    #[test]
    fn themes_dir_prefers_a_non_empty_xdg_config_home() {
        assert_eq!(
            themes_dir_from(Some("/custom/xdg"), "/Users/me"),
            PathBuf::from("/custom/xdg/termixion/themes")
        );
    }

    #[test]
    fn themes_dir_falls_back_to_home_dot_config_when_xdg_unset() {
        assert_eq!(
            themes_dir_from(None, "/Users/me"),
            PathBuf::from("/Users/me/.config/termixion/themes")
        );
    }

    #[test]
    fn themes_dir_treats_an_empty_xdg_as_unset() {
        assert_eq!(
            themes_dir_from(Some(""), "/Users/me"),
            PathBuf::from("/Users/me/.config/termixion/themes")
        );
    }

    // --- read_entry ----------------------------------------------------------------------

    #[test]
    fn read_entry_marks_a_valid_theme_valid_with_a_spec() {
        let entry = read_entry("dracula", MINIMAL);
        assert_eq!(entry.id, "user:dracula");
        assert_eq!(entry.source, "user");
        assert!(entry.valid);
        let spec = entry.spec.expect("a valid theme carries a spec");
        assert!(!spec.is_dark);
        assert_eq!(spec.color.bg.primary, "#000000");
        assert!(entry.warnings.is_empty());
    }

    #[test]
    fn read_entry_marks_an_invalid_theme_invalid_with_no_spec_and_warnings() {
        let entry = read_entry("broken", INVALID);
        assert_eq!(entry.id, "user:broken");
        assert_eq!(entry.source, "user");
        assert!(!entry.valid);
        assert!(entry.spec.is_none());
        assert!(
            !entry.warnings.is_empty(),
            "an invalid theme must carry warnings"
        );
    }

    #[test]
    fn theme_entry_serializes_source_user_and_camel_case_spec() {
        let entry = read_entry("dracula", MINIMAL);
        let json = serde_json::to_value(&entry).expect("ThemeEntry serializes");
        assert_eq!(json["id"], serde_json::json!("user:dracula"));
        assert_eq!(json["source"], serde_json::json!("user"));
        assert_eq!(json["valid"], serde_json::json!(true));
        assert_eq!(json["spec"]["isDark"], serde_json::json!(false));
        assert_eq!(json["warnings"], serde_json::json!([]));
    }

    #[test]
    fn theme_entry_for_an_invalid_theme_serializes_spec_null_with_warnings() {
        // The `spec` key is always present (never omitted): `null` when invalid, so the frontend's
        // `ThemeSpec | null` catalog type has a stable key and `valid` is the explicit gate.
        let entry = read_entry("broken", INVALID);
        let json = serde_json::to_value(&entry).expect("ThemeEntry serializes");
        assert_eq!(json["id"], serde_json::json!("user:broken"));
        assert_eq!(json["valid"], serde_json::json!(false));
        assert!(
            json.get("spec").is_some(),
            "spec key must always be present"
        );
        assert_eq!(json["spec"], serde_json::Value::Null);
        assert!(
            json["warnings"].as_array().is_some_and(|w| !w.is_empty()),
            "an invalid theme serializes non-empty warnings"
        );
    }

    // --- is_theme_file -------------------------------------------------------------------

    #[test]
    fn is_theme_file_accepts_toml_and_rejects_dotfiles_temps_and_non_toml() {
        assert!(is_theme_file(Path::new("/x/dracula.toml")));
        assert!(is_theme_file(Path::new("dracula.toml")));
        assert!(!is_theme_file(Path::new("/x/notes.md")));
        assert!(!is_theme_file(Path::new("/x/README")));
        assert!(!is_theme_file(Path::new("/x/.hidden.toml")));
        // Our own atomic-write temp file must be filtered out.
        assert!(!is_theme_file(Path::new("/x/.dracula.toml.tmp-1234")));
    }

    // --- sanitize_stem -------------------------------------------------------------------

    #[test]
    fn sanitize_stem_accepts_a_plain_name() {
        assert_eq!(sanitize_stem("dracula"), Ok("dracula"));
        assert_eq!(sanitize_stem("dracula-pro"), Ok("dracula-pro"));
        assert_eq!(sanitize_stem("my_theme_2"), Ok("my_theme_2"));
    }

    #[test]
    fn sanitize_stem_rejects_empty_separators_dots_and_traversal() {
        for bad in [
            "",
            ".",
            "..",
            "a/b",
            "a\\b",
            "foo.toml",
            "solar.ized",
            "/etc/x",
            ".hidden",
        ] {
            assert!(sanitize_stem(bad).is_err(), "must reject {bad:?}");
        }
    }

    // --- filesystem glue (deterministic: private temp dirs, no watcher, no races) --------

    fn test_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("termixion-themes-io-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create test dir");
        dir
    }

    #[test]
    fn write_atomic_writes_content_creates_parents_and_leaves_no_residue() {
        let dir = test_dir("atomic");
        let path = dir.join("nested").join("dracula.toml");
        write_atomic(&path, "body").expect("write");
        assert_eq!(std::fs::read_to_string(&path).expect("read back"), "body");
        let residue = std::fs::read_dir(path.parent().expect("parent"))
            .expect("read dir")
            .count();
        assert_eq!(residue, 1, "only the target file may remain");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_theme_in_writes_the_stem_toml_and_returns_its_path() {
        let dir = test_dir("write-theme");
        let returned = write_theme_in(&dir, "dracula", MINIMAL).expect("write");
        let expected = dir.join("dracula.toml");
        assert_eq!(returned, expected.display().to_string());
        assert_eq!(
            std::fs::read_to_string(&expected).expect("read back"),
            MINIMAL
        );
        // And it round-trips through the reader as a single valid theme.
        let entries = read_entries_in(&dir);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "user:dracula");
        assert!(entries[0].valid);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_theme_in_rejects_a_bad_stem_without_writing() {
        let dir = test_dir("write-theme-bad");
        assert!(write_theme_in(&dir, "../evil", MINIMAL).is_err());
        let count = std::fs::read_dir(&dir).expect("read dir").count();
        assert_eq!(count, 0, "a rejected write must not create any file");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_entries_in_lists_valid_and_invalid_sorted_ignoring_non_toml_dotfiles_and_dirs() {
        let dir = test_dir("list");
        std::fs::write(dir.join("zeta.toml"), MINIMAL).expect("write zeta");
        std::fs::write(dir.join("alpha.toml"), INVALID).expect("write alpha");
        std::fs::write(dir.join("notes.md"), "not a theme").expect("write md");
        std::fs::write(dir.join(".hidden.toml"), MINIMAL).expect("write dotfile");
        // A directory whose name looks like a theme file exercises the non-file skip.
        std::fs::create_dir_all(dir.join("subdir.toml")).expect("create dir");
        let entries = read_entries_in(&dir);
        // Only alpha.toml + zeta.toml survive, sorted by id.
        let ids: Vec<&str> = entries.iter().map(|entry| entry.id.as_str()).collect();
        assert_eq!(ids, vec!["user:alpha", "user:zeta"]);
        // alpha is invalid (with warnings), zeta is valid.
        assert!(!entries[0].valid);
        assert!(entries[0].spec.is_none());
        assert!(!entries[0].warnings.is_empty());
        assert!(entries[1].valid);
        assert!(entries[1].spec.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_entries_in_missing_dir_is_empty() {
        let dir = test_dir("missing");
        let ghost = dir.join("does-not-exist");
        assert!(read_entries_in(&ghost).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
