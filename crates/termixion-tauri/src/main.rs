// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
// trmx-236: stdout/stderr are for stdio CONTRACTS only (the `ctl` JSON reply, --version/--help, the
// pre-builder usage errors, the fatal's stderr branch) — everything else goes through `log::*` into the
// logging sink (`logging.rs`). The two functions that hold contracts carry an explicit allowance.
#![deny(clippy::print_stdout, clippy::print_stderr)]
#![cfg_attr(test, allow(clippy::print_stdout, clippy::print_stderr))]
//! Termixion — the thin Tauri 2 desktop shell. Since trmx-74 it drives the multi-session
//! [`SessionRegistry`] (one session per tab) and streams each session to the xterm.js webview over
//! its own Tauri IPC `Channel` (ADR-0001): a dedicated thread per session runs the core reader
//! pump while `pty_write` / `pty_resize` / `close_pty` route by session id. trmx-75 (FR-2.4) adds
//! the tab-title plumbing: a 1 Hz foreground-name poller (condvar-parked at zero sessions via
//! [`PollerGate`]) emitting change-only `session:title-hint` events, and the `set_session_title`
//! command through which the frontend — the single core-title writer — mirrors each tab's
//! effective title. The session domain logic lives in `termixion-core`; this file is runtime glue
//! (validated by the C-3 packaged `--smoke` and `cargo tauri dev`) — the pure pieces
//! (`program_title`, [`poll_tick`], the payload wire shapes, the gate's park/wake) are unit-tested.
//! trmx-80 (FR-13) adds the `config_io` module: the `termixion.toml` read/write/reset commands and
//! the debounced config-file watcher that live-applies external edits as `settings:changed`.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::ipc::Channel;
use tauri::{Emitter, Manager, State, WindowEvent};
use termixion_core::{PtyFactory, PtyReader, PtySize, SessionId, SessionRegistry, SessionSpec};
use termixion_platform::PlatformPtyFactory;

mod config_io;
mod control;
mod control_io;
mod enhancements_io;
mod fs_watch;
mod launch;
mod logging;
mod menu;
mod poller;
mod scripts_io;
mod services_io;
mod shell_integration_io;
mod shells_io;
mod themes_io;
mod window_manager;

use poller::{PollerGate, run_title_poller};

use launch::{
    CliQuery, PERF_WATCHDOG_SECS, SMOKE_WATCHDOG_SECS, SpecialLaunch, cli_query, launch_modes,
    perf_config, perf_done, perf_mode, perf_scenario, smoke_config, smoke_done, smoke_mode, usage,
    version_line,
};

/// The live terminal sessions (trmx-74): one per tab, keyed by the registry's monotonic
/// **never-reused** ids. That id discipline replaces the old single-slot generation counter — a
/// stale reader thread reaping its own id after that session is gone is an idempotent no-op that
/// can never touch another session (documented in `termixion_core::registry`). trmx-75 adds the
/// [`PollerGate`] `open_pty` uses to wake the foreground-title poller out of its zero-session park.
#[derive(Default)]
struct PtyState {
    registry: Arc<Mutex<SessionRegistry>>,
    poller_gate: Arc<PollerGate>,
    /// Per-session flow-control cells (trmx-78 round 2b): registered at open_pty, consumed by the
    /// batch sender, refilled by pty_ack, removed at reap. An ack for a dead session is inert.
    credits: Arc<Mutex<HashMap<u64, Arc<CreditCell>>>>,
}

/// What `open_pty` returns to the webview: the id every later `pty_write`/`pty_resize`/`close_pty`
/// routes by, plus the initial tab title (trmx-74). camelCase so the frontend sees `sessionId`.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
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

/// Placeholder command exercising the frontend↔backend channel: reports the core version.
#[tauri::command]
fn core_version() -> String {
    termixion_platform::CORE_VERSION.to_string()
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
) -> Result<(SessionId, Box<dyn PtyReader>), String>
where
    N: FnOnce(SessionId, &str),
{
    let (id, reader) = registry
        .spawn(factory, spec, size)
        .map_err(|e| e.to_string())?;
    if let Some(fallback) = fallback {
        notify(id, &cwd_fallback_notice(fallback));
    }
    Ok((id, reader))
}

/// trmx-78 round 2: the natural-batching hand-off between the core pump and the IPC channel.
/// One Tauri message per 4096-byte PTY read saturated the webview main thread under output
/// floods (`seq`/`yes` dropped >94 % of frames on the reference Mac while typing stayed at
/// 3 ms p50 — the flood is a message-granularity problem, not a keystroke-path one). The sender
/// below blocks for the FIRST chunk (an idle echo byte forwards immediately — zero added
/// latency), then drains whatever else is already queued into ONE message, capped: coalescing
/// happens exactly when the producer outruns the consumer ("natural batching").
///
/// The hand-off queue is BOUNDED ([`PTY_HANDOFF_CHUNKS`]): a full queue blocks the PTY reader —
/// intended backpressure, same visible behavior as any slow terminal — so OUR queue can never
/// grow without bound (Tauri-internal buffering past `channel.send` remains a residual,
/// measured-not-assumed concern).
const PTY_HANDOFF_CHUNKS: usize = 256;

/// Cap one coalesced message at 256 KiB — bounds per-message parse cost without re-fragmenting
/// floods into the message storm this exists to fix.
const PTY_BATCH_MAX_BYTES: usize = 262_144;

/// Flow-control window (trmx-78 round 2b): at most this many UNACKED bytes may be in flight to
/// the webview. The webview acks bytes on xterm PARSE COMPLETION (`pty_ack`, wired to the
/// `write(data, cb)` callback), so ingestion is bounded by the terminal's real parse rate and the
/// kernel ultimately blocks a flooding producer (`yes`) on the full PTY buffer — the classic
/// terminal feedback loop the issue's ladder names as "respect the parse callback".
const PTY_CREDIT_BYTES: i64 = 1_048_576;

/// Bounded park slice while credits are exhausted. Above the overdraw floor the sender proceeds
/// after this wait as a PROBE — the send failure of a genuinely dead channel ends the loop. At
/// the floor probes stop and the park repeats indefinitely (an occluded webview stops acking but
/// must never lose its session; in a single-window app a truly dead webview ends the app anyway).
const PTY_CREDIT_WAIT: Duration = Duration::from_millis(500);

/// The overdraw floor (R2 step-8 F1): timeout probes may drive credits negative at most this far,
/// hard-bounding unacked bytes at PTY_CREDIT_BYTES + |floor| even against a channel that queues
/// forever without acking.
const PTY_CREDIT_FLOOR: i64 = -PTY_CREDIT_BYTES;

/// Per-session unacked-byte accounting (trmx-78 round 2b). Consumers park at <= 0; `pty_ack`
/// refills on parse completion. Negative overdraw is bounded by one batch (PTY_BATCH_MAX_BYTES).
struct CreditCell {
    credits: Mutex<i64>,
    refilled: Condvar,
}

impl CreditCell {
    fn new(initial: i64) -> Self {
        Self {
            credits: Mutex::new(initial),
            refilled: Condvar::new(),
        }
    }

    /// Floored consume (R2 step-8 F1): park in `slice`-sized waits while credits are exhausted.
    /// A timeout with credits still ABOVE `floor` proceeds as a probe (overdraw bounded by the
    /// floor); at or below the floor the park repeats until a refill arrives. Always deducts on
    /// return, so the floor is a hard bound on unacked bytes.
    ///
    /// trmx-241 (L4): returns `()`. It used to return a `ConsumeOutcome` distinguishing "proceeded"
    /// from "released by a refill", documented as something to re-evaluate on — but the sole
    /// production caller discarded it, so the type asserted a contract nothing honoured. The
    /// distinction is not observable to a caller anyway: every arm deducts and returns, and what
    /// matters (parking, the slice wait, floor-bounded overdraw) is timing, which the unit tests
    /// now assert directly.
    fn consume_floored(&self, bytes: i64, slice: Duration, floor: i64) {
        loop {
            let Ok(guard) = self.credits.lock() else {
                return; // poisoned peer: degrade to unthrottled
            };
            let Ok((mut guard, timeout)) =
                self.refilled
                    .wait_timeout_while(guard, slice, |credits| *credits <= 0)
            else {
                return;
            };
            if !timeout.timed_out() {
                *guard -= bytes;
                return;
            }
            if *guard > floor {
                *guard -= bytes;
                return; // probe: overdraw stays floor-bounded
            }
            // At the floor with no refill: stay parked (drop the lock, take another slice).
        }
    }

    /// Return parsed bytes to the window and wake a parked consumer (`pty_ack`).
    fn refill(&self, bytes: i64) {
        if let Ok(mut credits) = self.credits.lock() {
            *credits = (*credits + bytes).min(PTY_CREDIT_BYTES);
        }
        self.refilled.notify_all();
    }
}

/// The pacing window under sustained load (trmx-78 round 2, measured): `channel.send` queues
/// internally and returns fast — no backpressure — so drain-only batching never accumulates a
/// backlog (a `yes` flood still produced millions of tiny messages). After each send the sender
/// therefore accumulates for up to this window before the next send, bounding the message rate
/// at ~1000/WINDOW per second with growing batches. The idle path is untouched: a chunk arriving
/// after a quiet period (typing echoes at ≥50 ms spacing) is sent immediately.
const PTY_BATCH_WINDOW_MS: u64 = 4;

/// One batch: block for the first chunk, then opportunistically drain the backlog up to `max`
/// bytes (the first chunk always rides, even if larger than `max`). `None` = closed and empty.
/// Pure over std types — unit-tested (order, cap, residue-after-close).
fn next_batch(rx: &std::sync::mpsc::Receiver<Vec<u8>>, max: usize) -> Option<Vec<u8>> {
    let mut batch = rx.recv().ok()?;
    while batch.len() < max {
        match rx.try_recv() {
            Ok(chunk) => batch.extend_from_slice(&chunk),
            Err(_) => break, // empty right now, or closed — either way this batch is complete
        }
    }
    Some(batch)
}

/// The sender loop: forward coalesced batches into `send_batch` until the stream ends (producer
/// dropped, queue drained) or the transport rejects a batch; then run `on_done` exactly once.
/// Dropping `rx` on return releases a producer blocked on the full bounded queue (`SendError`).
/// Tauri-free seam — unit-tested with fake callbacks (flush-before-done, exactly-once,
/// fail-close, blocked-producer release); `open_pty` instantiates it with the real channel +
/// reap/emit.
fn run_batch_sender(
    rx: std::sync::mpsc::Receiver<Vec<u8>>,
    max: usize,
    window: Duration,
    mut send_batch: impl FnMut(Vec<u8>) -> bool,
    on_done: impl FnOnce(),
) {
    use std::time::Instant;

    /// Drop guard: `on_done` runs exactly once on EVERY exit — return AND unwind. Field evidence
    /// (round 2): a panic inside the send path killed the sender thread between the loop and the
    /// reap, orphaning the session (stale registry entry, poller spinning, webview waiting
    /// forever). The guard makes that impossible by construction.
    struct DoneGuard<F: FnOnce()>(Option<F>);
    impl<F: FnOnce()> Drop for DoneGuard<F> {
        fn drop(&mut self) {
            if let Some(done) = self.0.take() {
                done();
            }
        }
    }
    let _guard = DoneGuard(Some(on_done));
    // Re-bind rx AFTER the guard: locals drop in reverse order (and parameters last of all), so
    // this makes the receiver drop BEFORE on_done fires — a producer blocked on the full hand-off
    // is already released (SendError) when the reap runs (R2 step-8 F2).
    let rx = rx;
    // Start "long idle" so the very first chunk (and any chunk after a quiet period) sends
    // immediately — the pacing only bites while the producer sustains output.
    let mut last_send = Instant::now() - window;
    while let Some(mut batch) = next_batch(&rx, max) {
        // Micro-window pacing: if the previous send was within the window, keep accumulating
        // until the window elapses (or the cap is hit / the stream ends) — forced coalescing
        // against a transport that queues instead of backpressuring.
        let since = last_send.elapsed();
        if since < window {
            let deadline = Instant::now() + (window - since);
            while batch.len() < max {
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                match rx.recv_timeout(deadline - now) {
                    Ok(chunk) => batch.extend_from_slice(&chunk),
                    Err(_) => break, // window elapsed with no data, or producer closed
                }
            }
        }
        if !send_batch(batch) {
            break; // transport gone (webview/channel closed)
        }
        last_send = Instant::now();
    }
    // rx (re-bound local) drops first — releasing a blocked producer — then the guard fires.
}

#[tauri::command]
fn open_pty(
    app: tauri::AppHandle,
    channel: Channel<tauri::ipc::Response>,
    rows: u16,
    cols: u16,
    cwd: Option<String>,
    state: State<'_, PtyState>,
    launch: State<'_, SpecialLaunch>,
) -> Result<SessionInfo, String> {
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
            .map_err(|_| "pty state poisoned".to_string())?,
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
fn pty_write(session_id: u64, data: Vec<u8>, state: State<'_, PtyState>) -> Result<(), String> {
    state
        .registry
        .lock()
        .map_err(|_| "pty state poisoned".to_string())?
        .write(session_id, &data)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Resize the session's PTY character grid (from xterm `onResize`).
#[tauri::command]
fn pty_resize(
    session_id: u64,
    rows: u16,
    cols: u16,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    state
        .registry
        .lock()
        .map_err(|_| "pty state poisoned".to_string())?
        .resize(session_id, PtySize::new(rows, cols))
        .map_err(|e| e.to_string())
}

/// The webview acks parsed PTY bytes (trmx-78 round 2b): refill the session's flow-control
/// window on xterm parse completion. Acks for unknown/dead sessions are inert.
#[tauri::command]
fn pty_ack(session_id: u64, bytes: u32, state: State<'_, PtyState>) {
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
fn close_pty(session_id: u64, state: State<'_, PtyState>) -> Result<(), String> {
    state
        .registry
        .lock()
        .map_err(|_| "pty state poisoned".to_string())?
        .close(session_id)
        .map_err(|e| e.to_string())
}

/// Mirror a tab's EFFECTIVE title into its core session (trmx-75). The frontend computes the
/// effective title (manual > OSC > process hint > fallback) in its reducer and is the **single
/// core-title writer** — the foreground poller only emits hints and never lands here. Absent id
/// (a tab whose session already exited) surfaces the registry's NotFound as an error string.
#[tauri::command]
fn set_session_title(
    session_id: u64,
    title: String,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    state
        .registry
        .lock()
        .map_err(|_| "pty state poisoned".to_string())?
        .set_title(session_id, title)
        .map_err(|e| e.to_string())
}

/// trmx-144: set once the webview confirms a quit (or a pre-authorized close chain reaches the
/// window) — the next `CloseRequested` on the main window is then torn down and allowed through
/// instead of being vetoed-and-asked.
static QUIT_AUTHORIZED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// trmx-144: the main-window teardown must run exactly once however many close paths race.
static MAIN_TEARDOWN_DONE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Latch: true exactly once — the caller that wins runs the teardown body.
fn begin_teardown(done: &std::sync::atomic::AtomicBool) -> bool {
    !done.swap(true, std::sync::atomic::Ordering::SeqCst)
}

/// trmx-267: run `body` exactly once however many callers race. Split out of [`teardown_once`] so
/// the race invariant is testable without a Tauri runtime — the latch, not the caller, is what
/// makes the teardown idempotent.
fn run_teardown_once(done: &std::sync::atomic::AtomicBool, body: impl FnOnce()) {
    if begin_teardown(done) {
        body();
    }
}

/// trmx-267: the single teardown. Reaps every PTY child, stops the control socket, and closes the
/// settings window. Every exit path **that emits a run event** calls this, and the
/// `MAIN_TEARDOWN_DONE` latch makes it a no-op after the first, however many paths race.
///
/// The qualifier is exact, not hedging. A launch that ends via `std::process::exit` (`smoke_done` /
/// `perf_done`) runs code but emits no run event, and `AppHandle::restart()` called on the main
/// thread documents that it skips both `ExitRequested` and `Exit` — neither reaches this function.
/// Termixion calls neither of those on a user-facing path today: the updater's `relaunch()` reaches
/// `AppHandle::request_restart()`, which requests an exit and so emits the events — whenever that
/// request succeeds, which is the normal live-event-loop case. If `request_exit` itself returns
/// `Err`, Tauri falls back to `cleanup_before_exit()` + a direct re-exec and emits nothing, so that
/// fallback reaps nothing either. Hence the qualifier above is on the run event, not on the path.
fn teardown_once(app: &tauri::AppHandle) {
    run_teardown_once(&MAIN_TEARDOWN_DONE, || {
        if let Some(state) = app.try_state::<PtyState>()
            && let Ok(mut registry) = state.registry.lock()
        {
            registry.kill_all();
        }
        // trmx-101 (FR-9.4): tear down the control socket (acceptor + unlink).
        if let Some(control_state) = app.try_state::<control::ControlState>() {
            control::shutdown(&control_state);
        }
        if let Some(settings) = app.get_webview_window(window_manager::SETTINGS_WINDOW_LABEL) {
            let _ = settings.close();
        }
    });
}

/// trmx-268: where a close gesture came from. Selects the channel the ask goes out on; the decision
/// itself does not depend on it.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum CloseOrigin {
    /// ⌘Q / ⇧⌘W — the menu broadcasts `tabs:action` so the frontend keeps owning the dialog.
    Menu,
    /// A native `CloseRequested` — the traffic light, or `quit_confirmed`'s authorized re-drive.
    WindowClose,
    /// A programmatic `RunEvent::ExitRequested` with a non-restart code.
    AppExit,
}

impl CloseOrigin {
    fn ask_event(self) -> &'static str {
        match self {
            CloseOrigin::Menu => "tabs:action",
            CloseOrigin::WindowClose | CloseOrigin::AppExit => "close:requested",
        }
    }
}

/// trmx-268: how far the current ask has got. `elapsed` is supplied by the caller — the decision
/// never reads a clock (trmx-250).
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum AskState {
    None,
    Pending { acked: bool, elapsed: Duration },
}

/// trmx-268: what a close gesture must do.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum CloseDecision {
    /// Not the PTY-owning window (trmx-51), or an exit with nobody left to ask.
    Ignore,
    /// Ask the webview. `restart_streak` opens a FRESH unacked streak (and a new generation);
    /// otherwise the existing deadline is preserved.
    Ask {
        restart_streak: bool,
    },
    TeardownAndExit,
}

/// trmx-268: the one close gate, for every origin. Rules apply in order. Pure, so the whole rule set
/// is testable with no Tauri runtime and no sleeps.
fn close_decision(
    is_pty_owner: bool,
    quit_authorized: bool,
    ask: AskState,
    grace: Duration,
) -> CloseDecision {
    // 1. The settings webview never gates or tears down the app (trmx-51).
    if !is_pty_owner {
        return CloseDecision::Ignore;
    }
    // 2. Already authorized — BEFORE the grace rules, so `quit_confirmed`'s re-drive (and any
    //    terminal path that set the latch) can never be mistaken for an unacked second gesture.
    if quit_authorized {
        return CloseDecision::TeardownAndExit;
    }
    match ask {
        // 3. First gesture.
        AskState::None => CloseDecision::Ask {
            restart_streak: true,
        },
        // 4. The webview answered, so it was alive: a new gesture opens a fresh streak and probes again.
        AskState::Pending { acked: true, .. } => CloseDecision::Ask {
            restart_streak: true,
        },
        // 5. Unacked past the grace window — the webview is not answering. The fallback this issue
        //    exists for: ⌘Q with a hung webview finally reaches a teardown.
        AskState::Pending {
            acked: false,
            elapsed,
        } if elapsed >= grace => CloseDecision::TeardownAndExit,
        // 6. Unacked but still inside the window: re-emit WITHOUT moving the deadline, so impatient
        //    presses cannot postpone the fallback.
        AskState::Pending { .. } => CloseDecision::Ask {
            restart_streak: false,
        },
    }
}

/// trmx-268: the transition when the ask could not be DELIVERED. Never an input to
/// [`close_decision`] — a failed emit is proof the webview cannot answer, so it is terminal.
fn ask_failed() -> CloseDecision {
    CloseDecision::TeardownAndExit
}

/// trmx-268: the ask's live state. One value behind one lock: `SeqCst` on three separate atomics
/// would order each write but give neither a consistent snapshot nor a safe compare-and-set — a
/// stale `close_acknowledged` could read its generation, be preempted by a restart, and then mark
/// the NEW streak acknowledged, making a hung webview look alive.
#[derive(Debug, Default)]
struct AskTracker {
    generation: u64,
    acked: bool,
    started: Option<Instant>,
}

impl AskTracker {
    /// Snapshot, decide and apply in ONE critical section, returning the generation to put on the
    /// wire. The caller emits afterwards, OUTSIDE the lock — never call into Tauri while holding it.
    fn decide_and_apply(
        &mut self,
        is_pty_owner: bool,
        quit_authorized: bool,
        now: Instant,
        grace: Duration,
    ) -> (CloseDecision, u64) {
        let ask = match self.started {
            None => AskState::None,
            Some(started) => AskState::Pending {
                acked: self.acked,
                elapsed: now.saturating_duration_since(started),
            },
        };
        let decision = close_decision(is_pty_owner, quit_authorized, ask, grace);
        if decision
            == (CloseDecision::Ask {
                restart_streak: true,
            })
        {
            self.generation += 1;
            self.acked = false;
            self.started = Some(now);
        }
        (decision, self.generation)
    }

    /// Generation-checked. A stale ack — one answering a streak that has since been restarted — is
    /// ignored, so an acknowledged-then-hung webview still reaches the fallback in two gestures.
    fn acknowledge(&mut self, generation: u64) -> bool {
        if generation == self.generation && self.started.is_some() {
            self.acked = true;
            true
        } else {
            false
        }
    }
}

static ASK: std::sync::LazyLock<std::sync::Mutex<AskTracker>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(AskTracker::default()));

/// trmx-268: how long an unacked ask may stand before the fallback fires.
const ASK_GRACE: Duration = Duration::from_secs(2);

/// trmx-268: which gate input a `RunEvent::ExitRequested` maps to. `None` = not gated here.
///
/// The two sources are NOT interchangeable. `Message::RequestExit(Some(code))` arrives with the main
/// window alive and can be asked. The last-window-destroyed path emits `code: None` *after*
/// tauri-runtime-wry has already removed the window, so there is no PTY-owning webview to receive an
/// ask — and an emit to nobody does not fail, so vetoing would strand a windowless process.
fn exit_gate_input(code: Option<i32>, main_window_alive: bool) -> Option<bool> {
    match code {
        Some(c) if c == tauri::RESTART_EXIT_CODE => None, // trmx-267 owns the updater restart
        None => Some(false),                              // nobody left to ask
        Some(_) => Some(main_window_alive),
    }
}

/// trmx-268: what the caller must do after the gate ran.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Outcome {
    Ignore,
    /// The ask was delivered; the caller vetoes its current event (if it has one).
    Vetoed,
    /// Terminal: tear down and let the current event proceed — or, for a command, re-drive a close.
    TeardownAndProceed,
}

/// trmx-268: the ONE delivery sequence, shared by every origin. Apply the ask state, THEN attempt
/// delivery, and let the caller veto only on success. Vetoing first and emitting after would strand
/// the process whenever the emit fails — the exact failure this issue exists to prevent.
#[allow(clippy::too_many_arguments)]
fn ask_and_apply<E>(
    ask: &std::sync::Mutex<AskTracker>,
    origin: CloseOrigin,
    is_pty_owner: bool,
    quit_authorized: bool,
    now: Instant,
    grace: Duration,
    emit: E,
) -> Outcome
where
    E: FnOnce(&'static str, u64) -> Result<(), String>,
{
    // The guard covers the decision and NOTHING else. `emit` re-enters Tauri, and the terminal
    // collaborators reach `teardown_once`, which joins the control-socket acceptor thread — holding
    // the lock across either is a real re-entrancy deadlock, not a tidiness point (C1).
    let (decision, generation) = {
        let mut tracker = ask.lock().unwrap_or_else(|e| e.into_inner());
        tracker.decide_and_apply(is_pty_owner, quit_authorized, now, grace)
    };
    match decision {
        CloseDecision::Ignore => Outcome::Ignore,
        CloseDecision::TeardownAndExit => Outcome::TeardownAndProceed,
        CloseDecision::Ask { .. } => match emit(origin.ask_event(), generation) {
            Ok(()) => Outcome::Vetoed,
            // The webview cannot be reached, so it cannot consent: terminal (`ask_failed`).
            Err(_) => match ask_failed() {
                CloseDecision::TeardownAndExit => Outcome::TeardownAndProceed,
                _ => Outcome::TeardownAndProceed,
            },
        },
    }
}

/// trmx-268: the command origin's flow. A command has no current event to "let proceed", so a failed
/// ask must authorize, tear down and RE-DRIVE a close — in that order, or the app survives its own
/// teardown. Every collaborator is injected so the sequence is provable without a Tauri runtime,
/// which is exactly why the argument list is long: collapsing the effects into a struct would hide
/// the seam the test drives (same rationale as `run_acceptor`'s allowance in control.rs).
#[allow(clippy::too_many_arguments)]
fn webview_close_flow<E, A, T, R>(
    ask: &std::sync::Mutex<AskTracker>,
    is_pty_owner: bool,
    now: Instant,
    grace: Duration,
    emit: E,
    authorize: A,
    teardown: T,
    redrive: R,
) where
    E: FnOnce(&'static str, u64) -> Result<(), String>,
    A: FnOnce(),
    T: FnOnce(),
    R: FnOnce(),
{
    if !is_pty_owner {
        return; // the settings webview never drives the main window's close flow
    }
    match ask_and_apply(ask, CloseOrigin::WindowClose, true, false, now, grace, emit) {
        Outcome::Ignore | Outcome::Vetoed => {}
        Outcome::TeardownAndProceed => {
            // The latch FIRST: the `CloseRequested` this causes then takes rule 2 and is allowed
            // through, instead of being vetoed again inside the same grace window.
            authorize();
            teardown();
            redrive();
        }
    }
}

/// trmx-267: what a `RunEvent::ExitRequested` must do, decided from the exit code alone. Pure, so
/// the run-event callback stays thin and this is unit-testable with no Tauri runtime.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum ExitAction {
    /// An updater restart (`RESTART_EXIT_CODE`): reap, then let it proceed. `prevent_exit()` is a
    /// documented no-op for this code, so there is nothing to gate here.
    TeardownAndProceed,
    /// Any other exit code: leave it to the window close gate. trmx-268 owns user-initiated quit
    /// consent, and tearing down here would kill busy shells before its dialog could run.
    LeaveToCloseGate,
}

fn exit_action(code: Option<i32>) -> ExitAction {
    if code == Some(tauri::RESTART_EXIT_CODE) {
        ExitAction::TeardownAndProceed
    } else {
        ExitAction::LeaveToCloseGate
    }
}

/// trmx-144: the webview's confirmed-quit handoff. The frontend gate (the `close:requested`
/// listener) calls this once the quit may proceed; it authorizes the close and re-drives it, so
/// the `CloseRequested` handler runs the teardown and releases the window. Only the PTY-owning
/// window may authorize — the settings webview can never quit the app.
#[tauri::command]
fn quit_confirmed(window: tauri::WebviewWindow) {
    if !window_manager::disposes_pty_for(window.label()) {
        return;
    }
    QUIT_AUTHORIZED.store(true, std::sync::atomic::Ordering::SeqCst);
    let _ = window.close();
}

/// trmx-268: the webview asks to close. Replaces the frontend's own `getCurrentWindow().close()`, so
/// a native `CloseRequested` can now only be a genuine traffic-light gesture or `quit_confirmed`'s
/// authorized re-drive — there is no third, uncorrelatable case. PTY-owner only, like `quit_confirmed`.
#[tauri::command]
fn webview_close_request(window: tauri::WebviewWindow) {
    let w = window.clone();
    webview_close_flow(
        &ASK,
        window_manager::disposes_pty_for(window.label()),
        Instant::now(),
        ASK_GRACE,
        |event, generation| {
            window
                .emit_to(window.label(), event, generation)
                .map_err(|e| e.to_string())
        },
        || QUIT_AUTHORIZED.store(true, std::sync::atomic::Ordering::SeqCst),
        || teardown_once(w.app_handle()),
        || {
            let _ = w.close();
        },
    );
}

/// trmx-268: the webview's proof of life. Generation-carrying, so an ack answering a streak that has
/// since been restarted is ignored and an acknowledged-then-hung webview still reaches the fallback.
#[tauri::command]
fn close_acknowledged(window: tauri::WebviewWindow, generation: u64) {
    if !window_manager::disposes_pty_for(window.label()) {
        return;
    }
    ASK.lock()
        .unwrap_or_else(|e| e.into_inner())
        .acknowledge(generation);
}

// stdio-contract: --version / --help / usage and the pre-builder launch-mode errors print to the
// terminal BEFORE any logger can exist; the post-run fatal keeps a stderr branch for when the sink
// never installed (see the end of this function).
#[allow(clippy::print_stdout, clippy::print_stderr)]
fn main() -> ExitCode {
    // trmx-101 (FR-9.4): `termixion ctl <…>` is a non-GUI CLI — connect to the control socket, send one
    // request, print the response, exit. An EARLY fork, before the tauri app is ever built.
    if std::env::args().nth(1).as_deref() == Some("ctl") {
        return control::run_ctl(std::env::args());
    }
    // trmx-146: --version/--help (and unknown-`--flag` rejection) answered here, after the ctl
    // fork and before ANY Tauri machinery — a CLI probe must exit cleanly, never side-effect a
    // second GUI instance (no window, no PTY, no updater, no watchdog threads).
    match cli_query(std::env::args().skip(1)) {
        CliQuery::Version => {
            // stdio-contract: --version → stdout (CLI contract, before the Tauri builder)
            println!("{}", version_line());
            return ExitCode::SUCCESS;
        }
        CliQuery::Help => {
            // stdio-contract: --help → stdout (CLI contract)
            println!("{}", usage());
            return ExitCode::SUCCESS;
        }
        CliQuery::UnknownFlag(flag) => {
            // Debug-format the flag: argv is attacker-adjacent input, and a raw echo could write
            // control bytes (ANSI/OSC) into the caller's terminal — {flag:?} escapes them.
            // stdio-contract: unrecognized flag → usage on stderr (CLI contract)
            eprintln!("termixion: unrecognized flag {flag:?}\n\n{}", usage());
            return ExitCode::from(2);
        }
        CliQuery::None => {}
    }
    let resolved = launch_modes(
        smoke_mode(
            std::env::args(),
            std::env::var("TERMIXION_SMOKE").ok(),
            std::env::var("DIR").ok(),
        ),
        perf_mode(
            std::env::args(),
            std::env::var("TERMIXION_PERF").ok(),
            std::env::var("TERMIXION_PERF_OUT").ok(),
        ),
    );
    let (smoke, perf) = match resolved {
        Ok(modes) => modes,
        Err(msg) => {
            // stdio-contract: launch-mode usage error before the builder (no logger yet)
            eprintln!("{msg}");
            return ExitCode::FAILURE;
        }
    };
    // trmx-101: a deterministic launch never opens the control socket (captured before smoke/perf move).
    let deterministic = smoke.is_some() || perf.is_some();
    if smoke.is_some() {
        // Watchdog: fail the smoke (exit 1) rather than hang if the webview never reports back. Generous
        // enough (trmx-102) that a slow headless webkit2gtk boot (software GL, no compositor, cold AppImage
        // extract on Linux CI) is not mistaken for a hang — the happy path exits in <5 s regardless.
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(SMOKE_WATCHDOG_SECS));
            log::error!(
                "termixion-smoke: FAIL — timed out waiting for the webview sentinel sequence"
            );
            std::process::exit(1);
        });
    }
    if perf.is_some() {
        // trmx-78: same discipline, sized to the harness's schedule (see PERF_WATCHDOG_SECS).
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(PERF_WATCHDOG_SECS));
            log::error!("termixion-perf: FAIL — timed out waiting for the webview perf driver");
            std::process::exit(1);
        });
    }

    let result = tauri::Builder::default()
        // trmx-48: auto-update (updater + relaunch) and opening external links from the About page.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        // trmx-145: the native pasteboard write — every frontend copy path (⌘C guard, auto-copy-on-
        // select, OSC 52) writes through this plugin's IPC, never the WKWebView pasteboard APIs
        // (whose writes reach other apps UTF-8-bytes-decoded-as-MacRoman: "—" pasted as "‚Äî").
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(PtyState::default())
        // trmx-224: directories from a Finder "New Termixion Tab Here" service invocation,
        // awaiting frontend pickup (services_io module docs describe the delivery contract).
        .manage(services_io::PendingOpenPaths::default())
        .manage(SpecialLaunch {
            smoke,
            perf,
            // trmx-103: pure read of args/env — harmless when perf is None (perf_config returns None).
            perf_scenario: perf_scenario(
                std::env::args(),
                std::env::var("TERMIXION_PERF_SCENARIO").ok(),
            ),
        })
        // trmx-80 (FR-13): the config backbone's state — the file-watch diff base + the
        // self-echo latch for our own writes.
        .manage(config_io::ConfigState::default())
        .manage(enhancements_io::EnhancementsState::default())
        // trmx-101 (FR-9.4): the opt-in external control channel's socket-listener state. A --smoke/--perf
        // launch is deterministic → the control socket NEVER opens (baked into ControlState, so EVERY
        // apply path — initial load, config write/reset, the watcher — is forced off).
        .manage(control::ControlState::new(deterministic))
        // trmx-48/trmx-51: install the app menu; "About Termixion" / "Settings…" open the
        // standalone Settings window (About lands on the About page). trmx-74 adds the Shell
        // submenu + Window tab-cycling items; trmx-75 adds Rename Tab… and spawns the
        // foreground-title poller (parked on its condvar gate until the first session opens).
        .setup(|app| {
            // trmx-236: the logging sink FIRST — from a caught path with a stdout-only fallback, so an
            // unwritable ~/Library/Logs never aborts the launch (logging.rs).
            let installed = logging::install(app.handle());
            if installed.sinks.is_empty() {
                // stdio-contract: the sink itself could not start — stderr is the only channel left
                // (this closure runs inside `main`, whose allowance covers it).
                eprintln!(
                    "termixion: logging unavailable ({}); continuing without a log sink",
                    installed.file_disabled_reason.as_deref().unwrap_or("unknown")
                );
            }
            let menu = menu::build_menu(app.handle())?;
            app.set_menu(menu)?;
            let state = app.state::<PtyState>();
            let registry = Arc::clone(&state.registry);
            let gate = Arc::clone(&state.poller_gate);
            let poller_app = app.handle().clone();
            std::thread::spawn(move || run_title_poller(poller_app, registry, gate));
            // trmx-80 (FR-13): watch the config file's parent directory for external edits
            // (editors save via rename-replace) and live-apply them as `settings:changed`.
            let config_app = app.handle().clone();
            std::thread::spawn(move || config_io::run_config_watcher(config_app));
            // trmx-89 (FR-6): watch the themes directory for `*.toml` edits and signal the
            // frontend to re-read the user theme catalog via `themes:changed`.
            let themes_app = app.handle().clone();
            std::thread::spawn(move || themes_io::run_themes_watcher(themes_app));
            // trmx-93 (FR-5): watch the scripts directory TREE (recursive) for edits and signal the
            // frontend to re-read the script catalog via `scripts:changed`.
            let scripts_app = app.handle().clone();
            std::thread::spawn(move || scripts_io::run_scripts_watcher(scripts_app));
            // trmx-224: register the macOS Services provider ("New Termixion Tab Here").
            // setup() runs on the main thread inside applicationDidFinishLaunching — Apple's
            // recommended registration window. The callback enqueues BEFORE nudging (the
            // services_io contract), and Apple warns requests may arrive immediately after
            // registration, which the queue + frontend boot/registration drains absorb.
            #[cfg(target_os = "macos")]
            {
                let services_app = app.handle().clone();
                let registered = termixion_platform::services::register_open_paths_provider(
                    move |dirs| {
                        let paths: Vec<String> = dirs
                            .iter()
                            .map(|p| p.to_string_lossy().into_owned())
                            .collect();
                        services_io::enqueue(&services_app.state(), paths);
                        services_io::nudge(&services_app);
                    },
                );
                if !registered {
                    log::warn!("[termixion] services provider not registered (duplicate or off-main-thread)");
                }
            }
            // trmx-101 (FR-9.4): apply the remote-control state from the config at startup. A --smoke/--perf
            // launch NEVER opens the socket (the deterministic launches force it disabled).
            let special = app.state::<SpecialLaunch>();
            let deterministic = special.smoke.is_some() || special.perf.is_some();
            if !deterministic {
                let text = std::fs::read_to_string(config_io::config_path()).unwrap_or_default();
                let cfg = termixion_core::config::parse_config(&text).0;
                control::apply_remote_control(
                    &app.handle().clone(),
                    &cfg.remote_control,
                    &app.state::<control::ControlState>(),
                );
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            // No unwrap/expect anywhere here: report and carry on rather than panic (a broken
            // menu item must not take the terminal down).
            match menu::menu_action(event.id().0.as_str()) {
                Some(menu::MenuAction::ShowSettings { section }) => {
                    if let Err(err) = window_manager::show_settings_window(app, section) {
                        log::error!("termixion: failed to open the settings window: {err}");
                    }
                }
                // trmx-74/94: the frontend owns tab/pane/window/settings state, so the menu broadcasts
                // the intent as a `tabs:action` event; App routes it through the command dispatch spine
                // (incl. window-close → window.close and app-settings → app.settings, trmx-94 finding 7).
                Some(menu::MenuAction::EmitTabsAction(action)) => {
                    // trmx-268: the close verbs go through the gate — ⌘Q's only effect used to be
                    // this emit, so a hung webview meant no native close, no CloseRequested, and no
                    // gate ever ran. Every other verb keeps its plain-string payload untouched.
                    if action == "window-close" {
                        let outcome = {
                            ask_and_apply(
                                &ASK,
                                CloseOrigin::Menu,
                                true,
                                QUIT_AUTHORIZED.load(std::sync::atomic::Ordering::SeqCst),
                                Instant::now(),
                                ASK_GRACE,
                                |event, generation| {
                                    app.emit(
                                        event,
                                        serde_json::json!({
                                            "action": "window-close",
                                            "gen": generation
                                        }),
                                    )
                                    .map_err(|e| e.to_string())
                                },
                            )
                        };
                        if outcome == Outcome::TeardownAndProceed {
                            QUIT_AUTHORIZED.store(true, std::sync::atomic::Ordering::SeqCst);
                            teardown_once(app);
                            app.exit(0);
                        }
                    } else if let Err(err) = app.emit("tabs:action", action) {
                        log::error!("termixion: failed to emit tabs:action ({action}): {err}");
                    }
                }
                None => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            core_version,
            services_io::take_pending_open_paths,
            open_pty,
            pty_write,
            pty_ack,
            pty_resize,
            close_pty,
            set_session_title,
            smoke_config,
            smoke_done,
            perf_config,
            perf_done,
            config_io::config_read,
            shells_io::shells_list,
            shells_io::effective_shell,
            config_io::config_write,
            config_io::config_reset_all,
            config_io::config_open_file,
            config_io::keys_read,
            window_manager::open_settings_window,
            themes_io::themes_read,
            themes_io::themes_write,
            themes_io::themes_open_dir,
            scripts_io::scripts_list,
            scripts_io::scripts_open_dir,
            shell_integration_io::shell_integration_reveal,
            control::control_response,
            logging::log_message,
            logging::log_dir,
            logging::log_open_dir,
            enhancements_io::enhancements_status,
            quit_confirmed,
            webview_close_request,
            close_acknowledged
        ])
        .on_window_event(|window, event| {
            // trmx-51: only the MAIN window owns the PTY sessions — closing the settings window
            // must leave the terminal alone. trmx-144: an UNCONFIRMED main-window close is vetoed
            // and bounced to the webview (which owns the busy state, the `terminal.confirmClose`
            // setting, and the dialog); once the webview calls `quit_confirmed` the re-driven
            // close lands here authorized. Closing main then kills every live session (trmx-74:
            // `registry.kill_all()`, no zombies) and takes the settings window with it, so the
            // app exits exactly as it did when main was the only window.
            if let WindowEvent::CloseRequested { api, .. } = event {
                // trmx-268: one gate for every origin. Deliver FIRST and veto only on success —
                // vetoing before the emit would strand the process whenever delivery fails.
                let outcome = {
                    ask_and_apply(
                        &ASK,
                        CloseOrigin::WindowClose,
                        window_manager::disposes_pty_for(window.label()),
                        QUIT_AUTHORIZED.load(std::sync::atomic::Ordering::SeqCst),
                        Instant::now(),
                        ASK_GRACE,
                        |event, generation| {
                            window
                                .emit_to(window.label(), event, generation)
                                .map_err(|e| e.to_string())
                        },
                    )
                };
                match outcome {
                    Outcome::Ignore => {}
                    Outcome::Vetoed => api.prevent_close(),
                    Outcome::TeardownAndProceed => {
                        // trmx-267: one shared implementation, so an exit/restart that never reaches
                        // this handler reaps the same way. The close is then ALLOWED through.
                        teardown_once(window.app_handle());
                    }
                }
            }
        })
        // trmx-267: `.build(ctx).map(|app| app.run(cb))` rather than `.run(ctx)` — `Builder::run` is
        // literally `self.build(context)?.run(|_, _| {})`, so this is the same call with a real
        // callback, and `map` preserves the `Result<()>` that `main`'s ExitCode contract binds (no `?`).
        // Without a RunEvent handler there is NO teardown on an exit or an updater restart: the
        // shells the user had open are orphaned, reparented and never reaped (trmx-267).
        .build(tauri::generate_context!())
        .map(|app| {
            app.run(|app_handle, event| match event {
                // The updater path: the frontend's `relaunch()` reaches `request_restart()`, which
                // always requests an exit with RESTART_EXIT_CODE. Reap, then let it proceed —
                // `api.prevent_exit()` is a documented no-op for this code, so vetoing would be
                // misleading rather than merely useless. Any other code is left to the window close
                // gate; trmx-268 owns user-quit consent and must see it first.
                tauri::RunEvent::ExitRequested { code, api, .. } => match exit_action(code) {
                    ExitAction::TeardownAndProceed => teardown_once(app_handle),
                    // trmx-268 fills the arm trmx-267 deliberately left empty. `code: None` is
                    // emitted AFTER the last window was removed, so there is nobody to ask and a
                    // veto would strand a windowless process: `exit_gate_input` maps it to a
                    // non-owner, which rule 1 answers `Ignore`.
                    ExitAction::LeaveToCloseGate => {
                        let alive = app_handle
                            .get_webview_window(window_manager::MAIN_WINDOW_LABEL)
                            .is_some();
                        if let Some(is_pty_owner) = exit_gate_input(code, alive) {
                            let outcome = {
                                ask_and_apply(
                                    &ASK,
                                    CloseOrigin::AppExit,
                                    is_pty_owner,
                                    QUIT_AUTHORIZED.load(std::sync::atomic::Ordering::SeqCst),
                                    Instant::now(),
                                    ASK_GRACE,
                                    |event, generation| {
                                        app_handle
                                            .emit_to(
                                                window_manager::MAIN_WINDOW_LABEL,
                                                event,
                                                generation,
                                            )
                                            .map_err(|e| e.to_string())
                                    },
                                )
                            };
                            match outcome {
                                Outcome::Ignore => {}
                                Outcome::Vetoed => api.prevent_exit(),
                                Outcome::TeardownAndProceed => teardown_once(app_handle),
                            }
                        }
                    }
                },
                // Last-resort net. Unconditional by design: the latch makes it a no-op whenever a
                // close path already ran, and a PREVENTED exit never reaches `Exit` at all. Tauri
                // dispatches this before it re-execs on a restart, so the reap still happens.
                tauri::RunEvent::Exit => teardown_once(app_handle),
                _ => {}
            })
        });

    if let Err(err) = result {
        // No unwrap/expect: report and exit non-zero rather than panic. trmx-236: ONCE — through the
        // logger when one installed (stdout + file), else to stderr (the sink is the likely culprit,
        // hence the hint). `log::max_level()` stays `Off` until a logger attaches.
        if log::max_level() == log::LevelFilter::Off {
            // stdio-contract: no logger installed — stderr is the only channel left.
            eprintln!(
                "termixion: fatal error running the app: {err}\n  (if the log sink failed to open ~/Library/Logs, set {}=1 to launch without the log file)",
                logging::NO_FILE_ENV
            );
        } else {
            log::error!("termixion: fatal error running the app: {err}");
        }
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;

    #[test]
    fn close_decision_follows_the_six_rules_in_order() {
        use std::time::Duration;
        let grace = Duration::from_secs(2);
        let none = AskState::None;
        let unacked = |e| AskState::Pending {
            acked: false,
            elapsed: e,
        };
        let acked = |e| AskState::Pending {
            acked: true,
            elapsed: e,
        };

        // 1: not the PTY owner wins over EVERYTHING, including authorization and a past-grace streak.
        assert_eq!(
            close_decision(false, false, none, grace),
            CloseDecision::Ignore
        );
        assert_eq!(
            close_decision(false, true, unacked(grace), grace),
            CloseDecision::Ignore
        );
        // 2: authorized wins over rule 5 — quit_confirmed's re-drive must never be re-gated.
        assert_eq!(
            close_decision(true, true, none, grace),
            CloseDecision::TeardownAndExit
        );
        assert_eq!(
            close_decision(true, true, unacked(grace * 2), grace),
            CloseDecision::TeardownAndExit
        );
        // 3: a first gesture opens a streak.
        assert_eq!(
            close_decision(true, false, none, grace),
            CloseDecision::Ask {
                restart_streak: true
            }
        );
        // 6: inside the window an impatient second press re-emits WITHOUT restarting the streak.
        assert_eq!(
            close_decision(true, false, unacked(Duration::from_millis(1)), grace),
            CloseDecision::Ask {
                restart_streak: false
            }
        );
        // 5: at the boundary exactly — `>= grace`, not `>`.
        assert_eq!(
            close_decision(true, false, unacked(grace), grace),
            CloseDecision::TeardownAndExit
        );
        assert_eq!(
            close_decision(true, false, unacked(grace * 2), grace),
            CloseDecision::TeardownAndExit
        );
        // 4: the webview answered, so a new gesture opens a FRESH unacked streak and probes again.
        assert_eq!(
            close_decision(true, false, acked(grace * 2), grace),
            CloseDecision::Ask {
                restart_streak: true
            }
        );
        // A failed emit is terminal, and is an OUTPUT — never an input to close_decision.
        assert_eq!(ask_failed(), CloseDecision::TeardownAndExit);
    }

    #[test]
    fn close_origin_selects_the_ask_channel() {
        assert_eq!(CloseOrigin::Menu.ask_event(), "tabs:action");
        assert_eq!(CloseOrigin::WindowClose.ask_event(), "close:requested");
        assert_eq!(CloseOrigin::AppExit.ask_event(), "close:requested");
    }

    #[test]
    fn ask_tracker_restarts_or_preserves_the_deadline_and_rejects_stale_acks() {
        use std::time::{Duration, Instant};
        let grace = Duration::from_secs(2);
        let t0 = Instant::now();
        let mut tracker = AskTracker::default();

        // First gesture: a fresh streak.
        let (d, gen1) = tracker.decide_and_apply(true, false, t0, grace);
        assert_eq!(
            d,
            CloseDecision::Ask {
                restart_streak: true
            }
        );

        // Rule 6 inside the window must NOT move the deadline or the generation — otherwise impatient
        // presses could postpone the fallback for ever.
        let (d, gen_same) =
            tracker.decide_and_apply(true, false, t0 + Duration::from_millis(500), grace);
        assert_eq!(
            d,
            CloseDecision::Ask {
                restart_streak: false
            }
        );
        // Assert the DEADLINE itself, here, before any restart can overwrite `started`. Checking
        // only the generation would let an illicit rule-6 reset slip through the very test named as
        // its proof.
        assert_eq!(gen_same, gen1, "rule 6 keeps the generation");
        assert_eq!(tracker.generation, gen1, "rule 6 keeps the generation");
        assert!(!tracker.acked, "rule 6 does not invent an ack");
        assert_eq!(
            tracker.started,
            Some(t0),
            "rule 6 must NOT move the deadline"
        );

        // A stale ack from before a restart must be ignored.
        assert!(tracker.acknowledge(gen1), "the current generation acks");
        let (d, gen2) =
            tracker.decide_and_apply(true, false, t0 + Duration::from_millis(600), grace);
        assert_eq!(
            d,
            CloseDecision::Ask {
                restart_streak: true
            },
            "rule 4: acked ⇒ fresh streak"
        );
        assert_ne!(gen2, gen1, "a restart bumps the generation");
        assert!(
            !tracker.acknowledge(gen1),
            "the OLD generation must not ack the new streak"
        );

        // Still unacked past the grace window ⇒ the fallback fires.
        let (d, _) =
            tracker.decide_and_apply(true, false, t0 + Duration::from_millis(600) + grace, grace);
        assert_eq!(d, CloseDecision::TeardownAndExit);
    }

    #[test]
    fn exit_gate_input_maps_the_three_exit_sources() {
        // The restart code is trmx-267's and is never gated here.
        assert_eq!(exit_gate_input(Some(tauri::RESTART_EXIT_CODE), true), None);
        // A programmatic exit with the main window alive is gated as the PTY owner.
        assert_eq!(exit_gate_input(Some(0), true), Some(true));
        // `code: None` is emitted AFTER the last window was removed — there is nobody to ask, so it is
        // never gated as an owner however the caller believes the window state to be.
        assert_eq!(exit_gate_input(None, true), Some(false));
        assert_eq!(exit_gate_input(None, false), Some(false));
        assert_eq!(exit_gate_input(Some(0), false), Some(false));
    }

    #[test]
    fn webview_close_flow_logs_guard_ask_and_the_terminal_redrive_in_order() {
        use std::cell::RefCell;
        use std::time::{Duration, Instant};
        let grace = Duration::from_secs(2);

        let run = |is_owner: bool, ok: bool| -> Vec<&'static str> {
            let log = RefCell::new(Vec::new());
            let tracker = std::sync::Mutex::new(AskTracker::default());
            // Every collaborator try_locks the tracker: that can only succeed if the guard was
            // dropped first, which is exactly C1 — never re-enter Tauri (or `teardown_once`, which
            // joins the acceptor thread) while holding the lock. Reinstate the guard and this fails.
            let free = |what: &'static str| {
                assert!(
                    tracker.try_lock().is_ok(),
                    "the ASK lock must be free during `{what}` (C1)"
                );
            };
            webview_close_flow(
                &tracker,
                is_owner,
                Instant::now(),
                grace,
                |_e, _g| {
                    free("emit");
                    log.borrow_mut().push("emit");
                    if ok {
                        Ok(())
                    } else {
                        Err("no listener".to_string())
                    }
                },
                || {
                    free("authorize");
                    log.borrow_mut().push("authorize");
                },
                || {
                    free("teardown");
                    log.borrow_mut().push("teardown");
                },
                || {
                    free("redrive");
                    log.borrow_mut().push("redrive");
                },
            );
            log.into_inner()
        };

        // A non-owner (the settings webview) must not even reach the gate.
        assert_eq!(run(false, true), Vec::<&str>::new());
        // A delivered ask: the dialog owns it from here — nothing is torn down.
        assert_eq!(run(true, true), vec!["emit"]);
        // A FAILED ask is terminal, and a command has no event to "let proceed": it must authorize,
        // tear down, and RE-DRIVE a close — in that order. Drop the re-drive and the app survives its
        // own teardown; authorize after the close and the re-driven close gets re-gated.
        assert_eq!(
            run(true, false),
            vec!["emit", "authorize", "teardown", "redrive"]
        );
    }

    #[test]
    fn run_teardown_once_runs_the_body_exactly_once_under_a_race() {
        // trmx-267 acceptance: two racing callers → the body runs exactly once. Both threads wait on
        // a barrier so they genuinely contend on the latch instead of running in sequence, and the
        // assertion counts BODY EXECUTIONS — the property `begin_teardown_latches_exactly_once`
        // (which only inspects the latch's return value) leaves unpinned.
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let done = AtomicBool::new(false);
        let runs = AtomicUsize::new(0);
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|s| {
            for _ in 0..2 {
                s.spawn(|| {
                    barrier.wait();
                    run_teardown_once(&done, || {
                        runs.fetch_add(1, Ordering::SeqCst);
                    });
                });
            }
        });
        assert_eq!(
            runs.load(Ordering::SeqCst),
            1,
            "the teardown body runs exactly once"
        );
    }

    #[test]
    fn exit_action_tears_down_only_on_the_updater_restart_code() {
        // trmx-267: the updater's `relaunch()` reaches `AppHandle::request_restart()`, which always
        // requests an exit with RESTART_EXIT_CODE — that is the one code this gate owns. Named, not
        // spelled `i32::MAX`: the point is that we agree with Tauri's constant, so if upstream ever
        // changes it this test must follow rather than silently pass.
        assert_eq!(
            exit_action(Some(tauri::RESTART_EXIT_CODE)),
            ExitAction::TeardownAndProceed
        );
        // Every other code belongs to the window close gate. trmx-268 owns user-initiated quit
        // consent; tearing down here would kill busy shells before its dialog could run.
        assert_eq!(exit_action(None), ExitAction::LeaveToCloseGate);
        assert_eq!(exit_action(Some(0)), ExitAction::LeaveToCloseGate);
        assert_eq!(exit_action(Some(1)), ExitAction::LeaveToCloseGate);
    }

    #[test]
    fn begin_teardown_latches_exactly_once() {
        // trmx-144: however many close paths race (authorized CloseRequested, quit_confirmed
        // re-drive), the main teardown body must run once.
        let done = std::sync::atomic::AtomicBool::new(false);
        assert!(begin_teardown(&done));
        assert!(!begin_teardown(&done));
        assert!(!begin_teardown(&done));
    }

    #[test]
    fn core_version_reports_the_core_crate_version() {
        // The placeholder IPC command must report a non-empty version equal to the core crate's.
        let v = core_version();
        assert!(!v.is_empty(), "core version must not be empty");
        assert_eq!(v, termixion_platform::CORE_VERSION);
    }

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
            result.map(|(id, _reader)| id),
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

    // --- trmx-78 round 2: the natural-batching sender seam ------------------------------------

    use std::sync::mpsc::{Receiver, sync_channel};

    fn chunks(rx_cap: usize, items: &[&[u8]]) -> Receiver<Vec<u8>> {
        let (tx, rx) = sync_channel::<Vec<u8>>(rx_cap);
        for item in items {
            tx.send(item.to_vec()).expect("queue");
        }
        rx
    }

    #[test]
    fn next_batch_forwards_a_lone_chunk_immediately() {
        // Idle path: one queued echo byte becomes one batch — zero added latency by construction.
        let rx = chunks(8, &[b"x" as &[u8]]);
        assert_eq!(next_batch(&rx, 1024), Some(b"x".to_vec()));
    }

    #[test]
    fn next_batch_coalesces_a_backlog_into_one_ordered_batch() {
        let rx = chunks(8, &[b"aa" as &[u8], b"bb", b"cc"]);
        assert_eq!(next_batch(&rx, 1024), Some(b"aabbcc".to_vec()));
    }

    #[test]
    fn next_batch_respects_the_cap_and_leaves_the_rest_queued() {
        let rx = chunks(8, &[b"aaaa" as &[u8], b"bbbb", b"cccc"]);
        // Cap of 6 bytes: the first chunk always goes; the drain stops once the batch reaches it.
        assert_eq!(next_batch(&rx, 6), Some(b"aaaabbbb".to_vec()));
        assert_eq!(next_batch(&rx, 6), Some(b"cccc".to_vec()));
    }

    #[test]
    fn next_batch_returns_none_when_closed_and_empty() {
        let (tx, rx) = sync_channel::<Vec<u8>>(1);
        drop(tx);
        assert_eq!(next_batch(&rx, 1024), None);
    }

    #[test]
    fn next_batch_drains_residue_after_close_then_none() {
        let (tx, rx) = sync_channel::<Vec<u8>>(4);
        tx.send(b"tail".to_vec()).expect("queue");
        drop(tx);
        assert_eq!(next_batch(&rx, 1024), Some(b"tail".to_vec()));
        assert_eq!(next_batch(&rx, 1024), None);
    }

    /// Shared event log for the sender-lifecycle tests: send_batch and on_done both append, so
    /// ordering and exactly-once are assertable from one sequence.
    type EventLog = Arc<Mutex<Vec<String>>>;

    fn event_log() -> (EventLog, EventLog, EventLog) {
        let log: EventLog = Arc::new(Mutex::new(Vec::new()));
        (Arc::clone(&log), Arc::clone(&log), log)
    }

    #[test]
    fn sender_flushes_the_queued_tail_before_on_done() {
        // (f) flush-before-reap: everything queued at close is delivered BEFORE on_done runs, so
        // the frontend can never see pty:exited ahead of the stream's final bytes.
        let (tx, rx) = sync_channel::<Vec<u8>>(8);
        tx.send(b"tail-a".to_vec()).expect("queue");
        tx.send(b"tail-b".to_vec()).expect("queue");
        drop(tx);
        let (for_send, for_done, log) = event_log();
        run_batch_sender(
            rx,
            1024,
            Duration::from_millis(PTY_BATCH_WINDOW_MS),
            move |batch| {
                for_send
                    .lock()
                    .expect("log")
                    .push(format!("batch:{}", String::from_utf8_lossy(&batch)));
                true
            },
            move || for_done.lock().expect("log").push("done".to_string()),
        );
        assert_eq!(
            *log.lock().expect("log"),
            vec!["batch:tail-atail-b".to_string(), "done".to_string()]
        );
    }

    #[test]
    fn sender_fires_on_done_exactly_once_on_eof() {
        // (g) exactly-once completion on the normal end (pump dropped its sender).
        let (tx, rx) = sync_channel::<Vec<u8>>(1);
        drop(tx);
        let (_, for_done, log) = event_log();
        run_batch_sender(
            rx,
            1024,
            Duration::from_millis(PTY_BATCH_WINDOW_MS),
            |_| true,
            move || {
                for_done.lock().expect("log").push("done".to_string());
            },
        );
        assert_eq!(*log.lock().expect("log"), vec!["done".to_string()]);
    }

    #[test]
    fn sender_send_failure_terminates_and_still_fires_on_done_once() {
        // (h) fail-close: the transport rejecting a batch ends the loop; on_done still runs
        // exactly once (the reap path must cover the webview-gone case).
        let (tx, rx) = sync_channel::<Vec<u8>>(8);
        tx.send(b"a".to_vec()).expect("queue");
        tx.send(b"b".to_vec()).expect("queue");
        // tx deliberately kept alive: termination must come from the send failure, not EOF.
        let (for_send, for_done, log) = event_log();
        run_batch_sender(
            rx,
            1024,
            Duration::from_millis(PTY_BATCH_WINDOW_MS),
            move |_| {
                for_send
                    .lock()
                    .expect("log")
                    .push("send-attempt".to_string());
                false
            },
            move || for_done.lock().expect("log").push("done".to_string()),
        );
        assert_eq!(
            *log.lock().expect("log"),
            vec!["send-attempt".to_string(), "done".to_string()]
        );
        drop(tx);
    }

    #[test]
    fn sender_runs_on_done_even_when_send_batch_panics() {
        // Field evidence (trmx-78 round 2): the sender thread died without reaping — an unwind
        // between the loop and on_done orphans the session (the poller spins on a stale pid and
        // the webview waits forever). on_done must be exactly-once even on panic.
        let (tx, rx) = sync_channel::<Vec<u8>>(4);
        tx.send(b"boom".to_vec()).expect("queue");
        drop(tx);
        let (_, for_done, log) = event_log();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            run_batch_sender(
                rx,
                1024,
                Duration::from_millis(PTY_BATCH_WINDOW_MS),
                |_| panic!("simulated Channel::send panic"),
                move || for_done.lock().expect("log").push("done".to_string()),
            );
        }));
        assert!(result.is_err(), "the panic propagates");
        assert_eq!(*log.lock().expect("log"), vec!["done".to_string()]);
    }

    // --- trmx-78 round 2b: credit-based flow control -------------------------------------------

    #[test]
    fn credit_cell_deducts_while_positive_without_parking() {
        // Positive credits never park — a batch may overdraw into negative (bounded by the batch
        // cap), which is what makes the accounting simple: park only at <= 0.
        let cell = CreditCell::new(8);
        let started = std::time::Instant::now();
        cell.consume_floored(6, Duration::from_millis(500), -100);
        cell.consume_floored(6, Duration::from_millis(500), -100); // 2 left: positive, overdraws
        assert!(
            started.elapsed() < Duration::from_millis(100),
            "no parking while positive"
        );
        cell.refill(100);
        let after_refill = std::time::Instant::now();
        cell.consume_floored(50, Duration::from_millis(50), -100);
        assert!(
            after_refill.elapsed() < Duration::from_millis(40),
            "a refilled cell consumes without parking"
        );
    }

    #[test]
    fn credit_cell_zero_or_negative_parks_and_refill_unparks() {
        let cell = Arc::new(CreditCell::new(4));
        cell.consume_floored(4, Duration::from_millis(50), 0); // now 0 — the next one parks
        let parked = Arc::clone(&cell);
        let (tx, rx) = mpsc::channel::<bool>();
        let waiter = std::thread::spawn(move || {
            // floor 0: at zero credits there is no probe headroom — a pure park-until-refill.
            parked.consume_floored(2, Duration::from_millis(200), 0);
            tx.send(true).expect("send");
        });
        std::thread::sleep(Duration::from_millis(80));
        assert!(
            rx.try_recv().is_err(),
            "consumer must be parked while credits are exhausted"
        );
        cell.refill(10);
        let got = rx.recv_timeout(Duration::from_secs(2)).expect("unparked");
        assert!(got, "refill unparks the consumer");
        waiter.join().expect("waiter");
    }

    #[test]
    fn credit_cell_timeout_probe_proceeds_above_the_floor() {
        // A webview that stops acking: the bounded wait expires and the consumer PROBES (send
        // failure of a dead channel ends the loop) — but only above the overdraw floor.
        let cell = CreditCell::new(1);
        cell.consume_floored(1, Duration::from_millis(10), -100);
        let started = std::time::Instant::now();
        // Above the floor, an unacked wait EXPIRES and the consumer proceeds — observable as the
        // call returning after roughly the slice rather than parking indefinitely.
        cell.consume_floored(1, Duration::from_millis(60), -100);
        let waited = started.elapsed();
        assert!(
            waited >= Duration::from_millis(55),
            "waited the slice: {waited:?}"
        );
        assert!(
            waited < Duration::from_millis(500),
            "but did not park: {waited:?}"
        );
    }

    #[test]
    fn credit_overdraw_is_floor_bounded_probes_stop_at_the_floor() {
        // R2 step-8 F1: timeout-proceed must NOT allow unbounded overdraw against a channel that
        // queues forever without acks. Probes proceed only while credits stay above the floor;
        // at the floor the consumer parks (sliced, indefinitely) until a refill.
        let cell = Arc::new(CreditCell::new(4));
        // Drain into overdraw with timeout-probes: 4 -> 0 -> -4 (floor for this test = -4).
        cell.consume_floored(4, Duration::from_millis(10), -4);
        cell.consume_floored(4, Duration::from_millis(10), -4); // probe: 0 > floor
        // credits now -4 == floor: further consumes must PARK, not proceed.
        let parked = Arc::clone(&cell);
        let (tx, rx) = mpsc::channel::<bool>();
        let waiter = std::thread::spawn(move || {
            parked.consume_floored(4, Duration::from_millis(30), -4);
            tx.send(true).expect("send");
        });
        std::thread::sleep(Duration::from_millis(120));
        assert!(
            rx.try_recv().is_err(),
            "at the floor the consumer must stay parked across slices"
        );
        cell.refill(100);
        assert!(
            rx.recv_timeout(Duration::from_secs(2)).expect("unparked"),
            "refill releases it"
        );
        waiter.join().expect("waiter");
    }

    #[test]
    fn sender_drops_the_receiver_before_on_done_runs() {
        // R2 step-8 F2: `rx` must drop BEFORE the done guard fires, so a producer blocked on the
        // full hand-off is already released (SendError) by the time `on_done` — the reap — runs.
        //
        // trmx-250: asserted through the drop ORDER, with no threads, no sleeps and no timeouts.
        // The previous shape parked a real producer on a blocking send and could not be made
        // deterministic: `next_batch` consumes the buffered item, which frees the slot and lets the
        // blocked send SUCCEED, so the test raced `send_batch → false → break → drop(rx)` against
        // the producer waking up. It failed roughly 1 run in 70 on
        // `assert!(producer.join()…is_err())` and cost a CI re-run on five separate PRs.
        //
        // The receiver being gone is precisely what releases a blocked producer, so observing that
        // from inside `on_done` pins the same invariant — and, unlike the old test, it cannot pass
        // by accident: a still-live receiver would ACCEPT this probe, because `next_batch` has just
        // freed the slot.
        //
        // This also subsumes the former `sender_end_releases_a_producer_blocked_on_the_full_queue`,
        // which raced the same way (5 failures in 150 harness runs, measured) and whose premise was
        // not achievable deterministically: `run_batch_sender` always consumes a batch before it
        // breaks, so the consumer itself frees the producer — there is no way to hold one blocked
        // while the consumer runs. What that test actually asserted beyond this one was
        // `std::sync::mpsc`'s own guarantee that a blocked send resolves to `SendError` once the
        // receiver drops; the part that is OURS is that `run_batch_sender` drops the receiver at
        // all, and does so before the reap — which is exactly what is asserted here.
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::mpsc::TrySendError;

        let (tx, rx) = sync_channel::<Vec<u8>>(1);
        tx.send(b"one".to_vec()).expect("queue"); // one batch, so the loop body runs exactly once
        let probe = tx.clone();
        let receiver_gone = std::sync::Arc::new(AtomicBool::new(false));
        let observed = std::sync::Arc::clone(&receiver_gone);

        run_batch_sender(
            rx,
            1024,
            Duration::from_millis(PTY_BATCH_WINDOW_MS),
            |_| false, // transport gone → break after the first batch
            move || {
                observed.store(
                    matches!(
                        probe.try_send(b"probe".to_vec()),
                        Err(TrySendError::Disconnected(_))
                    ),
                    Ordering::SeqCst,
                );
            },
        );

        assert!(
            receiver_gone.load(Ordering::SeqCst),
            "rx must drop before on_done runs, so a producer blocked on the hand-off is already \
             released when the reap fires"
        );
    }

    #[test]
    fn sender_paces_a_flood_into_windowed_batches_against_a_nonblocking_transport() {
        // Field evidence (round 2): Tauri's channel.send returns quickly (internal queueing, no
        // backpressure), so drain-only "natural batching" never accumulates — a `yes` flood still
        // became millions of tiny messages. The sender must FORCE coalescing: after a send,
        // accumulate for the window before the next send. The test uses a GENEROUS 200 ms window
        // so CI scheduler noise (which flaked the original 4 ms-window version at 96 sends) has
        // real slack: 50 chunks paced ~1 ms fall well inside one window even at 10× stretch.
        let (tx, rx) = sync_channel::<Vec<u8>>(256);
        let producer = std::thread::spawn(move || {
            for _ in 0..50 {
                tx.send(vec![b'y'; 2]).expect("queue");
                std::thread::sleep(Duration::from_millis(1));
            }
        });
        let batches: Arc<Mutex<Vec<usize>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&batches);
        run_batch_sender(
            rx,
            1024 * 1024,
            Duration::from_millis(200),
            move |batch| {
                sink.lock().expect("batches").push(batch.len());
                true
            },
            || {},
        );
        producer.join().expect("producer");
        let sent = batches.lock().expect("batches");
        let total: usize = sent.iter().sum();
        assert_eq!(total, 100, "every byte arrives exactly once, in order");
        assert!(
            sent.len() <= 5,
            "a paced flood must coalesce into windowed batches (window 200ms), got {} sends",
            sent.len()
        );
    }

    #[test]
    fn sender_first_send_after_idle_is_immediate() {
        // The pacing must never tax the idle path: a lone echo byte after a quiet period goes out
        // without waiting for the window (typing latency budget).
        let (tx, rx) = sync_channel::<Vec<u8>>(4);
        let started = std::time::Instant::now();
        tx.send(b"x".to_vec()).expect("queue");
        drop(tx);
        let sent_at: Arc<Mutex<Option<Duration>>> = Arc::new(Mutex::new(None));
        let sink = Arc::clone(&sent_at);
        run_batch_sender(
            rx,
            1024,
            Duration::from_millis(PTY_BATCH_WINDOW_MS),
            move |_| {
                *sink.lock().expect("sent") = Some(started.elapsed());
                true
            },
            || {},
        );
        let elapsed = sent_at.lock().expect("sent").expect("one send happened");
        assert!(
            elapsed < Duration::from_millis(PTY_BATCH_WINDOW_MS * 2),
            "idle send must be immediate-ish, took {elapsed:?}"
        );
    }
}
