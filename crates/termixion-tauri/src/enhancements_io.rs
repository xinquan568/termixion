// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-206: the impure half of the zsh enhancement layer — embedded vendored plugin payloads,
//! tear-safe versioned materialization under the Termixion-managed XDG config tree, and the ONE
//! spawn-side decision function (`enhancement_env`) whose `None` IS the kill switch / bypass:
//! smoke/perf launches, non-zsh shells, and `enhancements = false` yield `None` without ever
//! touching the filesystem, keeping those spawns byte-identical to the baseline.
//!
//! Atomicity model (no swap, no shared pointer): content lands at
//! `<base>/versions/<key>/{zdotdir,plugins}` where `<key>` hashes the shim version, app version,
//! and embedded content. A version directory is built under a staging name and renamed into
//! place once — `.complete` written last inside staging, so post-rename its presence proves the
//! whole tree. Each spawn's env carries FULL versioned paths; a session outlives refreshes on
//! its own (retained) version, and a mid-refresh spawn resolves a complete old or new tree,
//! never a mix.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use include_dir::{Dir, include_dir};
use termixion_core::config::ShellConfig;
use termixion_core::zdotdir::{
    ENV_AUTOSUGGEST, ENV_HIGHLIGHT, ENV_ORIG_ZDOTDIR, ENV_PLUGINS_DIR, SHIM_VERSION, shim_files,
};

/// The vendored plugin trees (single source of truth: `resources/shell-enhancements/`).
static PLUGINS: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/../../resources/shell-enhancements");

/// The materialized, version-pinned paths one spawn points its env at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Materialized {
    pub zdotdir: PathBuf,
    pub plugins_dir: PathBuf,
}

/// `$XDG_CONFIG_HOME` wins; otherwise `<home>/.config` — then `termixion/shell-enhancements`
/// (the same XDG base rules as `shell_integration_io`).
pub fn enhancements_dir_from(xdg_config_home: Option<&str>, home: &str) -> PathBuf {
    let base = match xdg_config_home.filter(|dir| !dir.is_empty()) {
        Some(xdg) => PathBuf::from(xdg),
        None => Path::new(home).join(".config"),
    };
    base.join("termixion").join("shell-enhancements")
}

/// The production base dir, from the real environment.
pub fn default_base_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "no $HOME".to_string())?;
    let xdg = std::env::var("XDG_CONFIG_HOME").ok();
    Ok(enhancements_dir_from(xdg.as_deref(), &home))
}

/// The refresh key: shim version + app version + embedded-content hash. Any change to the
/// generated shim text or the vendored trees produces a new immutable version directory.
fn version_key() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    SHIM_VERSION.hash(&mut hasher);
    env!("CARGO_PKG_VERSION").hash(&mut hasher);
    for (name, content) in shim_files() {
        name.hash(&mut hasher);
        content.hash(&mut hasher);
    }
    hash_embedded(&PLUGINS, &mut hasher);
    format!("v{SHIM_VERSION}-{:016x}", hasher.finish())
}

fn hash_embedded(dir: &Dir<'_>, hasher: &mut impl std::hash::Hasher) {
    use std::hash::Hash;
    for file in dir.files() {
        file.path().to_string_lossy().hash(hasher);
        file.contents().hash(hasher);
    }
    for sub in dir.dirs() {
        hash_embedded(sub, hasher);
    }
}

fn paths_for(version_dir: &Path) -> Materialized {
    Materialized {
        zdotdir: version_dir.join("zdotdir"),
        plugins_dir: version_dir.join("plugins"),
    }
}

fn write_embedded(dir: &Dir<'_>, under: &Path) -> Result<(), String> {
    for sub in dir.dirs() {
        write_embedded(sub, under)?;
    }
    for file in dir.files() {
        let target = under.join(file.path());
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {parent:?}: {e}"))?;
        }
        std::fs::write(&target, file.contents()).map_err(|e| format!("write {target:?}: {e}"))?;
    }
    Ok(())
}

/// Materialize (or reuse) the current version. Idempotent and cheap when current: one stat.
pub fn materialize_enhancements(base: &Path) -> Result<Materialized, String> {
    let key = version_key();
    let versions = base.join("versions");
    let version_dir = versions.join(&key);
    if version_dir.join(".complete").is_file() {
        return Ok(paths_for(&version_dir));
    }

    // Unique per CALL (finding 2): concurrent open_pty materializers in one process must never
    // share a staging path — pid alone collides; the atomic counter disambiguates.
    static STAGING_NONCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nonce = STAGING_NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let staging = versions.join(format!(".staging-{key}-{}-{nonce}", std::process::id()));
    let _ = std::fs::remove_dir_all(&staging);
    let zdotdir = staging.join("zdotdir");
    std::fs::create_dir_all(&zdotdir).map_err(|e| format!("mkdir {zdotdir:?}: {e}"))?;
    for (name, content) in shim_files() {
        std::fs::write(zdotdir.join(name), content).map_err(|e| format!("write {name}: {e}"))?;
    }
    write_embedded(&PLUGINS, &staging.join("plugins"))?;
    // The marker is written LAST inside staging: after the single rename below, its presence
    // under the version dir proves the whole tree arrived.
    std::fs::write(staging.join(".complete"), &key).map_err(|e| format!("marker: {e}"))?;

    match std::fs::rename(&staging, &version_dir) {
        Ok(()) => {}
        Err(_) if version_dir.join(".complete").is_file() => {
            // A concurrent materializer won the rename — use its (complete) tree.
            let _ = std::fs::remove_dir_all(&staging);
        }
        Err(_) if version_dir.exists() => {
            // An INCOMPLETE tree (a crashed earlier materializer) blocks the rename — replace
            // it wholesale; consumers never selected it (no .complete marker).
            std::fs::remove_dir_all(&version_dir)
                .map_err(|e| format!("clear incomplete {version_dir:?}: {e}"))?;
            std::fs::rename(&staging, &version_dir)
                .map_err(|e| format!("install {version_dir:?}: {e}"))?;
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!("install {version_dir:?}: {e}"));
        }
    }
    gc_stale_versions(&versions, &key);
    Ok(paths_for(&version_dir))
}

/// Best-effort retention: keep the current version + the most recent other COMPLETE one (a
/// long-lived session may still be pointing at it — an incomplete tree was never selectable and
/// holds no retention slot, step-8 finding 3); drop older/incomplete versions. Staging dirs
/// belong to their builder — only AGE-STALE ones (a crashed builder) are swept, never a live
/// concurrent build (step-8 finding 2).
fn gc_stale_versions(versions: &Path, current: &str) {
    const STALE_STAGING: Duration = Duration::from_secs(60 * 60);
    let Ok(entries) = std::fs::read_dir(versions) else {
        return;
    };
    let mut complete_others: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name == current {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        if name.starts_with(".staging-") {
            let age_stale = std::time::SystemTime::now()
                .duration_since(modified)
                .map(|age| age > STALE_STAGING)
                .unwrap_or(false);
            if age_stale {
                let _ = std::fs::remove_dir_all(&path);
            }
            continue;
        }
        if path.join(".complete").is_file() {
            complete_others.push((modified, path));
        } else {
            // Never selectable — a crashed materializer's leftover; safe to drop.
            let _ = std::fs::remove_dir_all(&path);
        }
    }
    complete_others.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in complete_others.into_iter().skip(1) {
        let _ = std::fs::remove_dir_all(&path);
    }
}

/// THE spawn-side decision (the plan's spyable seam). `None` — with the materializer provably
/// un-invoked — for special launches (smoke/perf), non-zsh effective shells, the master kill
/// switch, and the nothing-to-layer case; the spawn then proceeds byte-identical to the
/// baseline. `Some(env)` carries the full contract: version-pinned ZDOTDIR + plugins dir,
/// per-plugin flags, and the original ZDOTDIR only when the app process actually has one.
/// A materializer error degrades to `None` (log) — never a failed spawn.
pub fn enhancement_env(
    special_launch: bool,
    effective_program: &std::ffi::OsStr,
    shell: &ShellConfig,
    inherited_zdotdir: Option<OsString>,
    materialize: impl FnOnce() -> Result<Materialized, String>,
) -> Option<Vec<(OsString, OsString)>> {
    if special_launch || !shell.enhancements {
        return None;
    }
    if !shell.autosuggestions && !shell.syntax_highlighting {
        return None; // nothing to layer — don't shim at all
    }
    let basename = Path::new(effective_program).file_name()?.to_str()?;
    if basename != "zsh" {
        return None;
    }
    let materialized = match materialize() {
        Ok(m) => m,
        Err(error) => {
            eprintln!("termixion: shell enhancements unavailable (spawning bare): {error}");
            return None;
        }
    };
    let mut env: Vec<(OsString, OsString)> = vec![
        (
            OsString::from("ZDOTDIR"),
            materialized.zdotdir.into_os_string(),
        ),
        (
            OsString::from(ENV_PLUGINS_DIR),
            materialized.plugins_dir.into_os_string(),
        ),
    ];
    if shell.autosuggestions {
        env.push((OsString::from(ENV_AUTOSUGGEST), OsString::from("1")));
    }
    if shell.syntax_highlighting {
        env.push((OsString::from(ENV_HIGHLIGHT), OsString::from("1")));
    }
    if let Some(orig) = inherited_zdotdir {
        env.push((OsString::from(ENV_ORIG_ZDOTDIR), orig));
    }
    Some(env)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn zsh() -> OsString {
        OsString::from("/bin/zsh")
    }

    fn spy<'a>(
        called: &'a Cell<bool>,
        result: Materialized,
    ) -> impl FnOnce() -> Result<Materialized, String> + 'a {
        move || {
            called.set(true);
            Ok(result)
        }
    }

    fn fake_materialized() -> Materialized {
        Materialized {
            zdotdir: PathBuf::from("/fake/zdotdir"),
            plugins_dir: PathBuf::from("/fake/plugins"),
        }
    }

    #[test]
    fn bypasses_never_touch_the_materializer() {
        // smoke/perf, master-off, non-zsh, nothing-to-layer: None AND zero materializer calls —
        // the no-writes half of the kill-switch/bypass guarantee.
        let cases: Vec<(bool, OsString, ShellConfig)> = vec![
            (true, zsh(), ShellConfig::default()), // special launch
            (
                false,
                zsh(),
                ShellConfig {
                    enhancements: false,
                    ..ShellConfig::default()
                },
            ),
            (false, OsString::from("/bin/bash"), ShellConfig::default()),
            (
                false,
                OsString::from("/opt/homebrew/bin/fish"),
                ShellConfig::default(),
            ),
            (
                false,
                zsh(),
                ShellConfig {
                    autosuggestions: false,
                    syntax_highlighting: false,
                    ..ShellConfig::default()
                },
            ),
        ];
        for (special, program, config) in cases {
            let called = Cell::new(false);
            let env = enhancement_env(
                special,
                &program,
                &config,
                Some(OsString::from("/orig")),
                spy(&called, fake_materialized()),
            );
            assert_eq!(env, None, "{program:?} special={special}");
            assert!(!called.get(), "materializer must not run for {program:?}");
        }
    }

    #[test]
    fn enabled_zsh_carries_the_full_contract_env() {
        let called = Cell::new(false);
        let env = enhancement_env(
            false,
            &zsh(),
            &ShellConfig::default(),
            Some(OsString::from("/users/original/zdot")),
            spy(&called, fake_materialized()),
        )
        .expect("enhances");
        assert!(called.get());
        let get = |key: &str| env.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
        assert_eq!(get("ZDOTDIR"), Some(OsString::from("/fake/zdotdir")));
        assert_eq!(get(ENV_PLUGINS_DIR), Some(OsString::from("/fake/plugins")));
        assert_eq!(get(ENV_AUTOSUGGEST), Some(OsString::from("1")));
        assert_eq!(get(ENV_HIGHLIGHT), Some(OsString::from("1")));
        assert_eq!(
            get(ENV_ORIG_ZDOTDIR),
            Some(OsString::from("/users/original/zdot"))
        );
    }

    #[test]
    fn orig_zdotdir_is_absent_when_the_process_has_none_and_flags_follow_config() {
        let called = Cell::new(false);
        let env = enhancement_env(
            false,
            &zsh(),
            &ShellConfig {
                syntax_highlighting: false,
                ..ShellConfig::default()
            },
            None,
            spy(&called, fake_materialized()),
        )
        .expect("enhances");
        assert!(env.iter().all(|(k, _)| k != ENV_ORIG_ZDOTDIR));
        assert!(env.iter().any(|(k, _)| k == ENV_AUTOSUGGEST));
        assert!(env.iter().all(|(k, _)| k != ENV_HIGHLIGHT));
    }

    #[test]
    fn materializer_error_degrades_to_a_bare_spawn() {
        let env = enhancement_env(false, &zsh(), &ShellConfig::default(), None, || {
            Err("disk full".to_string())
        });
        assert_eq!(env, None);
    }

    #[test]
    fn materialization_is_idempotent_versioned_and_tear_safe() {
        let base = std::env::temp_dir().join(format!("trmx206-mat-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);

        let first = materialize_enhancements(&base).expect("materializes");
        assert!(first.zdotdir.join(".zshrc").is_file());
        assert!(
            first
                .plugins_dir
                .join("zsh-autosuggestions/zsh-autosuggestions.zsh")
                .is_file()
        );
        assert!(
            first
                .plugins_dir
                .join("zsh-syntax-highlighting/highlighters/main/main-highlighter.zsh")
                .is_file()
        );
        // The version dir is complete-marked; a second call reuses it (pure stat path).
        let version_dir = first.zdotdir.parent().unwrap().to_path_buf();
        assert!(version_dir.join(".complete").is_file());
        let modified_before = std::fs::metadata(first.zdotdir.join(".zshrc"))
            .unwrap()
            .modified()
            .unwrap();
        let second = materialize_enhancements(&base).expect("idempotent");
        assert_eq!(first, second);
        let modified_after = std::fs::metadata(second.zdotdir.join(".zshrc"))
            .unwrap()
            .modified()
            .unwrap();
        assert_eq!(modified_before, modified_after, "no rewrite when current");

        // Read-during-refresh: an incomplete version dir (no .complete) is never selected —
        // a fresh materialization rebuilds it completely.
        std::fs::remove_file(version_dir.join(".complete")).unwrap();
        std::fs::remove_dir_all(version_dir.join("plugins")).unwrap();
        let rebuilt = materialize_enhancements(&base).expect("rebuilds an incomplete tree");
        assert!(
            rebuilt
                .plugins_dir
                .join("zsh-autosuggestions/zsh-autosuggestions.zsh")
                .is_file()
        );
        assert!(version_dir.join(".complete").is_file());

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn concurrent_materializers_coexist_and_converge() {
        // finding 2: distinct staging paths per call — N threads all succeed and agree.
        let base = std::env::temp_dir().join(format!("trmx206-conc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let results: Vec<_> = std::thread::scope(|scope| {
            (0..4)
                .map(|_| scope.spawn(|| materialize_enhancements(&base)))
                .collect::<Vec<_>>()
                .into_iter()
                .map(|handle| handle.join().expect("no panic").expect("materializes"))
                .collect()
        });
        for result in &results {
            assert_eq!(result, &results[0]);
            assert!(result.zdotdir.join(".zshrc").is_file());
        }
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn gc_retains_only_complete_versions_and_spares_fresh_staging() {
        // finding 3: an incomplete recent dir must not consume the retention slot; a FRESH
        // staging dir (a live concurrent builder) must survive the sweep.
        let base = std::env::temp_dir().join(format!("trmx206-gc-{}", std::process::id()));
        let versions = base.join("versions");
        let _ = std::fs::remove_dir_all(&base);
        let old_complete = versions.join("v0-oldcomplete");
        let incomplete = versions.join("v0-incomplete");
        let live_staging = versions.join(".staging-v0-live-1-0");
        for dir in [&old_complete, &incomplete, &live_staging] {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(old_complete.join(".complete"), "v0").unwrap();
        let current = materialize_enhancements(&base).expect("materializes current");
        assert!(current.zdotdir.is_dir());
        assert!(
            old_complete.is_dir(),
            "the complete previous version is retained"
        );
        assert!(
            !incomplete.exists(),
            "an incomplete dir never holds the slot"
        );
        assert!(
            live_staging.is_dir(),
            "a fresh staging dir is another builder's — spared"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn xdg_base_rules_match_the_house_convention() {
        assert_eq!(
            enhancements_dir_from(Some("/xdg"), "/home/u"),
            PathBuf::from("/xdg/termixion/shell-enhancements")
        );
        assert_eq!(
            enhancements_dir_from(None, "/home/u"),
            PathBuf::from("/home/u/.config/termixion/shell-enhancements")
        );
        assert_eq!(
            enhancements_dir_from(Some(""), "/home/u"),
            PathBuf::from("/home/u/.config/termixion/shell-enhancements")
        );
    }
}
