// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-243 (grill H5): the PTY session surface, extracted verbatim from `main.rs`.
//!
//! Everything between the webview and a live terminal session (ADR-0001): [`PtyState`] (the
//! registry, the poller gate and the per-session flow-control cells), the spawn path with its cwd
//! fallback notice, the natural-batching hand-off between the core reader pump and the IPC channel
//! ([`next_batch`], [`run_batch_sender`]) with its credit window ([`CreditCell`]), and the five
//! commands the frontend routes by session id.
//!
//! The transport invariants live in the doc comments beside the code that implements them: one
//! Tauri `Channel` per session, a BOUNDED hand-off queue ([`PTY_HANDOFF_CHUNKS`]) so a slow webview
//! backpressures the PTY reader instead of growing a queue, a [`PTY_BATCH_MAX_BYTES`] cap on one
//! coalesced message, and a [`PTY_CREDIT_BYTES`] unacked-byte window the webview refills from
//! xterm's parse callback via `pty_ack`.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use tauri::ipc::Channel;
use tauri::{Emitter, Manager, State};
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
pub(crate) fn open_pty(
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
pub(crate) fn pty_write(
    session_id: u64,
    data: Vec<u8>,
    state: State<'_, PtyState>,
) -> Result<(), String> {
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
pub(crate) fn pty_resize(
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
pub(crate) fn close_pty(session_id: u64, state: State<'_, PtyState>) -> Result<(), String> {
    state
        .registry
        .lock()
        .map_err(|_| "pty state poisoned".to_string())?
        .close(session_id)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

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
