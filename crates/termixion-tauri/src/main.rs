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
//! trmx-80 (FR-13) adds the `config_io` module: the `termixion.toml` read/write/reset commands and
//! the debounced config-file watcher that live-applies external edits as `settings:changed`.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use tauri::ipc::Channel;
use tauri::{Emitter, Manager, State, WindowEvent};
use termixion_core::{PtySize, SessionRegistry, SessionSpec};
use termixion_platform::{
    ForegroundProcess, PlatformPtyFactory, foreground_args, foreground_process,
    foreground_stdin_is_tty, is_busy,
};

mod config_io;
mod control;
mod control_io;
mod menu;
mod scripts_io;
mod shell_integration_io;
mod themes_io;
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
    /// Per-session flow-control cells (trmx-78 round 2b): registered at open_pty, consumed by the
    /// batch sender, refilled by pty_ack, removed at reap. An ack for a dead session is inert.
    credits: Arc<Mutex<HashMap<u64, Arc<CreditCell>>>>,
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

/// trmx-91: which detection source produced a session's activity state. `Poll` is the FR-7a
/// process-group method (this crate's poller). FR-7b (`v0.0.9`) adds `Osc133` and flips the source
/// per-session when shell integration is present — the emission/UI stack stays identical, so the
/// takeover is a source swap here, nothing downstream.
#[allow(dead_code)] // Osc133 is the documented FR-7b seam, not yet produced.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ActivitySource {
    Poll,
    Osc133,
}

/// Payload of the `session:activity` event (trmx-91, FR-7a): the poller observed that session
/// `session_id` is now `busy` (a command is running — its foreground process-group leader is not the
/// shell) or idle again. Change-only (emitted on a flip, not every tick). camelCase for the frontend.
///
/// trmx-159: a busy `false→true` RISE additionally carries the foreground leader's classification
/// metadata — its `name`, its argv tail (`args`), and whether its stdin is a tty — so the frontend's
/// interactive-aware activity light is born classified with no ordering window. Each field is
/// independently optional (omitted on resolution failure) and, being `None` on every non-rise event,
/// serializes away — a steady/idle event stays exactly `{ sessionId, busy }`.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionActivity {
    session_id: u64,
    busy: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    foreground_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    foreground_args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    foreground_stdin_tty: Option<bool>,
}

impl SessionActivity {
    /// A bare change event (no classification metadata) — every non-rise event, and the base a rise
    /// event is enriched from ([`enrich_rises`]).
    fn bare(session_id: u64, busy: bool) -> Self {
        Self {
            session_id,
            busy,
            foreground_name: None,
            foreground_args: None,
            foreground_stdin_tty: None,
        }
    }
}

/// trmx-159: the foreground-metadata resolver the poller injects, so the rise-enrichment logic
/// ([`enrich_rises`]) is unit-testable with a fake that records which pids it was asked about — the
/// load-bearing check being that argv/stdin are resolved on the foreground LEADER pid, never the shell.
trait ForegroundResolver {
    /// The foreground process-group leader on the shell's terminal (leader pid + name), or `None`.
    fn foreground(&self, shell_pid: u32) -> Option<ForegroundProcess>;
    /// The argv tail of `pid` (the LEADER, not the shell), or `None`.
    fn args(&self, pid: u32) -> Option<Vec<String>>;
    /// Whether `pid`'s (the LEADER's) stdin is a tty, or `None`.
    fn stdin_tty(&self, pid: u32) -> Option<bool>;
}

/// The production resolver: the real `termixion-platform` foreground helpers.
struct RealForeground;

impl ForegroundResolver for RealForeground {
    fn foreground(&self, shell_pid: u32) -> Option<ForegroundProcess> {
        foreground_process(shell_pid)
    }
    fn args(&self, pid: u32) -> Option<Vec<String>> {
        foreground_args(pid)
    }
    fn stdin_tty(&self, pid: u32) -> Option<bool> {
        foreground_stdin_is_tty(pid)
    }
}

/// trmx-159: the session ids that went busy `false→true` this tick (a new-or-flipped-to-true state) —
/// the RISES that need classification metadata. A steady `true`, a `true→false` fall, and an unchanged
/// `false` are NOT rises. Pure (the [`activity_tick`] shape), so it is unit-tested on canned snapshots.
fn rises_of(resolved: &[(u64, Option<bool>)], prev: &HashMap<u64, bool>) -> Vec<u64> {
    resolved
        .iter()
        .filter(|(id, busy)| *busy == Some(true) && prev.get(id) != Some(&true))
        .map(|(id, _)| *id)
        .collect()
}

/// trmx-159: attach classification metadata to the RISE events, resolving it on the foreground LEADER
/// pid (finding #1 — never the shell pid), and reset each rise session's title-diff memory so the next
/// steady-state title tick re-emits the name even if unchanged (the 1 Hz recovery attempt). Only rise
/// events are touched (finding #2 — a fall / steady event never invokes the resolver). Pure given the
/// injected `resolver`; the real impl's subprocess/syscall edge stays out here in the loop.
fn enrich_rises<R: ForegroundResolver>(
    mut events: Vec<SessionActivity>,
    rises: &[u64],
    shell_pids: &HashMap<u64, u32>,
    prev_titles: &mut HashMap<u64, String>,
    resolver: &R,
) -> Vec<SessionActivity> {
    for event in &mut events {
        if !rises.contains(&event.session_id) {
            continue;
        }
        if let Some(&shell_pid) = shell_pids.get(&event.session_id)
            && let Some(fg) = resolver.foreground(shell_pid)
        {
            // finding #1: argv + stdin are the LEADER's (`fg.pid`), not the shell's (`shell_pid`).
            event.foreground_args = resolver.args(fg.pid);
            event.foreground_stdin_tty = resolver.stdin_tty(fg.pid);
            event.foreground_name = Some(fg.name);
        }
        prev_titles.remove(&event.session_id);
    }
    events
}

/// Whether this poller tick resolves foreground titles: every 4th 250 ms tick (~1 Hz, unchanged from
/// trmx-75). Pure so the cadence is a pinned test (trmx-159 kept it exactly as-is).
fn resolves_titles(tick: u64) -> bool {
    tick.is_multiple_of(4)
}

/// One activity tick's pure diff (trmx-91), the [`poll_tick`] shape for the boolean busy state:
/// `resolved` is `(id, Some(busy))` this tick (`None` = the busy check failed right now), `prev` the
/// last-emitted busy states. Returns the CHANGE-ONLY events (a new session, or a busy state that
/// differs from `prev`) plus the next carry map. A dead session (absent from `resolved`) drops out; an
/// unresolved `None` carries its previous value silently (a transient `ps` hiccup neither flips nor
/// re-emits the recovered identical state). Pure — the `is_busy`/subprocess edge stays in the loop.
fn activity_tick(
    resolved: Vec<(u64, Option<bool>)>,
    prev: &HashMap<u64, bool>,
) -> (Vec<SessionActivity>, HashMap<u64, bool>) {
    let mut events = Vec::new();
    let mut next = HashMap::new();
    for (session_id, busy) in resolved {
        match busy {
            Some(busy) => {
                if prev.get(&session_id) != Some(&busy) {
                    events.push(SessionActivity::bare(session_id, busy));
                }
                next.insert(session_id, busy);
            }
            None => {
                if let Some(kept) = prev.get(&session_id) {
                    next.insert(session_id, *kept);
                }
            }
        }
    }
    (events, next)
}

/// trmx-75 + trmx-91: the foreground poller loop, spawned once in `setup`. The base tick is now
/// **250 ms** so the FR-7a activity indicator flips near-instantly; **titles are resolved every 4th
/// tick** (unchanged 1 Hz). Each tick snapshots `(id, shell_pid)` under the registry lock and **drops
/// the lock before any `ps` call** (lock discipline — subprocess latency must never stall
/// `pty_write`); an empty snapshot clears BOTH carry maps (a reopened world starts fresh) and parks on
/// the [`PollerGate`] condvar until `open_pty` wakes it. Otherwise it computes `busy` per session via
/// [`is_busy`], diffs through the pure [`activity_tick`], and emits change-only `session:activity`
/// best-effort; on title ticks it also resolves names via [`foreground_process`] → [`poll_tick`] →
/// `session:title-hint`. It NEVER writes core titles — the frontend is the single writer.
fn run_title_poller(
    app: tauri::AppHandle,
    registry: Arc<Mutex<SessionRegistry>>,
    gate: Arc<PollerGate>,
) {
    let mut prev_titles: HashMap<u64, String> = HashMap::new();
    let mut prev_busy: HashMap<u64, bool> = HashMap::new();
    let mut tick: u64 = 0;
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
            prev_titles.clear();
            prev_busy.clear();
            tick = 0;
            gate.wait_while_empty();
            continue;
        }
        // trmx-91: activity every tick (250 ms) — busy = the foreground group leader is not the shell.
        let busy_now: Vec<(u64, Option<bool>)> = snapshot
            .iter()
            .map(|(id, pid)| (*id, pid.and_then(is_busy)))
            .collect();
        // trmx-159: the rises (false→true) need classification metadata; capture them + the shell pids
        // BEFORE activity_tick consumes busy_now, then enrich the rise events off the LEADER pid.
        let rises = rises_of(&busy_now, &prev_busy);
        let (activity, next_busy) = activity_tick(busy_now, &prev_busy);
        prev_busy = next_busy;
        let activity = if rises.is_empty() {
            activity
        } else {
            let shell_pids: HashMap<u64, u32> = snapshot
                .iter()
                .filter_map(|(id, pid)| pid.map(|p| (*id, p)))
                .collect();
            enrich_rises(
                activity,
                &rises,
                &shell_pids,
                &mut prev_titles,
                &RealForeground,
            )
        };
        for event in activity {
            let _ = app.emit("session:activity", event);
        }
        // trmx-75: titles every 4th tick (1 Hz, unchanged).
        if resolves_titles(tick) {
            let resolved: Vec<(u64, Option<String>)> = snapshot
                .into_iter()
                .map(|(id, pid)| {
                    (
                        id,
                        pid.and_then(|pid| foreground_process(pid).map(|fg| fg.name)),
                    )
                })
                .collect();
            let (hints, next_titles) = poll_tick(resolved, &prev_titles);
            prev_titles = next_titles;
            for hint in hints {
                let _ = app.emit("session:title-hint", hint);
            }
        }
        tick = tick.wrapping_add(1);
        std::thread::sleep(Duration::from_millis(250));
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

fn session_spec_for(smoke: bool, perf: bool, cwd: Option<String>) -> SessionSpec {
    if smoke || perf {
        let (program, args) = smoke_shell(|p| std::path::Path::new(p).exists());
        let mut s = SessionSpec::shell(program);
        for a in args {
            s.args.push((*a).into());
        }
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

/// Outcome of a floored consume: did the caller get permission to send?
#[derive(Clone, Copy, Debug, PartialEq)]
enum ConsumeOutcome {
    /// Credits available, or a timeout probe above the floor — send.
    Proceed,
    /// Parked at the floor and released by a refill — re-evaluate (credits deducted).
    Refilled,
}

impl ConsumeOutcome {
    #[cfg(test)]
    fn proceeded(self) -> bool {
        matches!(self, ConsumeOutcome::Proceed | ConsumeOutcome::Refilled)
    }
}

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
    fn consume_floored(&self, bytes: i64, slice: Duration, floor: i64) -> ConsumeOutcome {
        loop {
            let Ok(guard) = self.credits.lock() else {
                return ConsumeOutcome::Proceed; // poisoned peer: degrade to unthrottled
            };
            let Ok((mut guard, timeout)) =
                self.refilled
                    .wait_timeout_while(guard, slice, |credits| *credits <= 0)
            else {
                return ConsumeOutcome::Proceed;
            };
            if !timeout.timed_out() {
                *guard -= bytes;
                return ConsumeOutcome::Refilled;
            }
            if *guard > floor {
                *guard -= bytes;
                return ConsumeOutcome::Proceed; // probe: overdraw stays floor-bounded
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
        .spawn(&PlatformPtyFactory, &spec, PtySize::new(rows, cols))
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
                let _ = cell.consume_floored(batch.len() as i64, PTY_CREDIT_WAIT, PTY_CREDIT_FLOOR);
                channel.send(batch).is_ok()
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

/// The special-launch state (C-3 smoke / trmx-78 perf): at most one is set (launch_modes gives
/// smoke precedence). One managed struct so `open_pty` reads a single State.
struct SpecialLaunch {
    smoke: Option<String>,
    perf: Option<String>,
    /// trmx-103: which perf scenario the webview should drive (`single`|`multipane`); irrelevant
    /// unless `perf` is set. Resolved once at launch from the args/env by [`perf_scenario`].
    perf_scenario: &'static str,
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

/// Resolve which perf scenario to drive (trmx-103): `--scenario multipane` (or `--scenario=…`) OR
/// `TERMIXION_PERF_SCENARIO=multipane` selects the v0.0.9 multi-pane load; anything else — including
/// absent — is the default single-pane run. Pure, for testing (the same discipline as `perf_mode`).
fn perf_scenario<I: IntoIterator<Item = String>>(
    args: I,
    scenario_env: Option<String>,
) -> &'static str {
    let mut selected: Option<String> = None;
    let mut expect_value = false;
    for a in args {
        if expect_value {
            selected = Some(a);
            expect_value = false;
        } else if a == "--scenario" {
            expect_value = true;
        } else if let Some(v) = a.strip_prefix("--scenario=") {
            selected = Some(v.to_string());
        }
    }
    match selected.or(scenario_env).as_deref() {
        Some("multipane") => "multipane",
        _ => "single",
    }
}

/// trmx-146: a terminal CLI query resolved from argv — answered BEFORE the Tauri builder runs.
#[derive(Debug, PartialEq)]
enum CliQuery {
    /// No query — proceed to a normal (or smoke/perf) launch.
    None,
    /// `--version` / `-V`: print [`version_line`] and exit 0.
    Version,
    /// `--help` / `-h`: print [`usage`] and exit 0.
    Help,
    /// An unrecognized `--flag`: print [`usage`] to stderr and exit 2 — a typo'd query
    /// (`--verison`) must never silently launch a GUI (the same fail-fast discipline as
    /// [`launch_modes`]'s MissingDir).
    UnknownFlag(String),
}

/// Resolve the launcher CLI query. Precedence (pinned by tests): Help > Version > UnknownFlag >
/// None — help/version are terminal queries and win over both the known launch flags and any
/// unknown token; the first unknown `--flag` is the one reported. Tolerated unconditionally:
/// every non-`--` token (legacy LaunchServices `-psn_<n>`, bare paths, `--scenario`'s value) and
/// single-dash tokens other than the exact `-V`/`-h`, so a Finder/`open` launch can never be
/// rejected. The `ctl` subcommand is forked off in `main()` BEFORE this runs (trmx-101 keeps
/// precedence); pure, for testing (the `smoke_mode`/`perf_mode` discipline).
fn cli_query<I: IntoIterator<Item = String>>(args: I) -> CliQuery {
    const KNOWN_FLAGS: [&str; 3] = ["--smoke", "--perf", "--scenario"];
    let mut help = false;
    let mut version = false;
    let mut unknown: Option<String> = None;
    for a in args {
        match a.as_str() {
            "--help" | "-h" => help = true,
            "--version" | "-V" => version = true,
            s if s.starts_with("--") => {
                let name = s.split('=').next().unwrap_or(s);
                if !KNOWN_FLAGS.contains(&name) && unknown.is_none() {
                    unknown = Some(s.to_string());
                }
            }
            _ => {} // non-`--` tokens are never ours to reject
        }
    }
    if help {
        CliQuery::Help
    } else if version {
        CliQuery::Version
    } else if let Some(flag) = unknown {
        CliQuery::UnknownFlag(flag)
    } else {
        CliQuery::None
    }
}

/// The `--version` line: the binary's compile-time truth (workspace-inherited version).
fn version_line() -> String {
    format!("termixion {}", env!("CARGO_PKG_VERSION"))
}

/// The `--help` text. `ctl` is documented generically — `run_ctl` has no help path today, so
/// pointing at `ctl --help` would mislead (plan §4). The smoke/perf/scenario flags are CI-internal
/// contracts: documented so they are not mystery flags, flagged so nobody treats them as public.
fn usage() -> String {
    [
        version_line().as_str(),
        "",
        "USAGE:",
        "  termixion                       launch the app",
        "  termixion ctl <command>         send a command to a running instance's control socket",
        "  termixion --version | -V        print the version and exit",
        "  termixion --help | -h           print this help and exit",
        "",
        "internal (CI harness; require env vars, exit non-zero without them):",
        "  --smoke · --perf · --scenario <single|multipane>",
    ]
    .join("\n")
}

/// What `perf_config` returns to the webview (trmx-78): where to have the report written, which
/// build produced it (budgets are only recorded from `release`), and which scenario to drive
/// (trmx-103 — `single`|`multipane`). camelCase for the frontend.
#[derive(Clone, serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PerfConfig {
    out_dir: String,
    build: &'static str,
    scenario: &'static str,
}

/// The smoke watchdog (trmx-102): fail rather than hang if the webview never reports the sentinel. Bumped
/// from 30 s so a slow headless webkit2gtk boot on Linux CI is not killed mid-flight (the happy path is <5 s).
const SMOKE_WATCHDOG_SECS: u64 = 90;

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
        scenario: launch.perf_scenario,
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

/// trmx-144: set once the webview confirms a quit (or a pre-authorized close chain reaches the
/// window) — the next `CloseRequested` on the main window is then torn down and allowed through
/// instead of being vetoed-and-asked.
static QUIT_AUTHORIZED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// trmx-144: the main-window teardown must run exactly once however many close paths race.
static MAIN_TEARDOWN_DONE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// trmx-144: what a `CloseRequested` must do. Pure so the gate logic is unit-testable — the
/// webview owns the confirm decision (busy state + the `terminal.confirmClose` setting + the
/// dialog); this side only vetoes, asks, and lets a confirmed close through.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum CloseAction {
    /// Not the PTY-owning window (the settings webview) — never gated, never torn down here.
    Ignore,
    /// Main window, quit not yet confirmed — veto the close and ask the webview.
    PreventAndAsk,
    /// Confirmed — run the teardown (once) and let the window close.
    TeardownAndAllow,
}

fn close_action(is_pty_owner: bool, quit_authorized: bool) -> CloseAction {
    if !is_pty_owner {
        CloseAction::Ignore
    } else if quit_authorized {
        CloseAction::TeardownAndAllow
    } else {
        CloseAction::PreventAndAsk
    }
}

/// Latch: true exactly once — the caller that wins runs the teardown body.
fn begin_teardown(done: &std::sync::atomic::AtomicBool) -> bool {
    !done.swap(true, std::sync::atomic::Ordering::SeqCst)
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
            println!("{}", version_line());
            return ExitCode::SUCCESS;
        }
        CliQuery::Help => {
            println!("{}", usage());
            return ExitCode::SUCCESS;
        }
        CliQuery::UnknownFlag(flag) => {
            // Debug-format the flag: argv is attacker-adjacent input, and a raw echo could write
            // control bytes (ANSI/OSC) into the caller's terminal — {flag:?} escapes them.
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
        // trmx-145: the native pasteboard write — every frontend copy path (⌘C guard, auto-copy-on-
        // select, OSC 52) writes through this plugin's IPC, never the WKWebView pasteboard APIs
        // (whose writes reach other apps UTF-8-bytes-decoded-as-MacRoman: "—" pasted as "‚Äî").
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(PtyState::default())
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
        // trmx-101 (FR-9.4): the opt-in external control channel's socket-listener state. A --smoke/--perf
        // launch is deterministic → the control socket NEVER opens (baked into ControlState, so EVERY
        // apply path — initial load, config write/reset, the watcher — is forced off).
        .manage(control::ControlState::new(deterministic))
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
                        eprintln!("termixion: failed to open the settings window: {err}");
                    }
                }
                // trmx-74/94: the frontend owns tab/pane/window/settings state, so the menu broadcasts
                // the intent as a `tabs:action` event; App routes it through the command dispatch spine
                // (incl. window-close → window.close and app-settings → app.settings, trmx-94 finding 7).
                Some(menu::MenuAction::EmitTabsAction(action)) => {
                    if let Err(err) = app.emit("tabs:action", action) {
                        eprintln!("termixion: failed to emit tabs:action ({action}): {err}");
                    }
                }
                None => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            core_version,
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
            quit_confirmed
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
                match close_action(
                    window_manager::disposes_pty_for(window.label()),
                    QUIT_AUTHORIZED.load(std::sync::atomic::Ordering::SeqCst),
                ) {
                    CloseAction::Ignore => {}
                    CloseAction::PreventAndAsk => {
                        api.prevent_close();
                        let _ = window.emit_to(window.label(), "close:requested", ());
                    }
                    CloseAction::TeardownAndAllow => {
                        if begin_teardown(&MAIN_TEARDOWN_DONE) {
                            if let Some(state) = window.try_state::<PtyState>()
                                && let Ok(mut registry) = state.registry.lock()
                            {
                                registry.kill_all();
                            }
                            // trmx-101 (FR-9.4): tear down the control socket (acceptor + unlink).
                            if let Some(control_state) = window.try_state::<control::ControlState>()
                            {
                                control::shutdown(&control_state);
                            }
                            if let Some(settings) = window
                                .app_handle()
                                .get_webview_window(window_manager::SETTINGS_WINDOW_LABEL)
                            {
                                let _ = settings.close();
                            }
                        }
                    }
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

    /// trmx-146: argv → CliQuery, as a plain Vec<String> (same convention as the smoke/perf tests).
    fn q(args: &[&str]) -> CliQuery {
        cli_query(args.iter().map(|s| (*s).to_string()))
    }

    #[test]
    fn cli_query_recognizes_version_and_help_in_both_spellings() {
        assert_eq!(q(&["--version"]), CliQuery::Version);
        assert_eq!(q(&["-V"]), CliQuery::Version);
        assert_eq!(q(&["--help"]), CliQuery::Help);
        assert_eq!(q(&["-h"]), CliQuery::Help);
    }

    #[test]
    fn cli_query_precedence_is_help_over_version_over_unknown() {
        // trmx-146 (plan §2): Help > Version > UnknownFlag > None — a caller who asked an
        // answerable question gets the answer; version/help are terminal queries and beat both
        // the known launch flags and any unknown token.
        assert_eq!(q(&["--version", "--help"]), CliQuery::Help);
        assert_eq!(q(&["--help", "--version"]), CliQuery::Help);
        assert_eq!(q(&["--smoke", "--version"]), CliQuery::Version);
        assert_eq!(q(&["--help", "--bogus"]), CliQuery::Help);
        assert_eq!(q(&["--bogus", "--help"]), CliQuery::Help);
        assert_eq!(q(&["--version", "--bogus"]), CliQuery::Version);
    }

    #[test]
    fn cli_query_rejects_the_first_unknown_double_dash_flag() {
        assert_eq!(q(&["--bogus"]), CliQuery::UnknownFlag("--bogus".into()));
        // First offender reported when several are present.
        assert_eq!(
            q(&["--bogus", "--other"]),
            CliQuery::UnknownFlag("--bogus".into())
        );
        // A typo'd query must NOT silently launch a GUI (the trmx-146 bug in a hat).
        assert_eq!(q(&["--verison"]), CliQuery::UnknownFlag("--verison".into()));
    }

    #[test]
    fn cli_query_tolerates_known_flags_platform_args_and_plain_tokens() {
        // The CI-internal launch flags stay recognized (value and `=` forms of --scenario).
        assert_eq!(q(&["--smoke"]), CliQuery::None);
        assert_eq!(q(&["--perf"]), CliQuery::None);
        assert_eq!(q(&["--scenario", "multipane"]), CliQuery::None);
        assert_eq!(q(&["--scenario=multipane"]), CliQuery::None);
        // Platform-injected argv must never be rejected: legacy LaunchServices -psn_<n>,
        // bare paths, and single-dash tokens other than the exact -V/-h.
        assert_eq!(q(&["-psn_0_12345"]), CliQuery::None);
        assert_eq!(q(&["some/path"]), CliQuery::None);
        assert_eq!(q(&["-x"]), CliQuery::None);
        assert_eq!(q(&[]), CliQuery::None);
    }

    #[test]
    fn version_line_carries_the_compiled_crate_version() {
        let line = version_line();
        assert!(line.starts_with("termixion "), "got: {line}");
        assert!(line.contains(env!("CARGO_PKG_VERSION")), "got: {line}");
    }

    #[test]
    fn usage_documents_the_public_surface_and_flags_the_internal_one() {
        let text = usage();
        for needle in [
            "termixion",
            "ctl <command>",
            "--version",
            "--help",
            "internal",
        ] {
            assert!(text.contains(needle), "usage() must mention {needle:?}");
        }
        // trmx-146 (plan §4): run_ctl has no help path — usage must not advertise one.
        assert!(
            !text.contains("ctl --help"),
            "usage() must not point at nonexistent ctl --help"
        );
        for internal in ["--smoke", "--perf", "--scenario"] {
            assert!(
                text.contains(internal),
                "internal flag {internal:?} documented-but-flagged"
            );
        }
    }

    #[test]
    fn close_action_gates_only_the_unauthorized_pty_owner() {
        // trmx-144: the settings window is never gated (Ignore either way); the main window is
        // vetoed-and-asked until the webview confirms the quit, then torn down and allowed.
        assert_eq!(close_action(false, false), CloseAction::Ignore);
        assert_eq!(close_action(false, true), CloseAction::Ignore);
        assert_eq!(close_action(true, false), CloseAction::PreventAndAsk);
        assert_eq!(close_action(true, true), CloseAction::TeardownAndAllow);
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

    // --- trmx-91: the activity-tick pure diff (the poll_tick shape for busy state) ---------------

    /// Build a prev/next busy carry map from `(id, busy)` pairs.
    fn busy_map(entries: &[(u64, bool)]) -> HashMap<u64, bool> {
        entries.iter().copied().collect()
    }

    /// Build a resolved busy snapshot (`id` → `Some(busy)`, or `None` when the check failed).
    fn busy_resolved(entries: &[(u64, Option<bool>)]) -> Vec<(u64, Option<bool>)> {
        entries.to_vec()
    }

    fn activity(session_id: u64, busy: bool) -> SessionActivity {
        SessionActivity::bare(session_id, busy)
    }

    // --- trmx-159: rise detection + metadata enrichment (findings #1/#2) + cadence ---------------

    use std::cell::RefCell;

    /// A fake resolver that records which pids it was asked about, so a test can prove argv/stdin were
    /// resolved on the foreground LEADER pid (not the shell pid) and that non-rises never invoke it.
    struct FakeForeground {
        leader: u32,
        name: String,
        foreground_calls: RefCell<Vec<u32>>,
        args_calls: RefCell<Vec<u32>>,
        stdin_calls: RefCell<Vec<u32>>,
    }

    impl FakeForeground {
        fn new(leader: u32, name: &str) -> Self {
            Self {
                leader,
                name: name.to_string(),
                foreground_calls: RefCell::new(Vec::new()),
                args_calls: RefCell::new(Vec::new()),
                stdin_calls: RefCell::new(Vec::new()),
            }
        }
    }

    impl ForegroundResolver for FakeForeground {
        fn foreground(&self, shell_pid: u32) -> Option<ForegroundProcess> {
            self.foreground_calls.borrow_mut().push(shell_pid);
            Some(ForegroundProcess {
                pid: self.leader,
                name: self.name.clone(),
            })
        }
        fn args(&self, pid: u32) -> Option<Vec<String>> {
            self.args_calls.borrow_mut().push(pid);
            Some(vec!["-p".to_string(), "hi".to_string()])
        }
        fn stdin_tty(&self, pid: u32) -> Option<bool> {
            self.stdin_calls.borrow_mut().push(pid);
            Some(true)
        }
    }

    #[test]
    fn rises_of_reports_only_false_to_true_transitions() {
        let prev = busy_map(&[(2, false), (3, true)]);
        // 1 new-busy (rise), 2 false→true (rise), 3 steady-true (NOT), 4 true→false (NOT), 5 new-idle (NOT).
        let mut rises = rises_of(
            &busy_resolved(&[
                (1, Some(true)),
                (2, Some(true)),
                (3, Some(true)),
                (4, Some(false)),
                (5, Some(false)),
            ]),
            &prev,
        );
        rises.sort_unstable();
        assert_eq!(rises, vec![1, 2]);
    }

    #[test]
    fn enrich_rises_resolves_metadata_on_the_leader_pid_not_the_shell() {
        // finding #1: the poller snapshot carries the SHELL pid (100); the classification metadata must
        // be resolved on the foreground LEADER pid (9999) that foreground_process(shell_pid) returns.
        let fake = FakeForeground::new(9999, "claude");
        let mut prev_titles = HashMap::new();
        let shell_pids = HashMap::from([(1u64, 100u32)]);
        let enriched = enrich_rises(
            vec![SessionActivity::bare(1, true)],
            &[1],
            &shell_pids,
            &mut prev_titles,
            &fake,
        );
        assert_eq!(enriched[0].foreground_name, Some("claude".to_string()));
        assert_eq!(
            enriched[0].foreground_args,
            Some(vec!["-p".to_string(), "hi".to_string()])
        );
        assert_eq!(enriched[0].foreground_stdin_tty, Some(true));
        // foreground() was asked about the SHELL pid; args/stdin about the LEADER pid.
        assert_eq!(*fake.foreground_calls.borrow(), vec![100]);
        assert_eq!(*fake.args_calls.borrow(), vec![9999]);
        assert_eq!(*fake.stdin_calls.borrow(), vec![9999]);
    }

    #[test]
    fn enrich_rises_never_resolves_a_fall_or_a_steady_event() {
        // finding #2: no metadata resolution on true→false (a fall) or a non-rise — the resolver is
        // untouched, and the events pass through bare.
        let fake = FakeForeground::new(9999, "claude");
        let mut prev_titles = HashMap::new();
        let shell_pids = HashMap::from([(2u64, 200u32)]);
        let out = enrich_rises(
            vec![SessionActivity::bare(2, false)],
            &[], // no rises this tick
            &shell_pids,
            &mut prev_titles,
            &fake,
        );
        assert_eq!(out, vec![SessionActivity::bare(2, false)]);
        assert!(fake.foreground_calls.borrow().is_empty());
        assert!(fake.args_calls.borrow().is_empty());
        assert!(fake.stdin_calls.borrow().is_empty());
    }

    #[test]
    fn enrich_rises_resets_title_memory_so_the_next_tick_re_emits_an_unchanged_name() {
        // A rise clears the session's title-diff memory, so poll_tick re-hints the SAME name next tick
        // (the 1 Hz recovery attempt) — otherwise an unchanged name would stay suppressed.
        let fake = FakeForeground::new(9999, "zsh");
        let mut prev_titles = HashMap::from([(1u64, "zsh".to_string())]);
        let shell_pids = HashMap::from([(1u64, 100u32)]);
        enrich_rises(
            vec![SessionActivity::bare(1, true)],
            &[1],
            &shell_pids,
            &mut prev_titles,
            &fake,
        );
        assert!(
            !prev_titles.contains_key(&1),
            "the rise cleared the title memory"
        );
        let (hints, _next) = poll_tick(vec![(1, Some("zsh".to_string()))], &prev_titles);
        assert_eq!(
            hints,
            vec![TitleHint {
                session_id: 1,
                name: "zsh".to_string(),
            }],
            "the unchanged name re-emits after the reset"
        );
    }

    #[test]
    fn resolves_titles_keeps_the_1hz_cadence_over_the_250ms_base_tick() {
        // trmx-159 must NOT change the title cadence: titles resolve on every 4th 250 ms tick.
        assert!(resolves_titles(0));
        assert!(resolves_titles(4));
        assert!(resolves_titles(8));
        assert!(!resolves_titles(1));
        assert!(!resolves_titles(2));
        assert!(!resolves_titles(3));
    }

    #[test]
    fn session_activity_serializes_rise_metadata_and_omits_it_when_bare() {
        // An enriched rise event carries camelCase metadata; a bare event stays exactly {sessionId,busy}.
        let enriched = SessionActivity {
            session_id: 7,
            busy: true,
            foreground_name: Some("claude".to_string()),
            foreground_args: Some(vec!["-p".to_string()]),
            foreground_stdin_tty: Some(true),
        };
        assert_eq!(
            serde_json::to_value(&enriched).expect("serializes"),
            serde_json::json!({
                "sessionId": 7,
                "busy": true,
                "foregroundName": "claude",
                "foregroundArgs": ["-p"],
                "foregroundStdinTty": true,
            })
        );
        assert_eq!(
            serde_json::to_value(SessionActivity::bare(7, false)).expect("serializes"),
            serde_json::json!({ "sessionId": 7, "busy": false }),
        );
    }

    #[test]
    fn activity_tick_emits_new_and_changed_states_and_keeps_unchanged_silent() {
        // Session 1 is new (busy), session 2 flipped idle→busy, session 3 is unchanged (busy) —
        // only 1 and 2 emit; next carries all three.
        let prev = busy_map(&[(2, false), (3, true)]);
        let (events, next) = activity_tick(
            busy_resolved(&[(1, Some(true)), (2, Some(true)), (3, Some(true))]),
            &prev,
        );
        assert_eq!(events, vec![activity(1, true), activity(2, true)]);
        assert_eq!(next, busy_map(&[(1, true), (2, true), (3, true)]));
    }

    #[test]
    fn activity_tick_all_unchanged_emits_nothing() {
        let prev = busy_map(&[(1, true), (2, false)]);
        let (events, next) =
            activity_tick(busy_resolved(&[(1, Some(true)), (2, Some(false))]), &prev);
        assert!(events.is_empty(), "unchanged busy states stay silent");
        assert_eq!(next, prev);
    }

    #[test]
    fn activity_tick_busy_to_idle_emits_the_flip() {
        let prev = busy_map(&[(1, true)]);
        let (events, next) = activity_tick(busy_resolved(&[(1, Some(false))]), &prev);
        assert_eq!(events, vec![activity(1, false)]);
        assert_eq!(next, busy_map(&[(1, false)]));
    }

    #[test]
    fn activity_tick_drops_dead_sessions_without_emitting() {
        // Session 1 closed between ticks: it vanishes from next and emits nothing.
        let prev = busy_map(&[(1, true), (2, false)]);
        let (events, next) = activity_tick(busy_resolved(&[(2, Some(false))]), &prev);
        assert!(events.is_empty());
        assert_eq!(next, busy_map(&[(2, false)]));
    }

    #[test]
    fn activity_tick_empty_snapshot_clears_the_carry_and_emits_nothing() {
        let prev = busy_map(&[(1, true)]);
        let (events, next) = activity_tick(Vec::new(), &prev);
        assert!(events.is_empty());
        assert!(next.is_empty());
    }

    #[test]
    fn activity_tick_unresolved_state_carries_the_previous_one_silently() {
        // A transient is_busy failure must neither flip nor forget the last known state.
        let prev = busy_map(&[(1, true)]);
        let (events, next) = activity_tick(busy_resolved(&[(1, None)]), &prev);
        assert!(events.is_empty());
        assert_eq!(next, busy_map(&[(1, true)]));
        // The recovered identical state stays silent on the following tick.
        let (events2, next2) = activity_tick(busy_resolved(&[(1, Some(true))]), &next);
        assert!(events2.is_empty());
        assert_eq!(next2, next);
    }

    #[test]
    fn session_activity_serializes_camel_case_for_the_frontend() {
        // The frontend destructures `sessionId`/`busy` from the `session:activity` payload (trmx-91).
        let value = serde_json::to_value(activity(7, true)).expect("SessionActivity serializes");
        assert_eq!(value, serde_json::json!({ "sessionId": 7, "busy": true }));
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
        // The frontend destructures `outDir`/`build`/`scenario` — pin the wire shape like SessionInfo.
        let value = serde_json::to_value(PerfConfig {
            out_dir: "/tmp/perf".to_string(),
            build: "release",
            scenario: "single",
        })
        .expect("PerfConfig serializes");
        assert_eq!(
            value,
            serde_json::json!({ "outDir": "/tmp/perf", "build": "release", "scenario": "single" })
        );
    }

    #[test]
    fn perf_scenario_resolves_single_and_multipane_from_arg_or_env() {
        // Default (nothing set) → single; the whole point is the existing path is unchanged.
        assert_eq!(perf_scenario(args(&["app", "--perf"]), None), "single");
        // Explicit multipane via arg (spaced or `=`) or env.
        assert_eq!(
            perf_scenario(args(&["app", "--perf", "--scenario", "multipane"]), None),
            "multipane"
        );
        assert_eq!(
            perf_scenario(args(&["app", "--scenario=multipane"]), None),
            "multipane"
        );
        assert_eq!(
            perf_scenario(args(&["app"]), Some("multipane".to_string())),
            "multipane"
        );
        // The arg wins over the env; an unknown value falls back to single (never a launch failure).
        assert_eq!(
            perf_scenario(
                args(&["app", "--scenario", "single"]),
                Some("multipane".to_string())
            ),
            "single"
        );
        assert_eq!(
            perf_scenario(args(&["app", "--scenario", "bogus"]), None),
            "single"
        );
        assert_eq!(
            perf_scenario(args(&["app"]), Some("single".to_string())),
            "single"
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
        assert!(
            cell.consume_floored(6, Duration::from_millis(500), -100)
                .proceeded()
        );
        assert!(
            cell.consume_floored(6, Duration::from_millis(500), -100)
                .proceeded(),
            "2 left: still positive, overdraws"
        );
        assert!(
            started.elapsed() < Duration::from_millis(100),
            "no parking while positive"
        );
        cell.refill(100);
        assert!(
            cell.consume_floored(50, Duration::from_millis(50), -100)
                .proceeded()
        );
    }

    #[test]
    fn credit_cell_zero_or_negative_parks_and_refill_unparks() {
        let cell = Arc::new(CreditCell::new(4));
        assert!(
            cell.consume_floored(4, Duration::from_millis(50), 0)
                .proceeded()
        ); // now 0 — parks
        let parked = Arc::clone(&cell);
        let (tx, rx) = mpsc::channel::<bool>();
        let waiter = std::thread::spawn(move || {
            // floor 0: at zero credits there is no probe headroom — a pure park-until-refill.
            let got = parked
                .consume_floored(2, Duration::from_millis(200), 0)
                .proceeded();
            tx.send(got).expect("send");
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
        assert!(
            cell.consume_floored(1, Duration::from_millis(10), -100)
                .proceeded()
        );
        let started = std::time::Instant::now();
        assert_eq!(
            cell.consume_floored(1, Duration::from_millis(60), -100),
            ConsumeOutcome::Proceed,
            "timeout above the floor is a probe"
        );
        assert!(started.elapsed() >= Duration::from_millis(55));
    }

    #[test]
    fn credit_overdraw_is_floor_bounded_probes_stop_at_the_floor() {
        // R2 step-8 F1: timeout-proceed must NOT allow unbounded overdraw against a channel that
        // queues forever without acks. Probes proceed only while credits stay above the floor;
        // at the floor the consumer parks (sliced, indefinitely) until a refill.
        let cell = Arc::new(CreditCell::new(4));
        // Drain into overdraw with timeout-probes: 4 -> 0 -> -4 (floor for this test = -4).
        assert!(
            cell.consume_floored(4, Duration::from_millis(10), -4)
                .proceeded()
        );
        assert!(
            cell.consume_floored(4, Duration::from_millis(10), -4)
                .proceeded()
        ); // probe: 0 > floor
        // credits now -4 == floor: further consumes must PARK, not proceed.
        let parked = Arc::clone(&cell);
        let (tx, rx) = mpsc::channel::<bool>();
        let waiter = std::thread::spawn(move || {
            let outcome = parked.consume_floored(4, Duration::from_millis(30), -4);
            tx.send(outcome.proceeded()).expect("send");
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
    fn sender_releases_the_blocked_producer_before_on_done_runs() {
        // R2 step-8 F2: rx must drop BEFORE the done guard fires so a producer blocked on the
        // full hand-off is already released when on_done (the reap) runs.
        let (tx, rx) = sync_channel::<Vec<u8>>(1);
        tx.send(b"fill".to_vec()).expect("queue");
        let (sig_tx, sig_rx) = mpsc::channel::<()>();
        let producer = std::thread::spawn(move || {
            let result = tx.send(b"blocked".to_vec());
            let _ = sig_tx.send(()); // signals release (send resolved, Err expected)
            result
        });
        std::thread::sleep(Duration::from_millis(50));
        run_batch_sender(
            rx,
            1024,
            Duration::from_millis(PTY_BATCH_WINDOW_MS),
            |_| false,
            move || {
                // The reap observes the producer ALREADY released (deterministic: bounded wait).
                sig_rx
                    .recv_timeout(Duration::from_secs(2))
                    .expect("producer must be released before on_done");
            },
        );
        assert!(producer.join().expect("producer").is_err());
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

    #[test]
    fn sender_end_releases_a_producer_blocked_on_the_full_queue() {
        // (i) a pump blocked on a full bounded hand-off must unblock with SendError once the
        // sender ends (receiver dropped) — otherwise a dead webview would wedge the pump thread.
        let (tx, rx) = sync_channel::<Vec<u8>>(1);
        tx.send(b"fill".to_vec()).expect("queue");
        let producer = std::thread::spawn(move || tx.send(b"blocked".to_vec()));
        std::thread::sleep(Duration::from_millis(50)); // let the producer park on the full queue
        run_batch_sender(
            rx,
            1024,
            Duration::from_millis(PTY_BATCH_WINDOW_MS),
            |_| false,
            || {},
        );
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
