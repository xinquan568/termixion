// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-93 (FR-5): the PURE scripting helpers. Two jobs, no filesystem and no panics (R1/R2/R3):
//!
//! 1. **Tree-shaping** — [`shape_scripts`] orders the flat list of script paths the tauri shell
//!    discovers (relative to the scripts root) into the folders-first, alphabetical order the picker
//!    renders. The on-disk tree IS the nested list (vision 5.1c); this only *orders* it.
//! 2. **Shell escaping** — [`shell_single_quote`] / [`source_command`] turn an absolute path into the
//!    exact `source '<path>'` line the shell runs (sourcing, not executing, so a script's `cd`/env
//!    persists in the interactive shell). Single-quote-escaped so spaces/quotes/unicode are safe.
//!
//! The fs walk and the `.sh`-optional discovery rules live in the tauri shell (`scripts_io`); this
//! crate never touches the filesystem, matching config.rs's pure-decision discipline.

use std::cmp::Ordering;

/// One discovered script, shaped for the picker. `rel_path` is the path relative to the scripts
/// root (folder segments intact) — the display + startup-match key; `name` is the leaf with a
/// trailing `.sh` dropped for display (the suffix is optional, so `work/run` and `work/run.sh` both
/// show `run`). Serializes camelCase to match the frontend catalog shape.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptEntry {
    pub rel_path: String,
    pub name: String,
}

/// Order the discovered relative script paths **folders-first, then alphabetical**, deduped. At the
/// first path segment where two entries differ, a segment that descends into a subfolder sorts
/// before a leaf file at that level (so grouped folders lead), otherwise segments compare
/// lexicographically. Pure: the tauri walk discovers the paths, this only shapes them.
pub fn shape_scripts(rel_paths: Vec<String>) -> Vec<ScriptEntry> {
    let mut paths = rel_paths;
    paths.sort_by(|a, b| cmp_rel_path(a, b));
    paths.dedup();
    paths
        .into_iter()
        .map(|rel_path| {
            let name = leaf_name(&rel_path);
            ScriptEntry { rel_path, name }
        })
        .collect()
}

/// The display name of a script path: its last `/`-segment with a single trailing `.sh` removed.
fn leaf_name(rel_path: &str) -> String {
    let leaf = rel_path.rsplit('/').next().unwrap_or(rel_path);
    leaf.strip_suffix(".sh").unwrap_or(leaf).to_string()
}

/// Folders-first, then lexicographic, comparison of two relative script paths by path segment.
fn cmp_rel_path(a: &str, b: &str) -> Ordering {
    let sa: Vec<&str> = a.split('/').collect();
    let sb: Vec<&str> = b.split('/').collect();
    let mut i = 0;
    loop {
        match (sa.get(i), sb.get(i)) {
            (Some(x), Some(y)) => {
                if x == y {
                    i += 1;
                    continue;
                }
                // The segments differ here. A path with more segments after `i` is descending into
                // a subfolder; it leads a leaf file at the same level (folders-first).
                let a_is_dir = i + 1 < sa.len();
                let b_is_dir = i + 1 < sb.len();
                return match (a_is_dir, b_is_dir) {
                    (true, false) => Ordering::Less,
                    (false, true) => Ordering::Greater,
                    _ => x.cmp(y),
                };
            }
            (Some(_), None) => return Ordering::Greater,
            (None, Some(_)) => return Ordering::Less,
            (None, None) => return Ordering::Equal,
        }
    }
}

/// Wrap `text` in a POSIX single-quoted string, escaping any embedded single quote as `'\''`
/// (close-quote, escaped-quote, re-open-quote). The result is safe to hand a shell verbatim — no
/// interior byte is special inside single quotes. Never panics.
pub fn shell_single_quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('\'');
    for ch in text.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// The `source '<abs-path>'` command that runs a script IN the interactive shell (so its `cd`/env
/// persists). `abs_path` is single-quote-escaped ([`shell_single_quote`]).
pub fn source_command(abs_path: &str) -> String {
    format!("source {}", shell_single_quote(abs_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shaped(paths: &[&str]) -> Vec<(String, String)> {
        shape_scripts(paths.iter().map(|p| p.to_string()).collect())
            .into_iter()
            .map(|e| (e.rel_path, e.name))
            .collect()
    }

    #[test]
    fn shape_orders_folders_first_then_alphabetical() {
        // top-level files interleave AFTER folder groups at each level; folders sort among themselves.
        let out = shaped(&["z.sh", "work/b.sh", "alpha.sh", "work/a.sh", "tools/x.sh"]);
        let rels: Vec<&str> = out.iter().map(|(r, _)| r.as_str()).collect();
        assert_eq!(
            rels,
            vec!["tools/x.sh", "work/a.sh", "work/b.sh", "alpha.sh", "z.sh"]
        );
    }

    #[test]
    fn shape_derives_leaf_name_dropping_optional_sh() {
        let out = shaped(&["work/proj-x.sh", "run", "a.b.sh"]);
        let names: Vec<(&str, &str)> = out.iter().map(|(r, n)| (r.as_str(), n.as_str())).collect();
        // rel_path keeps the full path + extension; name is the leaf minus a single trailing `.sh`.
        assert!(names.contains(&("work/proj-x.sh", "proj-x")));
        assert!(names.contains(&("run", "run")));
        assert!(names.contains(&("a.b.sh", "a.b")));
    }

    #[test]
    fn shape_dedupes_and_handles_empty() {
        assert_eq!(shape_scripts(Vec::new()), Vec::new());
        let out = shaped(&["a.sh", "a.sh", "b.sh"]);
        let rels: Vec<&str> = out.iter().map(|(r, _)| r.as_str()).collect();
        assert_eq!(rels, vec!["a.sh", "b.sh"]);
    }

    #[test]
    fn shape_orders_deeply_nested_paths_deterministically() {
        let out = shaped(&["a/b/c.sh", "a/b.sh", "a/b/a.sh", "a/a.sh"]);
        let rels: Vec<&str> = out.iter().map(|(r, _)| r.as_str()).collect();
        // Under `a/`: the `b/` subfolder (a/b/a.sh, a/b/c.sh) leads the leaf files a/a.sh, a/b.sh.
        assert_eq!(rels, vec!["a/b/a.sh", "a/b/c.sh", "a/a.sh", "a/b.sh"]);
    }

    #[test]
    fn single_quote_wraps_plain_text() {
        assert_eq!(shell_single_quote("plain"), "'plain'");
        assert_eq!(shell_single_quote(""), "''");
    }

    #[test]
    fn single_quote_preserves_spaces_and_unicode() {
        assert_eq!(shell_single_quote("my proj.sh"), "'my proj.sh'");
        assert_eq!(shell_single_quote("café/naïve.sh"), "'café/naïve.sh'");
    }

    #[test]
    fn single_quote_escapes_embedded_quotes() {
        // a'b  →  'a'\''b'   (close, escaped-quote, reopen)
        assert_eq!(shell_single_quote("a'b"), "'a'\\''b'");
        // two quotes
        assert_eq!(shell_single_quote("'x'"), "''\\''x'\\'''");
    }

    #[test]
    fn source_command_wraps_the_escaped_path() {
        assert_eq!(
            source_command("/Users/me/.config/termixion/scripts/work/proj-x.sh"),
            "source '/Users/me/.config/termixion/scripts/work/proj-x.sh'"
        );
        assert_eq!(
            source_command("/x/demo/my proj.sh"),
            "source '/x/demo/my proj.sh'"
        );
        assert_eq!(source_command("/x/it's.sh"), "source '/x/it'\\''s.sh'");
    }

    #[test]
    fn script_entry_serializes_camel_case() {
        let entry = ScriptEntry {
            rel_path: "work/proj-x.sh".to_string(),
            name: "proj-x".to_string(),
        };
        let json = serde_json::to_value(&entry).expect("serialize");
        assert_eq!(json["relPath"], serde_json::json!("work/proj-x.sh"));
        assert_eq!(json["name"], serde_json::json!("proj-x"));
    }
}
