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

use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager, WindowEvent};

mod config_io;
mod control;
mod control_io;
mod enhancements_io;
mod fs_watch;
mod launch;
mod logging;
mod menu;
mod poller;
mod pty_io;
mod scripts_io;
mod services_io;
mod shell_integration_io;
mod shells_io;
mod themes_io;
mod window_manager;

use poller::run_title_poller;
use pty_io::{PtyState, close_pty, open_pty, pty_ack, pty_resize, pty_write, set_session_title};

use launch::{
    CliQuery, PERF_WATCHDOG_SECS, SMOKE_WATCHDOG_SECS, SpecialLaunch, cli_query, launch_modes,
    perf_config, perf_done, perf_mode, perf_scenario, smoke_config, smoke_done, smoke_mode, usage,
    version_line,
};

/// Placeholder command exercising the frontend↔backend channel: reports the core version.
#[tauri::command]
fn core_version() -> String {
    termixion_platform::CORE_VERSION.to_string()
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
}
