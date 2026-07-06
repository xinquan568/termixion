// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-93 (FR-5): the scripts' I/O edge — discover the plain shell files under
//! `~/.config/termixion/scripts/` (nested folders are the grouping), shape them via core's pure
//! [`shape_scripts`](termixion_core::shape_scripts), and watch the subtree for edits emitting
//! `scripts:changed`. Mirrors [`crate::themes_io`]'s layering: the **core** shapes/escapes (no
//! filesystem), and this shell does the fs — the recursive walk, the "open scripts folder"
//! affordance, and the directory watch.
//!
//! Two honest divergences from themes_io: the scripts store is a **tree**, so the walk is
//! recursive (depth-capped, symlinks not followed, hidden/non-file skipped) and the watch is
//! `Recursive`. The escaped `source '<abs>'` line each entry carries is computed by core
//! ([`source_command`](termixion_core::source_command)) so the frontend never re-implements the
//! escaping (trmx-93 review finding 1).

use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::Emitter;
use tauri_plugin_opener::OpenerExt;
use termixion_core::{shape_scripts, source_command};

// ---------------------------------------------------------------------------
// Path resolution (the same XDG base as config_io/themes_io, then `termixion/scripts`)
// ---------------------------------------------------------------------------

/// The maximum folder nesting the walk descends (guardrail against a pathological tree / symlink
/// loop even though symlinks are not followed). Files up to this depth below the root are listed.
const MAX_DEPTH: usize = 8;

/// Resolve the user scripts directory from the given environment values (pure). A non-empty
/// `$XDG_CONFIG_HOME` wins; otherwise `<home>/.config` (the XDG default), then `termixion/scripts`.
pub fn scripts_dir_from(xdg_config_home: Option<&str>, home: &str) -> PathBuf {
    let base = match xdg_config_home.filter(|dir| !dir.is_empty()) {
        Some(xdg) => PathBuf::from(xdg),
        None => Path::new(home).join(".config"),
    };
    base.join("termixion").join("scripts")
}

/// The real user scripts directory, from the process environment.
pub fn scripts_dir() -> PathBuf {
    let xdg = std::env::var("XDG_CONFIG_HOME").ok();
    let home = std::env::var("HOME").unwrap_or_default();
    scripts_dir_from(xdg.as_deref(), &home)
}

// ---------------------------------------------------------------------------
// Pure decision pieces
// ---------------------------------------------------------------------------

/// Whether a filesystem path names a script the watcher should react to: a non-hidden entry (its
/// file name does not start with `.`). This drops dotfiles and editors' hidden temp/swap files; a
/// `scripts:changed` signal only over-fires into a cheap re-read, so the filter stays permissive
/// (`.sh` is optional — any plain file can be a script). Works for **nested** paths (the recursive
/// watch), unlike themes' flat `.toml` filter.
fn is_script_event_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| !name.starts_with('.'))
}

/// One script in the frontend catalog: `relPath` (the display + startup-match key), `name` (leaf),
/// and `sourceLine` — the ready-to-send `source '<abs>'` command computed by core so the frontend
/// never re-implements the escaping. Serializes camelCase.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptListEntry {
    rel_path: String,
    name: String,
    source_line: String,
}

// ---------------------------------------------------------------------------
// Filesystem glue (path-parameterized so tests can drive it against a temp dir)
// ---------------------------------------------------------------------------

/// Recursively collect the relative paths (root-relative, `/`-joined) of the plain files under
/// `root`: hidden entries skipped, non-files skipped, symlinks NOT followed (a symlinked dir has a
/// symlink file-type, not a dir file-type, so the walk never descends it), bounded by [`MAX_DEPTH`].
/// A missing/unreadable directory yields an empty vec (not an error).
fn read_rel_paths_in(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    walk(root, root, 0, &mut out);
    out
}

fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<String>) {
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return; // a missing/unreadable dir is simply "nothing here"
    };
    for entry in read_dir.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.starts_with('.') {
            continue; // hidden files/dirs are skipped
        }
        // file_type() does NOT follow symlinks: a symlinked directory reports is_symlink(), so it
        // is neither is_dir() nor is_file() below and is silently skipped (no symlink traversal).
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            if depth < MAX_DEPTH {
                walk(root, &path, depth + 1, out);
            }
        } else if file_type.is_file()
            && let Ok(rel) = path.strip_prefix(root)
            && let Some(rel_str) = rel.to_str()
        {
            out.push(rel_str.to_string());
        }
    }
}

/// The core of `scripts_list` (path-parameterized): discover + shape (core) + attach each entry's
/// core-computed `source '<abs>'` line.
fn list_scripts_in(root: &Path) -> Vec<ScriptListEntry> {
    shape_scripts(read_rel_paths_in(root))
        .into_iter()
        .map(|entry| {
            let abs = root.join(&entry.rel_path);
            ScriptListEntry {
                source_line: source_command(&abs.to_string_lossy()),
                rel_path: entry.rel_path,
                name: entry.name,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// List every script under the scripts directory into the frontend catalog (folders-first, sorted;
/// each entry carries its ready-to-source command). A missing scripts directory is not an error.
#[tauri::command]
pub fn scripts_list() -> Vec<ScriptListEntry> {
    list_scripts_in(&scripts_dir())
}

/// Create the scripts directory if absent, then open it in the OS file manager (Finder) via the
/// opener plugin — the "Open scripts folder" affordance so a user can drop in / edit script files.
#[tauri::command]
pub fn scripts_open_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = scripts_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("could not create {}: {error}", dir.display()))?;
    app.opener()
        .open_path(dir.display().to_string(), None::<&str>)
        .map_err(|error| format!("could not open {}: {error}", dir.display()))
}

// ---------------------------------------------------------------------------
// The scripts-dir watcher (spawned once from `setup`, like the themes watcher — but RECURSIVE)
// ---------------------------------------------------------------------------

/// Quiet period after the last filesystem event before signalling — editors save via temp+rename
/// bursts, and one coalesced signal beats N intermediate ones (mirrors the themes watcher).
const SCRIPTS_DEBOUNCE: Duration = Duration::from_millis(250);

/// Watch the scripts DIRECTORY TREE for edits and signal the frontend to re-read. Unlike the flat
/// themes watch this is `Recursive` (nested folders are the grouping mechanism). Best-effort: any
/// setup failure logs and disables watching rather than failing the app.
pub fn run_scripts_watcher(app: tauri::AppHandle) {
    use notify::{RecursiveMode, Watcher};

    let dir = scripts_dir();
    if let Err(err) = std::fs::create_dir_all(&dir) {
        eprintln!(
            "termixion: could not create {}: {err}; script file watching disabled",
            dir.display()
        );
        return;
    }
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let mut watcher =
        match notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
            if let Ok(event) = event
                && event.paths.iter().any(|path| is_script_event_path(path))
            {
                let _ = tx.send(());
            }
        }) {
            Ok(watcher) => watcher,
            Err(err) => {
                eprintln!("termixion: could not create the scripts watcher: {err}");
                return;
            }
        };
    if let Err(err) = watcher.watch(&dir, RecursiveMode::Recursive) {
        eprintln!(
            "termixion: could not watch {}: {err}; script file watching disabled",
            dir.display()
        );
        return;
    }
    loop {
        if rx.recv().is_err() {
            return; // channel closed — the watcher is gone
        }
        while rx.recv_timeout(SCRIPTS_DEBOUNCE).is_ok() {}
        let _ = app.emit("scripts:changed", ());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- path resolution -----------------------------------------------------------------

    #[test]
    fn scripts_dir_prefers_a_non_empty_xdg_config_home() {
        assert_eq!(
            scripts_dir_from(Some("/custom/xdg"), "/Users/me"),
            PathBuf::from("/custom/xdg/termixion/scripts")
        );
    }

    #[test]
    fn scripts_dir_falls_back_to_home_dot_config_when_xdg_unset_or_empty() {
        assert_eq!(
            scripts_dir_from(None, "/Users/me"),
            PathBuf::from("/Users/me/.config/termixion/scripts")
        );
        assert_eq!(
            scripts_dir_from(Some(""), "/Users/me"),
            PathBuf::from("/Users/me/.config/termixion/scripts")
        );
    }

    // --- is_script_event_path (the recursive-watcher filter, incl. NESTED paths) ----------

    #[test]
    fn is_script_event_path_accepts_nested_files_and_rejects_hidden_and_temp() {
        assert!(is_script_event_path(Path::new("/x/scripts/work/proj-x.sh")));
        assert!(is_script_event_path(Path::new("/x/scripts/run"))); // .sh optional
        assert!(!is_script_event_path(Path::new("/x/scripts/.hidden.sh")));
        assert!(!is_script_event_path(Path::new(
            "/x/scripts/work/.proj.sh.swp"
        )));
    }

    // --- filesystem glue (deterministic: private temp dirs, no watcher) -------------------

    fn test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "termixion-scripts-io-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create test dir");
        dir
    }

    #[test]
    fn read_rel_paths_discovers_nested_and_skips_hidden_and_dirs() {
        let dir = test_dir("walk");
        std::fs::create_dir_all(dir.join("work")).expect("mkdir work");
        std::fs::write(dir.join("top.sh"), "echo top").expect("write top");
        std::fs::write(dir.join("work/proj-x.sh"), "cd /tmp").expect("write nested");
        std::fs::write(dir.join(".hidden.sh"), "secret").expect("write hidden");
        std::fs::create_dir_all(dir.join(".git")).expect("mkdir hidden dir");
        std::fs::write(dir.join(".git/config"), "x").expect("write in hidden dir");
        let mut rels = read_rel_paths_in(&dir);
        rels.sort();
        assert_eq!(
            rels,
            vec!["top.sh".to_string(), "work/proj-x.sh".to_string()]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_rel_paths_does_not_follow_symlinked_dirs() {
        let dir = test_dir("symlink");
        // A real directory OUTSIDE the tree with a script in it.
        let outside = test_dir("symlink-outside");
        std::fs::write(outside.join("evil.sh"), "rm -rf /").expect("write outside");
        // A symlink inside the scripts tree pointing at it.
        std::os::unix::fs::symlink(&outside, dir.join("link")).expect("symlink");
        // A normal script so the tree isn't empty.
        std::fs::write(dir.join("ok.sh"), "echo ok").expect("write ok");
        let rels = read_rel_paths_in(&dir);
        // The symlinked dir is not descended: evil.sh must NOT appear.
        assert_eq!(rels, vec!["ok.sh".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn read_rel_paths_enforces_the_depth_cap() {
        let dir = test_dir("depth");
        // Build a chain deeper than MAX_DEPTH and drop a file at the very bottom.
        let mut deep = dir.clone();
        for i in 0..(MAX_DEPTH + 2) {
            deep = deep.join(format!("d{i}"));
        }
        std::fs::create_dir_all(&deep).expect("mkdir deep");
        std::fs::write(deep.join("too-deep.sh"), "x").expect("write deep");
        // And a shallow one that must be found.
        std::fs::write(dir.join("shallow.sh"), "x").expect("write shallow");
        let rels = read_rel_paths_in(&dir);
        assert!(rels.contains(&"shallow.sh".to_string()));
        assert!(
            !rels.iter().any(|r| r.ends_with("too-deep.sh")),
            "a file below the depth cap must not be listed: {rels:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_rel_paths_missing_dir_is_empty() {
        let dir = test_dir("missing");
        let ghost = dir.join("does-not-exist");
        assert!(read_rel_paths_in(&ghost).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_scripts_in_shapes_and_carries_the_core_source_line() {
        let dir = test_dir("list");
        std::fs::create_dir_all(dir.join("demo")).expect("mkdir demo");
        std::fs::write(dir.join("demo/my proj.sh"), "cd /tmp").expect("write spaced");
        let entries = list_scripts_in(&dir);
        assert_eq!(entries.len(), 1);
        let abs = dir.join("demo/my proj.sh");
        // sourceLine is core::source_command over the ABSOLUTE path (single-quote-escaped spaces).
        assert_eq!(
            entries[0].source_line,
            format!("source '{}'", abs.display())
        );
        assert_eq!(entries[0].rel_path, "demo/my proj.sh");
        assert_eq!(entries[0].name, "my proj");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn script_list_entry_serializes_camel_case() {
        let entry = ScriptListEntry {
            rel_path: "work/proj-x.sh".to_string(),
            name: "proj-x".to_string(),
            source_line: "source '/x/work/proj-x.sh'".to_string(),
        };
        let json = serde_json::to_value(&entry).expect("serialize");
        assert_eq!(json["relPath"], serde_json::json!("work/proj-x.sh"));
        assert_eq!(json["name"], serde_json::json!("proj-x"));
        assert_eq!(
            json["sourceLine"],
            serde_json::json!("source '/x/work/proj-x.sh'")
        );
    }
}
