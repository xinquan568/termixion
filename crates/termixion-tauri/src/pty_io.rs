// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-243 (grill H5): the PTY session surface, extracted verbatim from `main.rs`.
//!
//! Everything between the webview and a live terminal session (ADR-0001): [`PtyState`] (the
//! registry, the poller gate and the per-session flow-control cells), the spawn path with its cwd
//! fallback notice, and the five commands the frontend routes by session id.
//!
//! trmx-244 (grill M5) moved the transport-agnostic half — natural batching and the credit window —
//! down into [`termixion_core::flow`], where the headless Linux job covers it. What stays here is
//! the TAURI-shaped glue: one `Channel` per session, the thread that runs
//! [`termixion_core::flow::run_batch_sender`] against `channel.send`, and `pty_ack` refilling the
//! cell from xterm's parse callback. The invariants those pieces uphold — the bounded hand-off
//! queue, the coalescing cap, the unacked-byte window — are documented in `flow.rs` beside the code
//! that implements them.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::ipc_error::IpcError;
use tauri::ipc::Channel;
use tauri::{Emitter, Manager, State};
use termixion_core::PtyError;
use termixion_core::flow::{
    CreditCell, PTY_BATCH_MAX_BYTES, PTY_BATCH_WINDOW_MS, PTY_CREDIT_BYTES, PTY_CREDIT_FLOOR,
    PTY_CREDIT_WAIT, PTY_HANDOFF_CHUNKS, run_batch_sender,
};
use termixion_core::{PtyFactory, PtyReader, PtySize, SessionId, SessionRegistry, SessionSpec};
use termixion_platform::PlatformPtyFactory;

use crate::launch::SpecialLaunch;
use crate::poller::PollerGate;
use crate::{config_io, enhancements_io, shells_io};

/// The live terminal sessions (trmx-74): one per tab, keyed by the registry's monotonic
/// **never-reused** ids. That id discipline replaces the old single-slot generation counter — a
/// stale reader thread reaping its own id after that session is gone is an idempotent no-op that
/// can never touch another session (documented in `termixion_core::registry`). trmx-75 adds the
/// [`PollerGate`] `open_pty` uses to wake the foreground-title poller out of its zero-session park.
#[derive(Default)]
pub(crate) struct PtyState {
    pub(crate) registry: Arc<Mutex<SessionRegistry>>,
    pub(crate) poller_gate: Arc<PollerGate>,
    /// Per-session flow-control cells (trmx-78 round 2b): registered at open_pty, consumed by the
    /// batch sender, refilled by pty_ack, removed at reap. An ack for a dead session is inert.
    credits: Arc<Mutex<HashMap<u64, Arc<CreditCell>>>>,
}

/// What `open_pty` returns to the webview: the id every later `pty_write`/`pty_resize`/`close_pty`
/// routes by, plus the initial tab title (trmx-74). camelCase so the frontend sees `sessionId`.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionInfo {
    session_id: u64,
    title: String,
}

/// Payload of the `pty:exited` event: the child of session `session_id` ended (shell exit, kill,
/// or read error), so the frontend drops exactly that tab (trmx-74).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyExited {
    session_id: u64,
}

/// The initial tab title for a spawned program: the basename of its path, lossy UTF-8
/// (`/bin/zsh` → `zsh`), falling back to `"shell"` when there is no basename. Pure, unit-tested.
fn program_title(program: &OsStr) -> String {
    Path::new(program)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "shell".to_string())
}
/// Open a terminal session and stream its output to the webview over `channel` (ADR-0001). Spawns
/// the login shell — at `cwd` when the frontend passes one (trmx-74: new tabs inherit the active
/// tab's directory) — via the registry, moves the blocking reader onto a dedicated thread running
/// the core pump, and returns the session id + initial title. When the stream ends the session is
/// reaped and `pty:exited` tells the frontend to drop exactly that tab.
/// The shell spec for a new session (trmx-78, pure): production opens the user's login shell at
/// the requested cwd; a `--smoke` OR `--perf` run opens the deterministic rc-free `zsh -f`
/// (ignoring any `cwd`) so the driven sequence is never garbled by the user's prompt / rc files /
/// line editor — the transport (channel, pty_write, streaming) stays the production path.
/// The deterministic smoke/perf shell: rc-free `zsh -f` if `/bin/zsh` is present, else `bash --norc
/// --noprofile` (a zsh-less Linux box, trmx-102). Pure — takes an `exists` probe so both branches are
/// unit-tested even though the CI runner always has zsh.
fn smoke_shell(exists: impl Fn(&str) -> bool) -> (&'static str, &'static [&'static str]) {
    if exists("/bin/zsh") {
        ("/bin/zsh", &["-f"])
    } else {
        ("/bin/bash", &["--norc", "--noprofile"])
    }
}

/// trmx-237 (grill H4): what happened to a requested working directory. `Some` only when the request
/// could not be honored, so the caller can tell the user where the shell actually started.
#[derive(Debug, PartialEq, Eq, Clone)]
struct CwdFallback {
    /// The directory the caller asked for (a stale OSC-7 inheritance, a deleted project dir, …).
    requested: PathBuf,
    /// Where the session starts instead: core's validated `$HOME`, or `None` = inherit the parent.
    used: Option<PathBuf>,
}

/// The one-line notice written into the new session when a requested cwd could not be used.
fn cwd_fallback_notice(fallback: &CwdFallback) -> String {
    match &fallback.used {
        Some(used) => format!(
            "[termixion] {} is not a directory — starting in {} instead",
            fallback.requested.display(),
            used.display()
        ),
        None => format!(
            "[termixion] {} is not a directory — starting in the inherited working directory",
            fallback.requested.display()
        ),
    }
}

fn session_spec_for(
    smoke: bool,
    perf: bool,
    cwd: Option<String>,
    configured_shell: Option<String>,
    is_dir: impl Fn(&std::path::Path) -> bool,
) -> (SessionSpec, Option<CwdFallback>) {
    if smoke || perf {
        let (program, args) = smoke_shell(|p| std::path::Path::new(p).exists());
        let mut s = SessionSpec::shell(program);
        for a in args {
            s.args.push((*a).into());
        }
        (s, None)
    } else {
        // trmx-205: a valid configured shell wins; anything else (empty, missing, not
        // executable) falls through to the unchanged System-default chain inside core.
        let mut s = SessionSpec::login_shell_configured(
            configured_shell.map(std::ffi::OsString::from),
            shells_io::is_executable_file,
        );
        // trmx-237 (grill H4): only a REAL directory may overwrite the core default. Before this the
        // overwrite was unconditional, so a stale OSC-7 cwd (a `rm -rf`'d project dir inherited by a new
        // tab) reached the platform layer and became a hard `PtyError::Spawn` — a silent dead pane. The
        // fallback is core's already-validated `$HOME` (trmx-185, `pty.rs:226`), NOT `None`: `None` means
        // *inherit the parent's cwd*, which for a Finder/launchd launch is `/`.
        match cwd.map(PathBuf::from) {
            Some(dir) if is_dir(&dir) => {
                s.cwd = Some(dir);
                (s, None)
            }
            Some(requested) => {
                let used = s.cwd.clone();
                (s, Some(CwdFallback { requested, used }))
            }
            None => (s, None),
        }
    }
}

/// Payload of the `session:notice` event (trmx-237): a one-line message the frontend writes into the
/// pane owning `session_id`. Backend-authored text only — never user or PTY data (R5).
#[derive(Clone, serde::Serialize)]
struct SessionNotice {
    session_id: SessionId,
    text: String,
}

/// Emit a pane notice. Best-effort like every other emit: a webview that is gone cannot be told.
fn notify_session(app: &tauri::AppHandle, session_id: SessionId, text: &str) {
    let _ = app.emit(
        "session:notice",
        SessionNotice {
            session_id,
            text: text.to_string(),
        },
    );
}

/// trmx-237 (grill H4): spawn a session and, when the requested working directory could not be honored,
/// tell the user in the pane itself. Extracted from `open_pty` so the behaviour is testable over a fake
/// factory (R8) — the handler body past this point is adapter wiring (poller gate, credit cell, hand-off
/// channel, pump + batch sender) whose coverage is trmx-245's scope.
///
/// The notice is emitted only after a SUCCESSFUL spawn: a failed spawn has no session to write into, and
/// its error is already surfaced to the caller.
fn open_session_with<N>(
    registry: &mut SessionRegistry,
    factory: &dyn PtyFactory,
    spec: &SessionSpec,
    size: PtySize,
    fallback: Option<&CwdFallback>,
    notify: N,
) -> Result<(SessionId, Box<dyn PtyReader>), PtyError>
where
    N: FnOnce(SessionId, &str),
{
    // trmx-249: `registry.spawn` yields Spawn / Io / InvalidSize. Stringifying here discarded all
    // of them before the boundary could classify anything, so this helper returns the domain error
    // and `open_pty` applies `From<PtyError>`. PtyError stays in core; IpcError never comes here.
    let (id, reader) = registry.spawn(factory, spec, size)?;
    if let Some(fallback) = fallback {
        notify(id, &cwd_fallback_notice(fallback));
    }
    Ok((id, reader))
}

#[tauri::command]
pub(crate) fn open_pty(
    app: tauri::AppHandle,
    channel: Channel<tauri::ipc::Response>,
    rows: u16,
    cols: u16,
    cwd: Option<String>,
    state: State<'_, PtyState>,
    launch: State<'_, SpecialLaunch>,
) -> Result<SessionInfo, IpcError> {
    // trmx-205: resolve the configured shell from the cached config; when it is present but no
    // longer valid (uninstalled after hydration — no file change, no watcher wake), surface the
    // condition on the existing warnings channel; the spec below independently falls back.
    let configured_shell = config_io::configured_shell(&app.state::<config_io::ConfigState>());
    if configured_shell
        .as_deref()
        .is_some_and(|shell| !shells_io::is_executable_file(shell))
    {
        config_io::emit_shell_fallback_warning(
            &app,
            &app.state::<config_io::ConfigState>(),
            shells_io::is_executable_file,
        );
    }
    let (mut spec, cwd_fallback) = session_spec_for(
        launch.smoke.is_some(),
        launch.perf.is_some(),
        cwd,
        configured_shell,
        |p| p.is_dir(),
    );
    // trmx-206: the zsh enhancement layer — enhancement_env is the ONE gate (None = smoke/perf,
    // non-zsh, kill switch, nothing-to-layer, or materialization failure ⇒ byte-identical
    // baseline spawn; the materializer is provably untouched on every None path).
    let shell_config = config_io::shell_config(&app.state::<config_io::ConfigState>());
    let enhancement_decision = enhancements_io::enhancement_env(
        launch.smoke.is_some() || launch.perf.is_some(),
        &spec.program,
        &shell_config,
        std::env::var_os("ZDOTDIR"),
        enhancements_io::default_starship_bin,
        || {
            enhancements_io::default_base_dir()
                .and_then(|base| enhancements_io::materialize_enhancements(&base))
        },
    );
    if let Some(env) = enhancement_decision.env.clone() {
        spec.env.extend(env);
    }

    let spawned = open_session_with(
        &mut *state
            .registry
            .lock()
            .map_err(|_| IpcError::internal("pty state poisoned"))?,
        &PlatformPtyFactory,
        &spec,
        PtySize::new(rows, cols),
        cwd_fallback.as_ref(),
        |session_id, notice| notify_session(&app, session_id, notice),
    );

    // trmx-238 (M18/D9): the enhancement verdict is committed HERE — after the spawn resolved, and
    // only when it succeeded — so a session that never started can never claim "Active". Ordered
    // before the `?` so the failure path is the tested one.
    if enhancements_io::commit_after_spawn(
        spawned.is_ok(),
        &app.state::<enhancements_io::EnhancementsState>(),
        enhancement_decision.status.clone(),
    ) {
        let _ = app.emit(
            enhancements_io::ENHANCEMENTS_STATUS_EVENT,
            &enhancement_decision.status,
        );
        config_io::emit_config_warnings(&app, &app.state::<config_io::ConfigState>());
    }

    let (id, reader) = spawned?;

    // trmx-75: a session now exists to watch — wake the title poller out of its zero-session
    // park. After a successful spawn only, and after the registry lock above is released.
    state.poller_gate.notify_session_opened();

    // Output → webview via the core pump + the trmx-78 natural-batching sender (ADR-0001; one
    // coalesced message per send instead of one per 4096-byte read). The pump thread's only job
    // on stream end is dropping `tx` — the SENDER then flushes the queued tail and performs the
    // reap + `pty:exited` emission, so the frontend can never observe the exit ahead of the
    // stream's final bytes. `registry.close(id)` is idempotent and ids are never reused, so the
    // stale-safe reap can never touch a newer session; the emit stays best-effort (the webview
    // may already be gone during shutdown).
    let registry = Arc::clone(&state.registry);
    let cell = Arc::new(CreditCell::new(PTY_CREDIT_BYTES));
    if let Ok(mut credits) = state.credits.lock() {
        credits.insert(id, Arc::clone(&cell));
    }
    let credits_map = Arc::clone(&state.credits);
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(PTY_HANDOFF_CHUNKS);
    std::thread::spawn(move || {
        termixion_core::pump(
            reader,
            |chunk| tx.send(chunk.to_vec()).is_ok(),
            || {}, // end-of-stream duty moved to the sender: dropping tx is the signal
        );
    });
    std::thread::spawn(move || {
        run_batch_sender(
            rx,
            PTY_BATCH_MAX_BYTES,
            Duration::from_millis(PTY_BATCH_WINDOW_MS),
            move |batch| {
                // Flow control: park until the webview has parsed enough of what is in flight
                // (ack via pty_ack). Timeout probes proceed only above the overdraw floor, so
                // unacked bytes are hard-bounded; a dead channel fails the send and ends us.
                cell.consume_floored(batch.len() as i64, PTY_CREDIT_WAIT, PTY_CREDIT_FLOOR);
                channel.send(tauri::ipc::Response::new(batch)).is_ok()
            },
            move || {
                if let Ok(mut credits) = credits_map.lock() {
                    credits.remove(&id);
                }
                let _ = registry.lock().map(|mut r| r.close(id));
                let _ = app.emit("pty:exited", PtyExited { session_id: id });
            },
        );
    });

    Ok(SessionInfo {
        session_id: id,
        title: program_title(&spec.program),
    })
}

/// Send keystrokes (raw bytes from xterm `onData`) to the session's PTY.
#[tauri::command]
pub(crate) fn pty_write(
    session_id: u64,
    data: Vec<u8>,
    state: State<'_, PtyState>,
) -> Result<(), IpcError> {
    state
        .registry
        .lock()
        .map_err(|_| IpcError::internal("pty state poisoned"))?
        .write(session_id, &data)
        .map(|_| ())
        .map_err(IpcError::from)
}

/// Resize the session's PTY character grid (from xterm `onResize`).
#[tauri::command]
pub(crate) fn pty_resize(
    session_id: u64,
    rows: u16,
    cols: u16,
    state: State<'_, PtyState>,
) -> Result<(), IpcError> {
    state
        .registry
        .lock()
        .map_err(|_| IpcError::internal("pty state poisoned"))?
        .resize(session_id, PtySize::new(rows, cols))
        .map_err(IpcError::from)
}

/// The webview acks parsed PTY bytes (trmx-78 round 2b): refill the session's flow-control
/// window on xterm parse completion. Acks for unknown/dead sessions are inert.
#[tauri::command]
pub(crate) fn pty_ack(session_id: u64, bytes: u32, state: State<'_, PtyState>) {
    let cell = state
        .credits
        .lock()
        .ok()
        .and_then(|credits| credits.get(&session_id).cloned());
    if let Some(cell) = cell {
        cell.refill(i64::from(bytes));
    }
}

/// Close a session (tab closed by the user, trmx-74). Idempotent: closing an id that already
/// exited (e.g. the reader thread reaped it first) is `Ok(())`.
#[tauri::command]
pub(crate) fn close_pty(session_id: u64, state: State<'_, PtyState>) -> Result<(), IpcError> {
    state
        .registry
        .lock()
        .map_err(|_| IpcError::internal("pty state poisoned"))?
        .close(session_id)
        .map_err(IpcError::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_title_is_the_program_basename_with_a_shell_fallback() {
        // A path yields its basename; a plain name passes through unchanged.
        assert_eq!(program_title(OsStr::new("/bin/zsh")), "zsh");
        assert_eq!(program_title(OsStr::new("/opt/homebrew/bin/fish")), "fish");
        assert_eq!(program_title(OsStr::new("bash")), "bash");
        // No basename at all falls back to a generic tab title.
        assert_eq!(program_title(OsStr::new("")), "shell");
        assert_eq!(program_title(OsStr::new("/")), "shell");
    }

    #[test]
    fn session_payloads_serialize_camel_case_for_the_frontend() {
        // The frontend destructures `sessionId` from open_pty's return and the `pty:exited`
        // payload (trmx-74) — pin the wire shape.
        let info = serde_json::to_value(SessionInfo {
            session_id: 7,
            title: "zsh".to_string(),
        })
        .expect("SessionInfo serializes");
        assert_eq!(info, serde_json::json!({ "sessionId": 7, "title": "zsh" }));

        let exited =
            serde_json::to_value(PtyExited { session_id: 42 }).expect("PtyExited serializes");
        assert_eq!(exited, serde_json::json!({ "sessionId": 42 }));
    }

    /// trmx-237 (grill H4): a factory that RECORDS the spec it was handed and can be made to FAIL.
    /// Neither core fake suffices: `FakePtyFactory`/`SeparableFakePtyFactory` both take `_spec` and
    /// ignore it (`core/src/fake.rs:81,254`), and neither can return an error — so the spec that
    /// actually reaches the PTY layer would go unasserted. Delegates to the separable fake because
    /// `SessionRegistry::spawn` requires a detachable reader.
    struct RecordingFactory {
        seen: std::cell::RefCell<Vec<SessionSpec>>,
        fail: bool,
    }

    impl RecordingFactory {
        fn new() -> Self {
            Self {
                seen: std::cell::RefCell::new(Vec::new()),
                fail: false,
            }
        }
        fn failing() -> Self {
            Self {
                seen: std::cell::RefCell::new(Vec::new()),
                fail: true,
            }
        }
        fn last_cwd(&self) -> Option<PathBuf> {
            self.seen.borrow().last().and_then(|s| s.cwd.clone())
        }
    }

    impl termixion_core::PtyFactory for RecordingFactory {
        fn spawn(
            &self,
            spec: &SessionSpec,
            size: PtySize,
        ) -> Result<Box<dyn termixion_core::PtyBackend>, termixion_core::PtyError> {
            self.seen.borrow_mut().push(spec.clone());
            if self.fail {
                return Err(termixion_core::PtyError::Spawn("nope".into()));
            }
            termixion_core::fake::FakePtyFactory::with_separable_reader().spawn(spec, size)
        }
    }

    /// Drive the REAL `session_spec_for` → `open_session_with` path: the decision and the glue together,
    /// which is what the user actually experiences. `$HOME` comes from core's validated default on this
    /// host (`SessionSpec::login_shell().cwd`), so the assertions never hardcode a machine-specific path.
    fn open_with(
        cwd: Option<&str>,
        is_dir: impl Fn(&Path) -> bool,
        factory: &RecordingFactory,
    ) -> (Result<SessionId, String>, Option<PathBuf>, Vec<String>) {
        let (spec, fallback) =
            session_spec_for(false, false, cwd.map(str::to_string), None, is_dir);
        let mut registry = SessionRegistry::new();
        let notices = std::cell::RefCell::new(Vec::new());
        let result = open_session_with(
            &mut registry,
            factory,
            &spec,
            PtySize::new(24, 80),
            fallback.as_ref(),
            |_id, text| notices.borrow_mut().push(text.to_string()),
        );
        (
            // trmx-249: open_session_with now returns PtyError. These cases assert on the message
            // text, so render it here rather than weakening the assertions.
            result.map(|(id, _reader)| id).map_err(|e| e.to_string()),
            factory.last_cwd(),
            notices.into_inner(),
        )
    }

    /// The headline H4 case: a stale/deleted cwd must NOT reach the platform layer (where it becomes a
    /// hard spawn error and a silent dead pane) and must NOT become `None` (which means inherit-parent,
    /// i.e. `/` under launchd) — it falls back to core's validated `$HOME`, and the user is told.
    ///
    /// RED against the pre-trmx-237 code: the overwrite was unconditional, so the factory received
    /// `/gone/project` and no notice was ever produced.
    #[test]
    fn a_dead_cwd_falls_back_to_the_core_default_and_notifies() {
        let home = SessionSpec::login_shell().cwd;
        let factory = RecordingFactory::new();
        let (result, spawned_cwd, notices) = open_with(Some("/gone/project"), |_| false, &factory);
        assert!(result.is_ok());
        assert_eq!(
            spawned_cwd, home,
            "the factory must receive core's validated default — not the dead path"
        );
        assert_ne!(
            spawned_cwd,
            Some(PathBuf::from("/gone/project")),
            "the dead path must never reach the PTY layer"
        );
        assert_eq!(notices.len(), 1, "exactly one notice");
        assert!(
            notices[0].contains("/gone/project"),
            "names what was asked for: {}",
            notices[0]
        );
    }

    #[test]
    fn a_live_cwd_is_honored_and_says_nothing() {
        let factory = RecordingFactory::new();
        let (result, spawned_cwd, notices) = open_with(Some("/work/repo"), |_| true, &factory);
        assert!(result.is_ok());
        assert_eq!(spawned_cwd, Some(PathBuf::from("/work/repo")));
        assert!(
            notices.is_empty(),
            "an honored cwd is not worth a line of the user's scrollback"
        );
    }

    /// The notice text distinguishes the two fallbacks, so the message is never a lie about where the
    /// shell started. (`used: None` = the inherit-parent contract of a homeless environment.)
    #[test]
    fn the_notice_names_home_or_says_inherited() {
        let to_home = CwdFallback {
            requested: PathBuf::from("/gone"),
            used: Some(PathBuf::from("/Users/t")),
        };
        let notice = cwd_fallback_notice(&to_home);
        assert!(
            notice.contains("/gone") && notice.contains("/Users/t"),
            "got: {notice}"
        );

        let inherited = CwdFallback {
            requested: PathBuf::from("/gone"),
            used: None,
        };
        let notice = cwd_fallback_notice(&inherited);
        assert!(
            notice.contains("/gone") && notice.contains("inherited"),
            "got: {notice}"
        );
    }

    /// A spawn failure propagates unchanged: no notice (there is no session to write into) and nothing
    /// partially created.
    #[test]
    fn a_spawn_failure_propagates_without_a_notice() {
        let factory = RecordingFactory::failing();
        let (result, _, notices) = open_with(Some("/gone"), |_| false, &factory);
        assert!(result.is_err(), "the caller must see the spawn error");
        assert!(notices.is_empty(), "no session exists to notify");
    }

    #[test]
    fn session_spec_for_selects_the_rc_free_shell_for_smoke_or_perf() {
        // Production: login shell, an EXISTING cwd honored (trmx-237: the probe says it is a dir).
        let (prod, fallback) = session_spec_for(
            false,
            false,
            Some("/tmp/somewhere".to_string()),
            None,
            |_| true,
        );
        assert_eq!(prod.cwd, Some(PathBuf::from("/tmp/somewhere")));
        assert!(prod.args.is_empty(), "login shell spawns with no args");
        assert_eq!(fallback, None, "an honored cwd reports no fallback");

        // trmx-185: with no explicit cwd the tauri layer adds no policy of its own — the spec
        // carries exactly the core login_shell() default ($HOME when valid, else None).
        let (defaulted, fallback) = session_spec_for(false, false, None, None, |_| true);
        assert_eq!(
            defaulted.cwd,
            SessionSpec::login_shell().cwd,
            "session_spec_for must pass the core cwd default through untouched"
        );
        assert_eq!(fallback, None);

        // Smoke or perf (or both): deterministic rc-free `zsh -f`, cwd deliberately ignored so
        // rc/prompt noise and a surprising working dir can never pollute the driven sequence.
        for (smoke, perf) in [(true, false), (false, true), (true, true)] {
            let (spec, _) =
                session_spec_for(smoke, perf, Some("/tmp/ignored".to_string()), None, |_| {
                    true
                });
            // The CI/dev host has /bin/zsh, so the live pick is zsh -f.
            assert_eq!(spec.program, OsStr::new("/bin/zsh"));
            assert_eq!(spec.args, vec![std::ffi::OsString::from("-f")]);
            assert_eq!(spec.cwd, None, "rc-free mode ignores cwd");
        }
    }

    #[test]
    fn smoke_shell_falls_back_to_bash_when_zsh_is_absent() {
        // zsh present → rc-free zsh -f (the CI path).
        assert_eq!(smoke_shell(|_| true), ("/bin/zsh", &["-f"][..]));
        // trmx-102: a zsh-less Linux box → bash --norc --noprofile (the branch the live CI never hits).
        assert_eq!(
            smoke_shell(|p| p != "/bin/zsh"),
            ("/bin/bash", &["--norc", "--noprofile"][..])
        );
    }
}
