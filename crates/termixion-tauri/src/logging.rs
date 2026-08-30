// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
//! trmx-236 (grill H1): the logging sink. A Finder/launchd-launched `.app` has no stderr, so every
//! runtime diagnostic goes through the `log` facade into `tauri-plugin-log`: **stdout** (the dev
//! console / CI log) and a **file** — `~/Library/Logs/dev.termixion.terminal/termixion.log` on macOS
//! (`app_log_dir()`, the platform convention; lowercase name; 2 MiB, current + one archived copy) — in
//! EVERY build, because the packaged `--smoke` is a `--debug` build and its run is the evidence that
//! records reach the file.
//!
//! The sink is installed from [`install`] at the top of the app's `setup`, NOT from the builder's
//! plugin chain: the plugin's own setup propagates a log-dir/file error, which would abort the launch
//! with nothing to show for it. Here the directory is probed first; if the file cannot be used (or
//! `TERMIXION_LOG_NO_FILE=1` is set) the app runs with stdout only and says so at `warn`. The retry
//! after a failed registration is safe because the plugin fails in `acquire_logger` BEFORE it attaches
//! a global logger (tauri-plugin-log 2.9.0 `lib.rs:838-853`). The decision + retry live in
//! [`install_with`], which takes the probe result and a `register` closure — unit-tested headless.
//!
//! Policy: the binary's own records at `Info`+ (`termixion::*` targets), third-party crates at `Warn`+.
//! The webview forwards `console.error/warn/info` through the app-owned, bounded [`log_message`]
//! command ([`MAX_WEBVIEW_LOG_BYTES`], known levels only) — deliberately NOT the plugin's own `log`
//! command, which accepts an unbounded string. Two more commands back the About page's "Open log
//! folder" row (`log_dir`, `log_open_dir`; backend-side open like `config_open_file`, through
//! [`open_log_dir_with`] so the order and the error path are unit-tested).
//!
//! What is NEVER logged: PTY input/output, environment values, clipboard contents, `send-text`
//! payloads (R5; docs/CONTRIBUTING.md "Logging"). Stdout/stderr lines that are a CONTRACT (the `ctl`
//! JSON reply, `--version`/`--help`, the pre-builder usage errors, the fatal's stderr branch) stay
//! `println!`/`eprintln!` inside functions that carry an explicit clippy allowance — the crate denies
//! `clippy::print_stdout`/`print_stderr` everywhere else.

use crate::ipc_error::IpcError;
use std::path::{Path, PathBuf};

use log::LevelFilter;
use tauri::{AppHandle, Manager};
use tauri_plugin_log::{Builder, RotationStrategy, Target, TargetKind};
use tauri_plugin_opener::OpenerExt;

/// The log file stem: `termixion.log` (the plugin's default would be the package name, `Termixion`).
pub const LOG_FILE_STEM: &str = "termixion";
/// Rotate at 2 MiB; with [`ARCHIVES_TO_KEEP`] dated archives ⇒ current + one archive ≈ 4 MiB on disk.
pub const MAX_LOG_FILE_BYTES: u128 = 2 * 1024 * 1024;
/// `RotationStrategy::KeepSome(n)` keeps `n` ARCHIVED files besides the active one (the plugin's
/// `rotate()` removes old archives down to `n - 1`, then archives the active file — tauri-plugin-log
/// 2.9.0 `lib.rs:222-242`), so 1 = the current file plus one archive.
pub const ARCHIVES_TO_KEEP: usize = 1;
/// A forwarded webview record larger than this is refused (never truncated silently, never logged).
pub const MAX_WEBVIEW_LOG_BYTES: usize = 64 * 1024;
/// Set (non-empty, not `0`) to run without the file target.
pub const NO_FILE_ENV: &str = "TERMIXION_LOG_NO_FILE";
/// The target every forwarded webview record is logged under.
pub const WEBVIEW_TARGET: &str = "termixion::webview";

/// The sinks a launch gets (pure — pinned by tests; [`to_target`] maps them to the plugin).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SinkKind {
    Stdout,
    File,
}

/// Stdout always; the file only when the directory probe succeeded and the escape hatch is not set.
pub fn select_sinks(probe_ok: bool, no_file_env: bool) -> Vec<SinkKind> {
    let mut sinks = vec![SinkKind::Stdout];
    if probe_ok && !no_file_env {
        sinks.push(SinkKind::File);
    }
    sinks
}

/// Whether `TERMIXION_LOG_NO_FILE` asks to drop the file target (pure over the raw value).
pub fn no_file_requested(value: Option<&str>) -> bool {
    matches!(value, Some(v) if !v.is_empty() && v != "0")
}

/// Prove the log directory is usable BEFORE the plugin is asked to open it: create the directory and
/// open the log file for append. The plugin's own failure would abort the launch; this one just
/// drops the file sink.
pub fn probe_log_dir(dir: &Path) -> Result<(), String> {
    // trmx-249: `ensure_log_dir` is shared with the `log_open_dir` COMMAND, which needs a kind.
    // This is the startup path — it has no IPC boundary and its outcome becomes a plain
    // `file_disabled_reason` string — so the kind is dropped here rather than leaking IPC types
    // into `install`.
    ensure_log_dir(dir).map_err(|e| e.message)?;
    let file = dir.join(format!("{LOG_FILE_STEM}.log"));
    std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&file)
        .map(|_| ())
        .map_err(|e| format!("cannot open {} for writing: {e}", file.display()))
}

/// Create the log directory if absent (a regular file in its place is an error, never replaced).
pub fn ensure_log_dir(dir: &Path) -> Result<(), IpcError> {
    if dir.exists() && !dir.is_dir() {
        return Err(IpcError::io(format!(
            "{} is not a directory",
            dir.display()
        )));
    }
    std::fs::create_dir_all(dir)
        .map_err(|e| IpcError::io(format!("cannot create {}: {e}", dir.display())))
}

fn to_target(kind: SinkKind) -> Target {
    Target::new(match kind {
        SinkKind::Stdout => TargetKind::Stdout,
        SinkKind::File => TargetKind::LogDir {
            file_name: Some(LOG_FILE_STEM.to_string()),
        },
    })
}

/// The plugin with the trmx-236 policy over the given sinks.
pub fn build_plugin<R: tauri::Runtime>(sinks: &[SinkKind]) -> tauri::plugin::TauriPlugin<R> {
    Builder::new()
        .clear_targets()
        .targets(sinks.iter().copied().map(to_target))
        .level(LevelFilter::Warn)
        .level_for("termixion", LevelFilter::Info)
        .max_file_size(MAX_LOG_FILE_BYTES)
        .rotation_strategy(RotationStrategy::KeepSome(ARCHIVES_TO_KEEP))
        .build()
}

/// What [`install`] ended up with (for the startup record).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    /// The sinks actually registered (empty only if even the stdout-only plugin failed).
    pub sinks: Vec<SinkKind>,
    /// Why the file sink is absent, if it is (the hatch, a probe failure, or a registration failure).
    pub file_disabled_reason: Option<String>,
}

/// The decision + retry, over injected edges (headless-testable). NEVER fails: startup cannot be
/// aborted by the sink. `register` is called with the chosen sinks; if that fails with the file sink,
/// it is called once more with stdout only (safe: the plugin fails before attaching a logger).
pub fn install_with<F>(probe: Result<(), String>, no_file: bool, mut register: F) -> Installed
where
    F: FnMut(&[SinkKind]) -> Result<(), String>,
{
    let mut sinks = select_sinks(probe.is_ok(), no_file);
    let mut reason = match (&probe, no_file) {
        (_, true) => Some(format!("{NO_FILE_ENV} is set")),
        (Err(e), false) => Some(e.clone()),
        (Ok(()), false) => None,
    };
    if let Err(e) = register(&sinks) {
        let had_file = sinks.contains(&SinkKind::File);
        sinks = vec![SinkKind::Stdout];
        reason = Some(if had_file {
            format!("the log plugin could not start with the file target: {e}")
        } else {
            format!("the log plugin could not start: {e}")
        });
        if register(&sinks).is_err() {
            sinks.clear(); // no sink at all — the caller reports on stderr (its stdio contract)
        }
    }
    Installed {
        sinks,
        file_disabled_reason: reason,
    }
}

fn resolve_log_dir(app: &AppHandle) -> Result<PathBuf, IpcError> {
    app.path()
        .app_log_dir()
        .map_err(|e| IpcError::io(format!("could not resolve the log directory: {e}")))
}

/// Install the sink at the top of `setup` (the thin wrapper over [`install_with`]).
pub fn install(app: &AppHandle) -> Installed {
    let no_file = no_file_requested(std::env::var(NO_FILE_ENV).ok().as_deref());
    let dir = resolve_log_dir(app).map_err(|e| e.message);
    let probe = dir.clone().and_then(|d| probe_log_dir(&d));
    let installed = install_with(probe, no_file, |sinks| {
        app.plugin(build_plugin(sinks)).map_err(|e| e.to_string())
    });
    // An EMPTY sink set (both registrations failed) is reported by the caller on stderr — `main`'s
    // stdio contract — since no logger exists to carry it.
    match (&installed.file_disabled_reason, installed.sinks.is_empty()) {
        (_, true) => {}
        (Some(why), false) => log::warn!(
            "log file disabled: {why} — records go to stdout only (set {NO_FILE_ENV}=1 to make this deliberate)"
        ),
        (None, false) => log::info!(
            "log file: {}",
            dir.map(|d| d.join(format!("{LOG_FILE_STEM}.log")).display().to_string())
                .unwrap_or_default()
        ),
    }
    installed
}

/// Validate a webview record before it is logged: a known level and a bounded message. Pure.
pub fn forward_webview_record<'m>(
    level: &str,
    message: &'m str,
) -> Result<(log::Level, &'m str), IpcError> {
    let lvl = match level {
        "error" => log::Level::Error,
        "warn" => log::Level::Warn,
        "info" => log::Level::Info,
        "debug" => log::Level::Debug,
        "trace" => log::Level::Trace,
        other => return Err(IpcError::invalid(format!("unknown log level '{other}'"))),
    };
    if message.len() > MAX_WEBVIEW_LOG_BYTES {
        return Err(IpcError::invalid(format!(
            "log message too large ({} bytes > {MAX_WEBVIEW_LOG_BYTES})",
            message.len()
        )));
    }
    Ok((lvl, message))
}

/// The webview's forwarding boundary (trmx-236; the error boundary of trmx-237 uses it too).
#[tauri::command]
pub fn log_message(level: String, message: String) -> Result<(), IpcError> {
    let (lvl, msg) = forward_webview_record(&level, &message)?;
    log::log!(target: WEBVIEW_TARGET, lvl, "{msg}");
    Ok(())
}

/// The log directory, for the About row's description.
#[tauri::command]
pub fn log_dir(app: AppHandle) -> Result<String, IpcError> {
    resolve_log_dir(&app).map(|p| p.display().to_string())
}

/// Ensure the directory exists, THEN hand its path to the opener. An error from either step
/// propagates verbatim (the About row shows it in its pill).
pub fn open_log_dir_with<F>(dir: &Path, open: F) -> Result<(), IpcError>
where
    F: FnOnce(&str) -> Result<(), IpcError>,
{
    ensure_log_dir(dir)?;
    open(&dir.display().to_string())
}

/// The About row's "Open log folder": backend-side open (the webview opener command is
/// capability-denied in the packaged app — the `config_open_file` precedent).
#[tauri::command]
pub fn log_open_dir(app: AppHandle) -> Result<(), IpcError> {
    let dir = resolve_log_dir(&app)?;
    open_log_dir_with(&dir, |path| {
        app.opener()
            .open_path(path, None::<&str>)
            .map_err(|e| IpcError::io(format!("could not open {path}: {e}")))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::os::unix::fs::PermissionsExt;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("trmx236-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&d).ok();
        d
    }

    #[test]
    fn sinks_follow_the_probe_and_the_escape_hatch() {
        assert_eq!(
            select_sinks(true, false),
            vec![SinkKind::Stdout, SinkKind::File]
        );
        assert_eq!(select_sinks(false, false), vec![SinkKind::Stdout]);
        assert_eq!(select_sinks(true, true), vec![SinkKind::Stdout]);
        assert_eq!(select_sinks(false, true), vec![SinkKind::Stdout]);
    }

    /// The retention contract: 2 MiB per file, ONE archive besides the active file (≈ 4 MiB).
    #[test]
    fn retention_is_current_plus_one_archive() {
        assert_eq!(ARCHIVES_TO_KEEP, 1);
        assert_eq!(MAX_LOG_FILE_BYTES, 2 * 1024 * 1024);
        assert!(matches!(
            RotationStrategy::KeepSome(ARCHIVES_TO_KEEP),
            RotationStrategy::KeepSome(1)
        ));
    }

    #[test]
    fn the_escape_hatch_is_set_when_non_empty_and_not_zero() {
        assert!(!no_file_requested(None));
        assert!(!no_file_requested(Some("")));
        assert!(!no_file_requested(Some("0")));
        assert!(no_file_requested(Some("1")));
        assert!(no_file_requested(Some("yes")));
    }

    #[test]
    fn probe_creates_the_dir_and_opens_the_file() {
        let dir = tmp("probe").join("nested");
        probe_log_dir(&dir).expect("probe");
        assert!(dir.join("termixion.log").is_file());
        std::fs::remove_dir_all(dir.parent().unwrap()).ok();
    }

    #[test]
    fn probe_refuses_a_file_where_the_dir_should_be() {
        let base = tmp("probefile");
        std::fs::create_dir_all(&base).unwrap();
        let not_a_dir = base.join("logs");
        std::fs::write(&not_a_dir, b"x").unwrap();
        assert!(probe_log_dir(&not_a_dir).is_err());
        assert!(ensure_log_dir(&not_a_dir).is_err());
        assert!(not_a_dir.is_file(), "never replaced");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn probe_refuses_an_unwritable_parent() {
        let base = tmp("probero");
        std::fs::create_dir_all(&base).unwrap();
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o500)).unwrap();
        let result = probe_log_dir(&base.join("logs"));
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();
        std::fs::remove_dir_all(&base).ok();
        // root can write anywhere; the assertion only holds for a normal user (CI + dev machines).
        if unsafe { libc::geteuid() } != 0 {
            assert!(result.is_err(), "an unwritable parent must fail the probe");
        }
    }

    /// The sinks each scripted `register` call was given.
    type Calls = std::rc::Rc<RefCell<Vec<Vec<SinkKind>>>>;

    /// A scripted `register`: each call records the sinks it was given and pops the next result.
    fn scripted_register(
        results: Vec<Result<(), String>>,
    ) -> (impl FnMut(&[SinkKind]) -> Result<(), String>, Calls) {
        let calls: Calls = std::rc::Rc::new(RefCell::new(Vec::new()));
        let seen = calls.clone();
        let mut queue = results.into_iter();
        let f = move |sinks: &[SinkKind]| {
            seen.borrow_mut().push(sinks.to_vec());
            queue.next().unwrap_or(Ok(()))
        };
        (f, calls)
    }

    #[test]
    fn install_registers_stdout_and_file_when_the_probe_passes() {
        let (reg, calls) = scripted_register(vec![Ok(())]);
        let got = install_with(Ok(()), false, reg);
        assert_eq!(got.sinks, vec![SinkKind::Stdout, SinkKind::File]);
        assert_eq!(got.file_disabled_reason, None);
        assert_eq!(calls.borrow().len(), 1);
    }

    #[test]
    fn install_drops_the_file_when_the_probe_fails_and_says_why() {
        let (reg, calls) = scripted_register(vec![Ok(())]);
        let got = install_with(
            Err("cannot create /Users/x/Library/Logs: EACCES".into()),
            false,
            reg,
        );
        assert_eq!(got.sinks, vec![SinkKind::Stdout]);
        assert!(got.file_disabled_reason.unwrap().contains("EACCES"));
        assert_eq!(
            *calls.borrow(),
            vec![vec![SinkKind::Stdout]],
            "registered stdout only, once"
        );
    }

    #[test]
    fn install_retries_stdout_only_when_the_file_registration_fails_and_continues() {
        let (reg, calls) = scripted_register(vec![Err("open failed".into()), Ok(())]);
        let got = install_with(Ok(()), false, reg);
        assert_eq!(got.sinks, vec![SinkKind::Stdout], "fell back to stdout");
        let why = got.file_disabled_reason.expect("a reason");
        assert!(
            why.contains("open failed") && why.contains("file target"),
            "{why}"
        );
        assert_eq!(
            *calls.borrow(),
            vec![
                vec![SinkKind::Stdout, SinkKind::File],
                vec![SinkKind::Stdout]
            ],
            "first the file attempt, then the retry"
        );
    }

    #[test]
    fn install_never_aborts_even_when_both_registrations_fail() {
        let (reg, calls) = scripted_register(vec![Err("a".into()), Err("b".into())]);
        let got = install_with(Ok(()), false, reg);
        assert!(got.sinks.is_empty(), "no sink at all, but we RETURNED");
        assert!(got.file_disabled_reason.is_some());
        assert_eq!(calls.borrow().len(), 2);
    }

    #[test]
    fn install_honours_the_escape_hatch() {
        let (reg, calls) = scripted_register(vec![Ok(())]);
        let got = install_with(Ok(()), true, reg);
        assert_eq!(got.sinks, vec![SinkKind::Stdout]);
        assert!(got.file_disabled_reason.unwrap().contains(NO_FILE_ENV));
        assert_eq!(*calls.borrow(), vec![vec![SinkKind::Stdout]]);
    }

    #[test]
    fn open_log_dir_creates_the_dir_then_opens_it() {
        let dir = tmp("open").join("logs");
        let opened = RefCell::new(None);
        open_log_dir_with(&dir, |p| {
            assert!(
                Path::new(p).is_dir(),
                "the dir exists BEFORE the opener runs"
            );
            *opened.borrow_mut() = Some(p.to_string());
            Ok(())
        })
        .expect("open");
        assert_eq!(
            opened.borrow().as_deref(),
            Some(dir.display().to_string().as_str())
        );
        std::fs::remove_dir_all(dir.parent().unwrap()).ok();
    }

    #[test]
    fn open_log_dir_refuses_a_file_and_never_calls_the_opener() {
        let base = tmp("openfile");
        std::fs::create_dir_all(&base).unwrap();
        let not_a_dir = base.join("logs");
        std::fs::write(&not_a_dir, b"x").unwrap();
        let called = RefCell::new(false);
        let err = open_log_dir_with(&not_a_dir, |_| {
            *called.borrow_mut() = true;
            Ok(())
        })
        .unwrap_err();
        assert!(err.message.contains("not a directory"), "{err}");
        assert!(!*called.borrow(), "the opener must not run");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn open_log_dir_propagates_the_opener_error() {
        let dir = tmp("openerr").join("logs");
        let err = open_log_dir_with(&dir, |_| Err(IpcError::io("opener denied"))).unwrap_err();
        assert_eq!(err.message, "opener denied");
        assert_eq!(err.kind, crate::ipc_error::IpcErrorKind::Io);
        std::fs::remove_dir_all(dir.parent().unwrap()).ok();
    }

    #[test]
    fn log_message_applies_the_bound_and_the_level_check_itself() {
        let max = "m".repeat(MAX_WEBVIEW_LOG_BYTES);
        assert!(
            log_message("error".into(), max).is_ok(),
            "exactly the bound is accepted"
        );
        let over = "m".repeat(MAX_WEBVIEW_LOG_BYTES + 1);
        let err = log_message("error".into(), over).unwrap_err();
        assert!(err.message.contains("too large"), "{err}");
        assert!(
            log_message("bogus".into(), "x".into())
                .unwrap_err()
                .message
                .contains("unknown log level")
        );
        for lvl in ["error", "warn", "info", "debug", "trace"] {
            assert!(log_message(lvl.into(), "x".into()).is_ok(), "{lvl}");
        }
    }

    #[test]
    fn forward_webview_record_maps_levels() {
        assert_eq!(
            forward_webview_record("warn", "x").unwrap().0,
            log::Level::Warn
        );
        assert_eq!(
            forward_webview_record("info", "x").unwrap().0,
            log::Level::Info
        );
        assert!(forward_webview_record("", "x").is_err());
    }
}
