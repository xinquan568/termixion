// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
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

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use tauri::ipc::Channel;
use tauri::{Emitter, Manager, State, WindowEvent};
use termixion_core::{PtySize, SessionRegistry, SessionSpec};
use termixion_platform::{MacosPtyFactory, foreground_process};

mod menu;
mod window_manager;

/// The live terminal sessions (trmx-74): one per tab, keyed by the registry's monotonic
/// **never-reused** ids. That id discipline replaces the old single-slot generation counter — a
/// stale reader thread reaping its own id after that session is gone is an idempotent no-op that
/// can never touch another session (documented in `termixion_core::registry`). trmx-75 adds the
/// [`PollerGate`] `open_pty` uses to wake the foreground-title poller out of its zero-session park.
#[derive(Default)]
struct PtyState {
    registry: Arc<Mutex<SessionRegistry>>,
    poller_gate: Arc<PollerGate>,
}

/// trmx-75: the zero-session park for the foreground-title poller — a REAL condvar block, not a
/// timed idle loop, so an empty world costs zero wakeups. `has_sessions` is a **wake latch**:
/// [`PollerGate::notify_session_opened`] sets it (then wakes), and the poller's
/// [`PollerGate::wait_while_empty`] blocks until it is set, consuming it on return. The
/// set-BEFORE-wake + consume-on-return protocol makes a missed wake impossible: a session opened
/// between the poller's empty snapshot and its park leaves the latch set, so the park is a
/// pass-through and the next snapshot sees the session. (The cost is at most one spurious
/// pass-through after a stale latch — the poller just re-reads an empty snapshot and parks.)
#[derive(Default)]
struct PollerGate {
    has_sessions: Mutex<bool>,
    wake: Condvar,
}

impl PollerGate {
    /// A session was spawned: set the latch, then wake a parked poller. Called by `open_pty`
    /// after a successful spawn (never on failure — nothing new to watch).
    fn notify_session_opened(&self) {
        if let Ok(mut opened) = self.has_sessions.lock() {
            *opened = true;
        }
        self.wake.notify_all();
    }

    /// Block until a session has been opened (since the last consumed wake), then consume the
    /// latch so the NEXT empty-world park blocks again. Poisoned-lock recovery is "just return":
    /// a poisoned gate means a panicking peer, and the poller degrades to re-snapshotting.
    fn wait_while_empty(&self) {
        let Ok(guard) = self.has_sessions.lock() else {
            return;
        };
        let Ok(mut opened) = self.wake.wait_while(guard, |opened| !*opened) else {
            return;
        };
        *opened = false;
    }
}

/// Payload of the `session:title-hint` event (trmx-75): the foreground poller observed that
/// session `session_id`'s foreground process is now `name`. A **hint only** — the frontend folds
/// it into its per-tab title sources (where manual/OSC outrank it) and remains the single core-
/// title writer; the poller never calls `registry.set_title`. camelCase for the frontend.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TitleHint {
    session_id: u64,
    name: String,
}

/// One poller tick's pure diff (trmx-75): `resolved` is this tick's snapshot with the foreground
/// names already resolved (`None` = resolution failed right now), `prev` the names last hinted.
/// Returns the change-only hints (new session, or a name that differs from `prev`) plus the next
/// carry map. Dead sessions (absent from `resolved`) drop out of the carry; an unresolved name
/// carries its previous value silently so a transient `ps` hiccup neither hints nor causes the
/// recovered identical name to re-emit. Pure — the subprocess edge stays in the loop around it.
fn poll_tick(
    resolved: Vec<(u64, Option<String>)>,
    prev: &HashMap<u64, String>,
) -> (Vec<TitleHint>, HashMap<u64, String>) {
    let mut hints = Vec::new();
    let mut next = HashMap::new();
    for (session_id, name) in resolved {
        match name {
            Some(name) => {
                if prev.get(&session_id) != Some(&name) {
                    hints.push(TitleHint {
                        session_id,
                        name: name.clone(),
                    });
                }
                next.insert(session_id, name);
            }
            None => {
                if let Some(kept) = prev.get(&session_id) {
                    next.insert(session_id, kept.clone());
                }
            }
        }
    }
    (hints, next)
}

/// trmx-75: the foreground-title poller loop, spawned once in `setup`. Each tick snapshots
/// `(id, shell_pid)` pairs under the registry lock and **drops the lock before any `ps` call**
/// (lock discipline — subprocess latency must never stall `pty_write`); an empty snapshot clears
/// the carry map (a reopened world starts fresh) and parks on the [`PollerGate`] condvar until
/// `open_pty` wakes it; otherwise it resolves names via [`foreground_process`], diffs through the
/// pure [`poll_tick`], emits `session:title-hint` best-effort (the webview may be mid-teardown),
/// and sleeps 1 s. It NEVER writes core titles — the frontend is the single writer.
fn run_title_poller(
    app: tauri::AppHandle,
    registry: Arc<Mutex<SessionRegistry>>,
    gate: Arc<PollerGate>,
) {
    let mut prev: HashMap<u64, String> = HashMap::new();
    loop {
        // Snapshot under the lock, then release it before the subprocess calls below.
        let snapshot: Vec<(u64, Option<u32>)> = match registry.lock() {
            Ok(reg) => reg
                .ids()
                .into_iter()
                .map(|id| (id, reg.process_id(id).ok().flatten()))
                .collect(),
            // A poisoned registry means a panicking peer thread; the poller is best-effort
            // decoration, so it just stops rather than compounding the failure.
            Err(_) => return,
        };
        if snapshot.is_empty() {
            prev.clear();
            gate.wait_while_empty();
            continue;
        }
        let resolved: Vec<(u64, Option<String>)> = snapshot
            .into_iter()
            .map(|(id, pid)| {
                (
                    id,
                    pid.and_then(|pid| foreground_process(pid).map(|fg| fg.name)),
                )
            })
            .collect();
        let (hints, next) = poll_tick(resolved, &prev);
        prev = next;
        for hint in hints {
            let _ = app.emit("session:title-hint", hint);
        }
        std::thread::sleep(Duration::from_secs(1));
    }
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
fn session_spec_for(smoke: bool, perf: bool, cwd: Option<String>) -> SessionSpec {
    if smoke || perf {
        let mut s = SessionSpec::shell("/bin/zsh");
        s.args.push("-f".into());
        s
    } else {
        let mut s = SessionSpec::login_shell();
        if let Some(dir) = cwd {
            s.cwd = Some(PathBuf::from(dir));
        }
        s
    }
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
    mut send_batch: impl FnMut(Vec<u8>) -> bool,
    on_done: impl FnOnce(),
) {
    while let Some(batch) = next_batch(&rx, max) {
        if !send_batch(batch) {
            break; // transport gone (webview/channel closed)
        }
    }
    drop(rx);
    on_done();
}

#[tauri::command]
fn open_pty(
    app: tauri::AppHandle,
    channel: Channel<Vec<u8>>,
    rows: u16,
    cols: u16,
    cwd: Option<String>,
    state: State<'_, PtyState>,
    launch: State<'_, SpecialLaunch>,
) -> Result<SessionInfo, String> {
    let spec = session_spec_for(launch.smoke.is_some(), launch.perf.is_some(), cwd);

    let (id, reader) = state
        .registry
        .lock()
        .map_err(|_| "pty state poisoned".to_string())?
        .spawn(&MacosPtyFactory, &spec, PtySize::new(rows, cols))
        .map_err(|e| e.to_string())?;

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
            |batch| channel.send(batch).is_ok(),
            move || {
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

/// The special-launch state (C-3 smoke / trmx-78 perf): at most one is set (launch_modes gives
/// smoke precedence). One managed struct so `open_pty` reads a single State.
struct SpecialLaunch {
    smoke: Option<String>,
    perf: Option<String>,
}

/// Whether/how the packaged smoke runs. `MissingDir` (smoke requested but no `DIR`) must FAIL the gate,
/// not silently launch the app — otherwise the packaged `--smoke` would hang CI instead of exiting 1.
enum SmokeMode {
    Off,
    MissingDir,
    On(String),
}

/// Resolve smoke mode: `--smoke` arg OR truthy `TERMIXION_SMOKE` enables it; the sentinel dir is the
/// `DIR` env var (the pre-created `mktemp -d` holding `SMOKE_OK`). Pure, for testing.
fn smoke_mode<I: IntoIterator<Item = String>>(
    args: I,
    smoke_env: Option<String>,
    dir_env: Option<String>,
) -> SmokeMode {
    let enabled = args.into_iter().any(|a| a == "--smoke")
        || smoke_env.is_some_and(|v| v == "1" || v == "true");
    if !enabled {
        return SmokeMode::Off;
    }
    match dir_env.filter(|d| !d.is_empty()) {
        Some(dir) => SmokeMode::On(dir),
        None => SmokeMode::MissingDir,
    }
}

/// The webview asks whether to run the end-to-end smoke, and against which dir (`None` = normal launch).
#[tauri::command]
fn smoke_config(launch: State<'_, SpecialLaunch>) -> Option<String> {
    launch.smoke.clone()
}

/// Whether/how the NFR-1 perf harness runs (trmx-78) — the exact [`SmokeMode`] shape: requesting
/// perf without an output dir must FAIL the launch, not silently start the app.
enum PerfMode {
    Off,
    MissingDir,
    On(String),
}

/// Resolve perf mode: `--perf` arg OR truthy `TERMIXION_PERF` enables it; the report target is
/// the `TERMIXION_PERF_OUT` env dir. Pure, for testing (mirror of [`smoke_mode`]).
fn perf_mode<I: IntoIterator<Item = String>>(
    args: I,
    perf_env: Option<String>,
    out_env: Option<String>,
) -> PerfMode {
    let enabled = args.into_iter().any(|a| a == "--perf")
        || perf_env.is_some_and(|v| v == "1" || v == "true");
    if !enabled {
        return PerfMode::Off;
    }
    match out_env.filter(|d| !d.is_empty()) {
        Some(dir) => PerfMode::On(dir),
        None => PerfMode::MissingDir,
    }
}

/// Combine the two special-launch resolutions (trmx-78, pure): smoke wins if both are requested
/// (never expected — pinned by test), and either mode's MissingDir is a hard, fail-fast error.
fn launch_modes(
    smoke: SmokeMode,
    perf: PerfMode,
) -> Result<(Option<String>, Option<String>), String> {
    let smoke = match smoke {
        SmokeMode::Off => None,
        SmokeMode::On(dir) => Some(dir),
        SmokeMode::MissingDir => {
            return Err("termixion-smoke: FAIL — smoke requested but DIR is missing/empty".into());
        }
    };
    let perf = match perf {
        PerfMode::Off => None,
        PerfMode::On(dir) => Some(dir),
        PerfMode::MissingDir => {
            return Err(
                "termixion-perf: FAIL — perf requested but TERMIXION_PERF_OUT is missing/empty"
                    .into(),
            );
        }
    };
    if smoke.is_some() {
        return Ok((smoke, None));
    }
    Ok((None, perf))
}

/// What `perf_config` returns to the webview (trmx-78): where to have the report written, and
/// which build produced it (budgets are only recorded from `release`). camelCase for the frontend.
#[derive(Clone, serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PerfConfig {
    out_dir: String,
    build: &'static str,
}

/// The perf watchdog (trmx-78): fail the run rather than hang if the webview driver never reports.
/// 300 s ≈ 3× the harness's end-to-end schedule — the derivation is pinned in the tests below and
/// quoted by docs/design/performance-protocol.md.
const PERF_WATCHDOG_SECS: u64 = 300;

/// The webview asks whether to run the NFR-1 perf harness (`None` = normal launch), and learns
/// the report dir + build kind (trmx-78).
#[tauri::command]
fn perf_config(launch: State<'_, SpecialLaunch>) -> Option<PerfConfig> {
    launch.perf.clone().map(|out_dir| PerfConfig {
        out_dir,
        build: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
    })
}

/// The webview reports the perf result (trmx-78): persist the JSON report to the out dir, then
/// exit `0`/`1` on budget pass/fail so `scripts/perf.sh` is a gate. The report lands on disk
/// either way — a failed run's numbers are exactly the ones worth reading.
#[tauri::command]
fn perf_done(report: String, success: bool, launch: State<'_, SpecialLaunch>) {
    if let Some(dir) = launch.perf.as_ref() {
        let path = Path::new(dir).join("report.json");
        if let Err(err) = std::fs::create_dir_all(dir).and_then(|()| std::fs::write(&path, &report))
        {
            eprintln!(
                "termixion-perf: FAIL — could not write {}: {err}",
                path.display()
            );
            std::process::exit(1);
        }
        println!("termixion-perf: report written to {}", path.display());
    }
    if success {
        println!("termixion-perf: OK — budgets met");
        std::process::exit(0);
    }
    eprintln!("termixion-perf: FAIL — budgets missed or the run was invalid");
    std::process::exit(1);
}

/// The webview reports the smoke result; exit the process `0`/`1` so the packaged `--smoke` is a gate.
#[tauri::command]
fn smoke_done(success: bool, reason: String) {
    if success {
        println!("termixion-smoke: OK — {reason}");
        std::process::exit(0);
    }
    eprintln!("termixion-smoke: FAIL — {reason}");
    std::process::exit(1);
}

fn main() -> ExitCode {
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
            eprintln!("{msg}");
            return ExitCode::FAILURE;
        }
    };
    if smoke.is_some() {
        // Watchdog: fail the smoke (exit 1) rather than hang if the webview never reports back.
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(30));
            eprintln!(
                "termixion-smoke: FAIL — timed out waiting for the webview sentinel sequence"
            );
            std::process::exit(1);
        });
    }
    if perf.is_some() {
        // trmx-78: same discipline, sized to the harness's schedule (see PERF_WATCHDOG_SECS).
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(PERF_WATCHDOG_SECS));
            eprintln!("termixion-perf: FAIL — timed out waiting for the webview perf driver");
            std::process::exit(1);
        });
    }

    let result = tauri::Builder::default()
        // trmx-48: auto-update (updater + relaunch) and opening external links from the About page.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(PtyState::default())
        .manage(SpecialLaunch { smoke, perf })
        // trmx-48/trmx-51: install the app menu; "About Termixion" / "Settings…" open the
        // standalone Settings window (About lands on the About page). trmx-74 adds the Shell
        // submenu + Window tab-cycling items; trmx-75 adds Rename Tab… and spawns the
        // foreground-title poller (parked on its condvar gate until the first session opens).
        .setup(|app| {
            let menu = menu::build_menu(app.handle())?;
            app.set_menu(menu)?;
            let state = app.state::<PtyState>();
            let registry = Arc::clone(&state.registry);
            let gate = Arc::clone(&state.poller_gate);
            let poller_app = app.handle().clone();
            std::thread::spawn(move || run_title_poller(poller_app, registry, gate));
            Ok(())
        })
        .on_menu_event(|app, event| {
            // No unwrap/expect anywhere here: report and carry on rather than panic (a broken
            // menu item must not take the terminal down).
            match menu::menu_action(event.id().0.as_str()) {
                Some(menu::MenuAction::ShowSettings { section }) => {
                    if let Err(err) = window_manager::show_settings_window(app, section) {
                        eprintln!("termixion: failed to open the settings window: {err}");
                    }
                }
                // trmx-74: the frontend tab manager owns tab state, so the menu just broadcasts
                // the intent ("new"/"close"/"next"/"prev") as a `tabs:action` event.
                Some(menu::MenuAction::EmitTabsAction(action)) => {
                    if let Err(err) = app.emit("tabs:action", action) {
                        eprintln!("termixion: failed to emit tabs:action ({action}): {err}");
                    }
                }
                // trmx-74: ⌘W closes a tab now; Close Window (⇧⌘W) closes the main window, which
                // kills every session via the CloseRequested handler below.
                Some(menu::MenuAction::CloseMainWindow) => {
                    if let Some(window) = app.get_webview_window(window_manager::MAIN_WINDOW_LABEL)
                    {
                        let _ = window.close();
                    }
                }
                None => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            core_version,
            open_pty,
            pty_write,
            pty_resize,
            close_pty,
            set_session_title,
            smoke_config,
            smoke_done,
            perf_config,
            perf_done
        ])
        .on_window_event(|window, event| {
            // trmx-51: only the MAIN window owns the PTY sessions — closing the settings window
            // must leave the terminal alone. Closing main kills every live session (trmx-74:
            // `registry.kill_all()`, no zombies) and takes the settings window with it, so the
            // app exits exactly as it did when main was the only window.
            if let WindowEvent::CloseRequested { .. } = event {
                if !window_manager::disposes_pty_for(window.label()) {
                    return;
                }
                if let Some(state) = window.try_state::<PtyState>()
                    && let Ok(mut registry) = state.registry.lock()
                {
                    registry.kill_all();
                }
                if let Some(settings) = window
                    .app_handle()
                    .get_webview_window(window_manager::SETTINGS_WINDOW_LABEL)
                {
                    let _ = settings.close();
                }
            }
        })
        .run(tauri::generate_context!());

    if let Err(err) = result {
        // No unwrap/expect: report and exit non-zero rather than panic.
        eprintln!("termixion: fatal error running the app: {err}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;

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

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn mode(args_v: &[&str], smoke_env: Option<&str>, dir_env: Option<&str>) -> SmokeMode {
        smoke_mode(
            args(args_v),
            smoke_env.map(str::to_string),
            dir_env.map(str::to_string),
        )
    }

    // --- trmx-75: the foreground-title poller's pure pieces -----------------------------------

    /// Build a prev/next carry map from `(id, name)` pairs.
    fn names(entries: &[(u64, &str)]) -> HashMap<u64, String> {
        entries
            .iter()
            .map(|(id, name)| (*id, (*name).to_string()))
            .collect()
    }

    /// Build a resolved snapshot (`id` → the foreground name `ps` yielded, or `None`).
    fn resolved(entries: &[(u64, Option<&str>)]) -> Vec<(u64, Option<String>)> {
        entries
            .iter()
            .map(|(id, name)| (*id, name.map(str::to_string)))
            .collect()
    }

    fn hint(session_id: u64, name: &str) -> TitleHint {
        TitleHint {
            session_id,
            name: name.to_string(),
        }
    }

    #[test]
    fn poll_tick_hints_new_and_changed_names_and_keeps_unchanged_silent() {
        // Session 1 is new, session 2's name changed, session 3 is unchanged — only 1 and 2
        // emit (change-only diffing bounds emissions), and next carries all three.
        let prev = names(&[(2, "zsh"), (3, "vim")]);
        let (hints, next) = poll_tick(
            resolved(&[(1, Some("zsh")), (2, Some("sleep")), (3, Some("vim"))]),
            &prev,
        );
        assert_eq!(hints, vec![hint(1, "zsh"), hint(2, "sleep")]);
        assert_eq!(next, names(&[(1, "zsh"), (2, "sleep"), (3, "vim")]));
    }

    #[test]
    fn poll_tick_all_unchanged_emits_nothing() {
        let prev = names(&[(1, "zsh"), (2, "vim")]);
        let (hints, next) = poll_tick(resolved(&[(1, Some("zsh")), (2, Some("vim"))]), &prev);
        assert!(hints.is_empty(), "unchanged names must stay silent");
        assert_eq!(next, prev);
    }

    #[test]
    fn poll_tick_drops_dead_sessions_without_hinting() {
        // Session 1 closed between ticks: it vanishes from next (no residue for a future id —
        // ids are never reused anyway) and emits nothing.
        let prev = names(&[(1, "zsh"), (2, "vim")]);
        let (hints, next) = poll_tick(resolved(&[(2, Some("vim"))]), &prev);
        assert!(hints.is_empty());
        assert_eq!(next, names(&[(2, "vim")]));
    }

    #[test]
    fn poll_tick_empty_snapshot_clears_the_carry_and_emits_nothing() {
        // The pure mirror of the poller's park path: a world with no sessions starts fresh.
        let prev = names(&[(1, "zsh")]);
        let (hints, next) = poll_tick(Vec::new(), &prev);
        assert!(hints.is_empty());
        assert!(next.is_empty());
    }

    #[test]
    fn poll_tick_churn_between_ticks_hints_only_the_new_session() {
        // Close + open between ticks: the dead id is dropped and the NEW session hints even
        // though its name equals the dead one's (a fresh tab must still learn its title).
        let prev = names(&[(1, "zsh")]);
        let (hints, next) = poll_tick(resolved(&[(2, Some("zsh"))]), &prev);
        assert_eq!(hints, vec![hint(2, "zsh")]);
        assert_eq!(next, names(&[(2, "zsh")]));
    }

    #[test]
    fn poll_tick_unresolved_name_carries_the_previous_one_silently() {
        // A transient resolution failure (`ps` hiccup, child mid-exit) must neither hint nor
        // forget the last known name — otherwise the recovered identical name would re-emit.
        let prev = names(&[(1, "vim")]);
        let (hints, next) = poll_tick(resolved(&[(1, None)]), &prev);
        assert!(hints.is_empty());
        assert_eq!(next, names(&[(1, "vim")]));
        // The recovered identical name stays silent on the following tick.
        let (hints2, next2) = poll_tick(resolved(&[(1, Some("vim"))]), &next);
        assert!(hints2.is_empty());
        assert_eq!(next2, next);
    }

    #[test]
    fn title_hint_serializes_camel_case_for_the_frontend() {
        // The frontend destructures `sessionId`/`name` from the `session:title-hint` payload
        // (trmx-75) — pin the wire shape like SessionInfo/PtyExited above.
        let value = serde_json::to_value(hint(3, "vim")).expect("TitleHint serializes");
        assert_eq!(value, serde_json::json!({ "sessionId": 3, "name": "vim" }));
    }

    #[test]
    fn parked_poller_gate_wakes_on_session_open_within_a_deadline() {
        // Real-thread park/wake (the platform-test discipline, bounded waits only): a thread
        // blocks in wait_while_empty, the test notifies, and the wake must land within 2 s.
        let gate = Arc::new(PollerGate::default());
        let waiter_gate = Arc::clone(&gate);
        let (woke_tx, woke_rx) = mpsc::channel::<()>();
        let waiter = std::thread::spawn(move || {
            waiter_gate.wait_while_empty();
            let _ = woke_tx.send(());
        });
        // Give the waiter a moment to actually park; the latch check below makes a missed wake
        // impossible either way (notify sets the latch BEFORE waking).
        std::thread::sleep(Duration::from_millis(100));
        gate.notify_session_opened();
        woke_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("the parked poller must wake on notify_session_opened");
        waiter.join().expect("the waiter thread exits");
    }

    #[test]
    fn poller_gate_wake_is_consumed_so_the_next_wait_parks_again() {
        // A notify BEFORE the wait makes it a pass-through (no missed wake between the poller's
        // empty snapshot and its park)...
        let gate = PollerGate::default();
        gate.notify_session_opened();
        gate.wait_while_empty();
        // ...and returning consumes the latch, re-arming the park for the next empty world.
        assert!(
            !*gate.has_sessions.lock().expect("gate lock"),
            "wait_while_empty must consume the wake latch"
        );
    }

    // --- trmx-78: the --perf mode's pure pieces ------------------------------------------------

    fn perf(args_v: &[&str], perf_env: Option<&str>, out_env: Option<&str>) -> PerfMode {
        perf_mode(
            args(args_v),
            perf_env.map(str::to_string),
            out_env.map(str::to_string),
        )
    }

    #[test]
    fn perf_mode_resolves_off_on_and_missing_dir() {
        let out = "/tmp/termixion-perf";

        // Enabled (arg or env) WITH an output dir → On(dir).
        assert!(matches!(perf(&["app", "--perf"], None, Some(out)), PerfMode::On(d) if d == out));
        assert!(matches!(perf(&["app"], Some("1"), Some(out)), PerfMode::On(d) if d == out));
        assert!(matches!(perf(&["app"], Some("true"), Some(out)), PerfMode::On(d) if d == out));

        // Not enabled → Off, even with the dir set.
        assert!(matches!(perf(&["app"], None, Some(out)), PerfMode::Off));

        // Enabled but TERMIXION_PERF_OUT missing/empty → MissingDir (fail fast, never launch normally).
        assert!(matches!(
            perf(&["app", "--perf"], None, None),
            PerfMode::MissingDir
        ));
        assert!(matches!(
            perf(&["app", "--perf"], None, Some("")),
            PerfMode::MissingDir
        ));
    }

    #[test]
    fn launch_modes_gives_smoke_precedence_and_fails_fast_on_missing_dirs() {
        let dir = "/tmp/x".to_string();
        // Smoke wins when both are requested (never expected, but pinned): perf is dropped.
        let both = launch_modes(SmokeMode::On(dir.clone()), PerfMode::On(dir.clone()));
        assert_eq!(both, Ok((Some(dir.clone()), None)));
        // Perf alone rides through; either MissingDir is a hard error.
        assert_eq!(
            launch_modes(SmokeMode::Off, PerfMode::On(dir.clone())),
            Ok((None, Some(dir.clone())))
        );
        assert_eq!(
            launch_modes(SmokeMode::Off, PerfMode::Off),
            Ok((None, None))
        );
        assert!(launch_modes(SmokeMode::MissingDir, PerfMode::Off).is_err());
        assert!(launch_modes(SmokeMode::Off, PerfMode::MissingDir).is_err());
    }

    #[test]
    fn perf_config_serializes_camel_case_for_the_frontend() {
        // The frontend destructures `outDir`/`build` — pin the wire shape like SessionInfo above.
        let value = serde_json::to_value(PerfConfig {
            out_dir: "/tmp/perf".to_string(),
            build: "release",
        })
        .expect("PerfConfig serializes");
        assert_eq!(
            value,
            serde_json::json!({ "outDir": "/tmp/perf", "build": "release" })
        );
    }

    #[test]
    fn session_spec_for_selects_the_rc_free_shell_for_smoke_or_perf() {
        // Production: login shell, cwd honored.
        let prod = session_spec_for(false, false, Some("/tmp/somewhere".to_string()));
        assert_eq!(prod.cwd, Some(PathBuf::from("/tmp/somewhere")));
        assert!(prod.args.is_empty(), "login shell spawns with no args");

        // Smoke or perf (or both): deterministic rc-free `zsh -f`, cwd deliberately ignored so
        // rc/prompt noise and a surprising working dir can never pollute the driven sequence.
        for (smoke, perf) in [(true, false), (false, true), (true, true)] {
            let spec = session_spec_for(smoke, perf, Some("/tmp/ignored".to_string()));
            assert_eq!(spec.program, OsStr::new("/bin/zsh"));
            assert_eq!(spec.args, vec![std::ffi::OsString::from("-f")]);
            assert_eq!(spec.cwd, None, "rc-free mode ignores cwd");
        }
    }

    #[test]
    fn perf_watchdog_outlasts_the_scenario_schedule() {
        // Derivation (app/src/perf/runPerf.ts consts): typing 1000 keys × 50 ms ≈ 50 s, readiness
        // + warmup ≈ 5 s, seq-scroll ≈ 30 s, yes-scroll 5 s, paging 40 × 100 ms = 4 s, settles ≈
        // 10 s → ≈ 105 s end-to-end. 300 s ≈ 3× headroom without masking a genuine hang.
        // ≈105 s schedule × ~3 headroom = the 300 s pinned here; change the consts together.
        assert_eq!(PERF_WATCHDOG_SECS, 300);
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
    fn sender_end_releases_a_producer_blocked_on_the_full_queue() {
        // (i) a pump blocked on a full bounded hand-off must unblock with SendError once the
        // sender ends (receiver dropped) — otherwise a dead webview would wedge the pump thread.
        let (tx, rx) = sync_channel::<Vec<u8>>(1);
        tx.send(b"fill".to_vec()).expect("queue");
        let producer = std::thread::spawn(move || tx.send(b"blocked".to_vec()));
        std::thread::sleep(Duration::from_millis(50)); // let the producer park on the full queue
        run_batch_sender(rx, 1024, |_| false, || {});
        let result = producer.join().expect("producer thread");
        assert!(
            result.is_err(),
            "the blocked send must resolve to SendError after the receiver drops"
        );
    }

    #[test]
    fn smoke_mode_resolves_off_on_and_missing_dir() {
        let on = "/tmp/termixion-smoke";

        // Enabled (arg or env) WITH DIR → On(dir).
        assert!(matches!(mode(&["app", "--smoke"], None, Some(on)), SmokeMode::On(d) if d == on));
        assert!(matches!(mode(&["app"], Some("1"), Some(on)), SmokeMode::On(d) if d == on));

        // Not enabled → Off, even with DIR set.
        assert!(matches!(mode(&["app"], None, Some(on)), SmokeMode::Off));

        // Enabled but DIR missing/empty → MissingDir (the gate fails fast, never launches normally).
        assert!(matches!(
            mode(&["app", "--smoke"], None, None),
            SmokeMode::MissingDir
        ));
        assert!(matches!(
            mode(&["app", "--smoke"], None, Some("")),
            SmokeMode::MissingDir
        ));
    }
}
