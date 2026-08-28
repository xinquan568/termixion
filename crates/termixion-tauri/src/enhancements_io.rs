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
use termixion_core::config::{PromptChoice, ShellConfig};
use termixion_core::zdotdir::{
    ENV_AUTOSUGGEST, ENV_HIGHLIGHT, ENV_ORIG_ZDOTDIR, ENV_PLUGINS_DIR, ENV_PROMPT,
    ENV_STARSHIP_BIN, SHIM_VERSION, shim_files,
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
        // trmx-240: skipped for the same reason write_embedded skips them — and additionally so a
        // stray build-time `.zwc` cannot shift the version key and force every install to
        // re-materialize an identical tree.
        if !is_embeddable(file.path()) {
            continue;
        }
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

/// trmx-240 (L14): compiled zsh wordcode NEVER reaches a materialized tree, whatever is sitting in
/// `resources/` at build time.
///
/// This is the load-bearing half of the guard, and the git-side half cannot substitute for it:
/// `include_dir!` is a FILESYSTEM macro, so it embeds whatever is on disk and neither `.gitignore`
/// nor a `git ls-files` gate has any say. That matters concretely because the real-PTY tests point
/// p10k at `resources/shell-enhancements` directly, so `cargo test` leaves freshly-compiled `.zwc`
/// there — and CI's macOS job runs the tests BEFORE the packaged build. Without this filter a
/// test-then-build sequence would embed and ship the very blobs trmx-240 removed, while every git
/// guard reported clean.
fn is_embeddable(path: &Path) -> bool {
    path.extension().is_none_or(|ext| ext != "zwc")
}

fn write_embedded(dir: &Dir<'_>, under: &Path) -> Result<(), String> {
    for sub in dir.dirs() {
        write_embedded(sub, under)?;
    }
    for file in dir.files() {
        if !is_embeddable(file.path()) {
            continue;
        }
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

/// trmx-238 (M18): what the last real zsh spawn actually did with the enhancement layer.
///
/// Three states, not two: `NotObserved` is NOT a degraded mode — it is every bypass path (a
/// smoke/perf launch, a non-zsh shell, the master kill switch, nothing-to-layer) plus "no session
/// has started yet". Reporting those as "unavailable" would light up the UI for users who never
/// asked for enhancements.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum EnhancementsStatus {
    /// No zsh spawn has exercised the layer this session.
    #[default]
    NotObserved,
    /// The layer was applied to the last such spawn.
    Active,
    /// The last such spawn went bare, for this reason.
    Unavailable { reason: String },
}

/// trmx-238 (M18): the app-wide record of the last real spawn's enhancement outcome, behind the
/// `enhancements_status` command.
///
/// Managed Tauri state rather than an emission-only channel because the settings page needs to
/// ASK on mount, not only hear about changes.
#[derive(Default)]
pub struct EnhancementsState(std::sync::Mutex<EnhancementsStatus>);

/// Read the recorded status (pure over the state — `tauri::State` cannot be constructed in a unit
/// test, so every command here is a one-line wrapper over a helper like this).
pub fn read_status(state: &EnhancementsState) -> EnhancementsStatus {
    state
        .0
        .lock()
        .map(|inner| inner.clone())
        .unwrap_or_default()
}

/// Record the status. Returns `true` when it actually CHANGED, so the caller can emit only on a
/// real transition. A bypass (`NotObserved`) never overwrites a meaningful prior verdict: a
/// non-zsh pane opened next to a degraded zsh one must not erase the warning.
pub fn commit_status(state: &EnhancementsState, next: EnhancementsStatus) -> bool {
    let Ok(mut inner) = state.0.lock() else {
        return false;
    };
    if next == EnhancementsStatus::NotObserved && *inner != EnhancementsStatus::NotObserved {
        return false;
    }
    if *inner == next {
        return false;
    }
    *inner = next;
    true
}

/// trmx-238 (M18/D9): commit the spawn's enhancement verdict — but ONLY if the spawn actually
/// succeeded. Recording it beside the env computation (where the decision is made) would let a
/// session that never started claim "Active", which is precisely the class of lie this issue
/// exists to remove. Returns whether a real transition was recorded, so the caller emits once.
///
/// A named function rather than an `if` at the call site so the ordering rule is testable: a
/// `tauri::AppHandle` cannot be built in a unit test, but this can.
pub fn commit_after_spawn(
    spawn_succeeded: bool,
    state: &EnhancementsState,
    status: EnhancementsStatus,
) -> bool {
    if !spawn_succeeded {
        return false;
    }
    commit_status(state, status)
}

/// The event a committed transition broadcasts, so a MOUNTED settings page reflects a recovery
/// (or a new failure) without polling.
pub const ENHANCEMENTS_STATUS_EVENT: &str = "enhancements:status";

/// trmx-238 (M18): what the last real zsh spawn did with the enhancement layer. The Settings
/// toggles previously read "on" over a shell that had spawned bare.
#[tauri::command]
pub fn enhancements_status(state: tauri::State<'_, EnhancementsState>) -> EnhancementsStatus {
    read_status(&state)
}

/// trmx-238 (M18): the spawn env PLUS why it looks the way it does.
///
/// Before this, `enhancement_env` returned a bare `Option<Vec<..>>` and every reason for `None` —
/// deliberate bypass, materializer error, missing starship binary — was indistinguishable to the
/// caller and invisible to the user. The status is the missing half.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnhancementDecision {
    /// `Some(env)` layers the enhancements onto the spawn; `None` spawns byte-identical to the
    /// baseline. A `None` is never an error — a failed layer must never fail a shell.
    pub env: Option<Vec<(OsString, OsString)>>,
    /// What to report to the settings UI, committed only once the spawn actually succeeds.
    pub status: EnhancementsStatus,
}

impl EnhancementDecision {
    /// A deliberate bypass: no env, and nothing to tell the user about.
    fn bypassed() -> Self {
        Self {
            env: None,
            status: EnhancementsStatus::NotObserved,
        }
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
    resolve_starship: impl FnOnce() -> Option<PathBuf>,
    materialize: impl FnOnce() -> Result<Materialized, String>,
) -> EnhancementDecision {
    if special_launch || !shell.enhancements {
        return EnhancementDecision::bypassed();
    }
    if !shell.autosuggestions
        && !shell.syntax_highlighting
        && shell.prompt == PromptChoice::Existing
    {
        return EnhancementDecision::bypassed(); // nothing to layer — don't shim at all
    }
    let Some(basename) = Path::new(effective_program)
        .file_name()
        .and_then(|name| name.to_str())
    else {
        return EnhancementDecision::bypassed();
    };
    if basename != "zsh" {
        return EnhancementDecision::bypassed();
    }
    let materialized = match materialize() {
        Ok(m) => m,
        Err(error) => {
            log::warn!("termixion: shell enhancements unavailable (spawning bare): {error}");
            // trmx-238 (M18): the degrade is still silent to the SPAWN (a bare shell, never a
            // failure) but no longer silent to the USER — the reason rides back on the decision.
            return EnhancementDecision {
                env: None,
                status: EnhancementsStatus::Unavailable { reason: error },
            };
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
    // trmx-207: the chosen prompt rides the contract env; "existing" contributes nothing.
    if shell.prompt != PromptChoice::Existing {
        env.push((
            OsString::from(ENV_PROMPT),
            OsString::from(shell.prompt.as_str()),
        ));
    }
    // trmx-207 round 2 (lazy, step-8 finding 2): the resolver runs ONLY here — after every
    // bypass gate — so bypassed spawns never probe the filesystem.
    // trmx-238 (M18): an UNRESOLVED starship used to be the quietest failure in the app — the env
    // var simply stayed absent, the shim's `-x` guard kept the existing prompt, and Settings went
    // on showing the chosen prompt. The resolver reports no reason of its own, so author one.
    let mut status = EnhancementsStatus::Active;
    if shell.prompt == PromptChoice::Starship {
        match resolve_starship() {
            Some(bin) => env.push((OsString::from(ENV_STARSHIP_BIN), bin.into_os_string())),
            None => {
                status = EnhancementsStatus::Unavailable {
                    reason: "the Starship prompt is selected but no starship binary was found"
                        .to_string(),
                };
            }
        }
    }
    EnhancementDecision {
        env: Some(env),
        status,
    }
}

/// trmx-207: resolve the starship binary. The BUNDLED SIDECAR beside the app executable is
/// authoritative (deterministic version — used even when a system starship exists); the injected
/// `path_lookup` is a labeled dev/test-only convenience for unbundled builds, never the
/// acceptance path. Pure over its closures for testability.
pub fn resolve_starship_bin(
    exe_dir: Option<&Path>,
    path_lookup: impl Fn(&str) -> Option<PathBuf>,
) -> Option<PathBuf> {
    if let Some(dir) = exe_dir {
        let sidecar = dir.join("starship");
        if sidecar.is_file() {
            return Some(sidecar);
        }
    }
    path_lookup("starship")
}

/// The production inputs for [`resolve_starship_bin`]: the real exe dir + a real PATH probe.
pub fn default_starship_bin() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));
    resolve_starship_bin(exe_dir.as_deref(), |name| {
        let path = std::env::var_os("PATH")?;
        std::env::split_paths(&path)
            .map(|dir| dir.join(name))
            .find(|candidate| candidate.is_file())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- trmx-238 (M18): the status the last real spawn recorded --------------------------------

    // trmx-240 (L14): the embedding boundary is the guard that actually protects the SHIPPED app.
    #[test]
    fn wordcode_is_never_embeddable() {
        assert!(!is_embeddable(Path::new(
            "powerlevel10k/internal/p10k.zsh.zwc"
        )));
        assert!(!is_embeddable(Path::new("a.zwc")));
        // Everything else still ships, including files with no extension and lookalike names.
        assert!(is_embeddable(Path::new("powerlevel10k/internal/p10k.zsh")));
        assert!(is_embeddable(Path::new("pure/async.zsh")));
        assert!(is_embeddable(Path::new("gitstatus/install")));
        assert!(is_embeddable(Path::new("not-a.zwcx")));
        assert!(is_embeddable(Path::new("zwc")));
    }

    #[test]
    fn a_materialized_tree_contains_no_wordcode() {
        // The end-to-end assertion the git guards cannot make: whatever `include_dir!` picked up
        // from disk at build time, no `.zwc` reaches a materialized version directory. This fails
        // if the filter is removed AND the build tree carried wordcode — the exact CI
        // test-then-build sequence that would otherwise ship it.
        let base = std::env::temp_dir().join(format!("trmx240-mat-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let materialized = materialize_enhancements(&base).expect("materialize");
        let mut found: Vec<PathBuf> = Vec::new();
        let mut stack = vec![materialized.plugins_dir.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|e| e == "zwc") {
                    found.push(path);
                }
            }
        }
        let _ = std::fs::remove_dir_all(&base);
        assert!(
            found.is_empty(),
            "wordcode reached the materialized tree: {found:?}"
        );
    }

    #[test]
    fn a_failed_materializer_reports_the_error_string_and_still_spawns_bare() {
        // The spawn contract is unchanged — env None means byte-identical baseline — but the
        // reason is no longer swallowed by a log::warn.
        let decision = enhancement_env(
            false,
            &zsh(),
            &ShellConfig::default(),
            None,
            || None,
            || Err("plugins dir is read-only".to_string()),
        );
        assert_eq!(
            decision.env, None,
            "a failed layer must never fail the spawn"
        );
        assert_eq!(
            decision.status,
            EnhancementsStatus::Unavailable {
                reason: "plugins dir is read-only".to_string()
            }
        );
    }

    #[test]
    fn a_starship_prompt_with_no_binary_reports_an_authored_reason() {
        // The quietest failure in the app before trmx-238: the env var simply stayed absent, the
        // shim's `-x` guard kept the existing prompt, and Settings went on showing "Starship".
        // The resolver returns a bare None, so the reason has to be authored here.
        let called = Cell::new(false);
        let decision = enhancement_env(
            false,
            &zsh(),
            &ShellConfig {
                prompt: PromptChoice::Starship,
                ..ShellConfig::default()
            },
            None,
            || None,
            spy(&called, fake_materialized()),
        );
        assert!(decision.env.is_some(), "the other layers still apply");
        match decision.status {
            EnhancementsStatus::Unavailable { reason } => {
                assert!(reason.to_lowercase().contains("starship"), "{reason}")
            }
            other => panic!("expected Unavailable, got {other:?}"),
        }
    }

    #[test]
    fn an_applied_layer_reports_active() {
        let called = Cell::new(false);
        let decision = enhancement_env(
            false,
            &zsh(),
            &ShellConfig::default(),
            None,
            || None,
            spy(&called, fake_materialized()),
        );
        assert!(decision.env.is_some());
        assert_eq!(decision.status, EnhancementsStatus::Active);
    }

    #[test]
    fn commit_status_round_trips_and_reports_only_real_transitions() {
        let state = EnhancementsState::default();
        assert_eq!(read_status(&state), EnhancementsStatus::NotObserved);

        assert!(commit_status(&state, EnhancementsStatus::Active));
        assert_eq!(read_status(&state), EnhancementsStatus::Active);
        // Re-committing the same verdict is not a transition — no event, no re-emit.
        assert!(!commit_status(&state, EnhancementsStatus::Active));

        let down = EnhancementsStatus::Unavailable {
            reason: "boom".to_string(),
        };
        assert!(commit_status(&state, down.clone()));
        assert_eq!(read_status(&state), down);

        // A BYPASS must not erase a meaningful verdict: opening a non-zsh pane beside a degraded
        // zsh one would otherwise silently clear the warning.
        assert!(!commit_status(&state, EnhancementsStatus::NotObserved));
        assert_eq!(read_status(&state), down);

        // Recovery clears it.
        assert!(commit_status(&state, EnhancementsStatus::Active));
        assert_eq!(read_status(&state), EnhancementsStatus::Active);
    }

    #[test]
    fn a_failed_spawn_never_commits_its_verdict() {
        // The ordering rule (D9). A pane whose PTY failed to open must not leave "Active" behind,
        // and must not erase what the last SUCCESSFUL spawn reported.
        let state = EnhancementsState::default();
        let earlier = EnhancementsStatus::Unavailable {
            reason: "plugins dir is read-only".to_string(),
        };
        assert!(commit_after_spawn(true, &state, earlier.clone()));
        assert_eq!(read_status(&state), earlier);

        // A later spawn WOULD have reported Active — but it failed.
        assert!(!commit_after_spawn(
            false,
            &state,
            EnhancementsStatus::Active
        ));
        assert_eq!(
            read_status(&state),
            earlier,
            "a failed spawn leaves the previous verdict untouched"
        );

        // The next successful one does commit.
        assert!(commit_after_spawn(true, &state, EnhancementsStatus::Active));
        assert_eq!(read_status(&state), EnhancementsStatus::Active);
    }

    #[test]
    fn the_status_wire_shape_is_pinned() {
        // `tauri::State` cannot be constructed in a unit test, so the command itself is a
        // one-line wrapper over read_status; what matters here is the shape the frontend parses.
        assert_eq!(
            serde_json::to_value(EnhancementsStatus::NotObserved).expect("serializes"),
            serde_json::json!({ "state": "notObserved" })
        );
        assert_eq!(
            serde_json::to_value(EnhancementsStatus::Active).expect("serializes"),
            serde_json::json!({ "state": "active" })
        );
        assert_eq!(
            serde_json::to_value(EnhancementsStatus::Unavailable {
                reason: "no starship".to_string()
            })
            .expect("serializes"),
            serde_json::json!({ "state": "unavailable", "reason": "no starship" })
        );
    }

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
            let resolver_called = Cell::new(false);
            let env = enhancement_env(
                special,
                &program,
                &config,
                Some(OsString::from("/orig")),
                || {
                    resolver_called.set(true);
                    None
                },
                spy(&called, fake_materialized()),
            );
            assert_eq!(env.env, None, "{program:?} special={special}");
            assert!(!called.get(), "materializer must not run for {program:?}");
            assert!(
                !resolver_called.get(),
                "starship resolver must not run for {program:?} (lazy, round-2 F2)"
            );
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
            || None,
            spy(&called, fake_materialized()),
        )
        .env
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
            || None,
            spy(&called, fake_materialized()),
        )
        .env
        .expect("enhances");
        assert!(env.iter().all(|(k, _)| k != ENV_ORIG_ZDOTDIR));
        assert!(env.iter().any(|(k, _)| k == ENV_AUTOSUGGEST));
        assert!(env.iter().all(|(k, _)| k != ENV_HIGHLIGHT));
    }

    #[test]
    fn prompt_choice_rides_the_contract_env_and_extends_the_bypass() {
        // trmx-207: prompt-only config still shims; "existing" + no plugins bypasses entirely.
        let called = Cell::new(false);
        let env = enhancement_env(
            false,
            &zsh(),
            &ShellConfig {
                autosuggestions: false,
                syntax_highlighting: false,
                prompt: PromptChoice::Pure,
                ..ShellConfig::default()
            },
            None,
            || None,
            spy(&called, fake_materialized()),
        )
        .env
        .expect("a prompt alone is a reason to shim");
        assert!(env.iter().any(|(k, v)| k == ENV_PROMPT && v == "pure"));
        assert!(env.iter().all(|(k, _)| k != ENV_STARSHIP_BIN));

        let called = Cell::new(false);
        let env = enhancement_env(
            false,
            &zsh(),
            &ShellConfig {
                autosuggestions: false,
                syntax_highlighting: false,
                prompt: PromptChoice::Existing,
                ..ShellConfig::default()
            },
            None,
            || None,
            spy(&called, fake_materialized()),
        );
        assert_eq!(env.env, None, "existing + no plugins = nothing to layer");
        assert!(!called.get());
    }

    #[test]
    fn starship_env_carries_the_resolved_bin_or_stays_absent() {
        let called = Cell::new(false);
        let config = ShellConfig {
            prompt: PromptChoice::Starship,
            ..ShellConfig::default()
        };
        let env = enhancement_env(
            false,
            &zsh(),
            &config,
            None,
            || Some(PathBuf::from("/bundle/starship")),
            spy(&called, fake_materialized()),
        )
        .env
        .expect("enhances");
        assert!(
            env.iter()
                .any(|(k, v)| k == ENV_STARSHIP_BIN && v == "/bundle/starship")
        );
        assert!(env.iter().any(|(k, v)| k == ENV_PROMPT && v == "starship"));

        let called = Cell::new(false);
        let env = enhancement_env(
            false,
            &zsh(),
            &config,
            None,
            || None,
            spy(&called, fake_materialized()),
        )
        .env
        .expect("still shims — the -x guard degrades in the shell");
        assert!(env.iter().all(|(k, _)| k != ENV_STARSHIP_BIN));
    }

    #[test]
    fn starship_resolution_prefers_the_sidecar_over_path() {
        // finding 3 seam: a real sidecar file beside the exe beats any PATH hit.
        let dir = std::env::temp_dir().join(format!("trmx207-sidecar-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sidecar = dir.join("starship");
        std::fs::write(&sidecar, "#!/bin/sh\n").unwrap();
        let path_hit = PathBuf::from("/usr/local/bin/starship");
        assert_eq!(
            resolve_starship_bin(Some(&dir), |_| Some(path_hit.clone())),
            Some(sidecar.clone())
        );
        // No sidecar: the labeled dev/test fallback applies; nothing anywhere → None.
        let empty = dir.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert_eq!(
            resolve_starship_bin(Some(&empty), |_| Some(path_hit.clone())),
            Some(path_hit)
        );
        assert_eq!(resolve_starship_bin(Some(&empty), |_| None), None);
        assert_eq!(resolve_starship_bin(None, |_| None), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn materializer_error_degrades_to_a_bare_spawn() {
        let env = enhancement_env(
            false,
            &zsh(),
            &ShellConfig::default(),
            None,
            || None,
            || Err("disk full".to_string()),
        );
        assert_eq!(env.env, None);
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
