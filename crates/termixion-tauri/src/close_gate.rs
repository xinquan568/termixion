// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-243 (grill H5): the close / quit gate, extracted verbatim from `main.rs`.
//!
//! Every way this app can be asked to go away — the window's red button, the app menu's Quit, an
//! updater restart, a `RunEvent::ExitRequested` — funnels through here. [`close_decision`] is the
//! pure six-rule decision, [`AskTracker`] the generation-stamped record of an in-flight "really
//! quit?" ask (with the trmx-268 grace deadline behind it), and [`teardown_once`] the
//! run-exactly-once teardown that kills the PTY children and joins the control socket however many
//! close paths race.
//!
//! Two process globals live here because the gate is process-wide: [`QUIT_AUTHORIZED`] (the webview
//! has confirmed, so the next `CloseRequested` passes through) and `MAIN_TEARDOWN_DONE` (the
//! teardown latch). `main()` reads and stores the former from its window-event and `RunEvent`
//! wiring; the latter is private to this module.
//!
//! Extracted as part of trmx-243 even though the issue's fix sketch kept it in `main.rs`: the
//! acceptance criterion is a non-test `main.rs` under 500 lines, and the three-way split the sketch
//! prescribes leaves 791. See the PR body.

use std::time::{Duration, Instant};

use tauri::{Emitter, Manager};

use crate::pty_io::PtyState;
use crate::{control, window_manager};

/// trmx-144: set once the webview confirms a quit (or a pre-authorized close chain reaches the
/// window) — the next `CloseRequested` on the main window is then torn down and allowed through
/// instead of being vetoed-and-asked.
pub(crate) static QUIT_AUTHORIZED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
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
pub(crate) fn teardown_once(app: &tauri::AppHandle) {
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
pub(crate) enum CloseOrigin {
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
pub(crate) struct AskTracker {
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

pub(crate) static ASK: std::sync::LazyLock<std::sync::Mutex<AskTracker>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(AskTracker::default()));

/// trmx-268: how long an unacked ask may stand before the fallback fires.
pub(crate) const ASK_GRACE: Duration = Duration::from_secs(2);

/// trmx-268: which gate input a `RunEvent::ExitRequested` maps to. `None` = not gated here.
///
/// The two sources are NOT interchangeable. `Message::RequestExit(Some(code))` arrives with the main
/// window alive and can be asked. The last-window-destroyed path emits `code: None` *after*
/// tauri-runtime-wry has already removed the window, so there is no PTY-owning webview to receive an
/// ask — and an emit to nobody does not fail, so vetoing would strand a windowless process.
pub(crate) fn exit_gate_input(code: Option<i32>, main_window_alive: bool) -> Option<bool> {
    match code {
        Some(c) if c == tauri::RESTART_EXIT_CODE => None, // trmx-267 owns the updater restart
        None => Some(false),                              // nobody left to ask
        Some(_) => Some(main_window_alive),
    }
}

/// trmx-268: what the caller must do after the gate ran.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub(crate) enum Outcome {
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
pub(crate) fn ask_and_apply<E>(
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
pub(crate) enum ExitAction {
    /// An updater restart (`RESTART_EXIT_CODE`): reap, then let it proceed. `prevent_exit()` is a
    /// documented no-op for this code, so there is nothing to gate here.
    TeardownAndProceed,
    /// Any other exit code: leave it to the window close gate. trmx-268 owns user-initiated quit
    /// consent, and tearing down here would kill busy shells before its dialog could run.
    LeaveToCloseGate,
}

pub(crate) fn exit_action(code: Option<i32>) -> ExitAction {
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
pub(crate) fn quit_confirmed(window: tauri::WebviewWindow) {
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
pub(crate) fn webview_close_request(window: tauri::WebviewWindow) {
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
pub(crate) fn close_acknowledged(window: tauri::WebviewWindow, generation: u64) {
    if !window_manager::disposes_pty_for(window.label()) {
        return;
    }
    ASK.lock()
        .unwrap_or_else(|e| e.into_inner())
        .acknowledge(generation);
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
}
