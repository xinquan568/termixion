// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-243 (grill H5): the foreground title/activity poller, extracted verbatim from `main.rs`.
//!
//! One background thread (spawned once in `setup`) samples every live session's foreground process
//! on a 250 ms base tick, emitting change-only `session:activity` events and — every 4th tick, so
//! ~1 Hz — change-only `session:title-hint` events. [`PollerGate`] is the zero-session park: an
//! empty world costs zero wakeups until `open_pty` wakes it.
//!
//! The subprocess edge stays behind [`ForegroundResolver`] (production: [`RealForeground`]);
//! [`poll_iteration`] is one iteration's whole body over an injected resolver, and every diff it
//! computes is a pure function ([`poll_tick`], [`activity_tick`], [`rises_of`], [`enrich_rises`],
//! [`resolves_titles`], [`effective_title_name`]) unit-tested below on canned snapshots.
//!
//! trmx-263 (grill A3): the periodic passes are BULK — one `ps` per activity iteration (the
//! foreground leaders of every shell), two per title iteration (plus the names of the distinct
//! leaders) — five per four-tick cycle whatever the pane count, plus two forks per busy rise
//! (event-driven, unchanged). It was 6N per cycle when every session cost its own `ps` calls.

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use tauri::Emitter;
use termixion_core::SessionRegistry;
use termixion_platform::{
    ForegroundProcess, foreground_args, foreground_leaders, foreground_process,
    foreground_stdin_is_tty, is_interpreter, process_names, unwrap_interpreter_shim,
};

/// trmx-75: the zero-session park for the foreground-title poller — a REAL condvar block, not a
/// timed idle loop, so an empty world costs zero wakeups. `has_sessions` is a **wake latch**:
/// [`PollerGate::notify_session_opened`] sets it (then wakes), and the poller's
/// [`PollerGate::wait_while_empty`] blocks until it is set, consuming it on return. The
/// set-BEFORE-wake + consume-on-return protocol makes a missed wake impossible: a session opened
/// between the poller's empty snapshot and its park leaves the latch set, so the park is a
/// pass-through and the next snapshot sees the session. (The cost is at most one spurious
/// pass-through after a stale latch — the poller just re-reads an empty snapshot and parks.)
#[derive(Default)]
pub(crate) struct PollerGate {
    has_sessions: Mutex<bool>,
    wake: Condvar,
}

impl PollerGate {
    /// A session was spawned: set the latch, then wake a parked poller. Called by `open_pty`
    /// after a successful spawn (never on failure — nothing new to watch).
    pub(crate) fn notify_session_opened(&self) {
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
/// title writer; the poller only ever HINTS and never writes a title anywhere. camelCase for
/// the frontend.
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
///
/// trmx-263: plus the two BULK paths the periodic passes run on — [`Self::leaders`] (one `ps` for
/// every shell) and [`Self::names`] (one `ps` for the distinct leaders) — so [`poll_iteration`] is
/// unit-testable with a fake that COUNTS bulk calls. Both are required (no default): a resolver that
/// forgets them must fail to compile, never silently fall back to a per-pid loop.
trait ForegroundResolver {
    /// The foreground process-group leader on the shell's terminal (leader pid + name), or `None`.
    fn foreground(&self, shell_pid: u32) -> Option<ForegroundProcess>;
    /// The argv tail of `pid` (the LEADER, not the shell), or `None`.
    fn args(&self, pid: u32) -> Option<Vec<String>>;
    /// Whether `pid`'s (the LEADER's) stdin is a tty, or `None`.
    fn stdin_tty(&self, pid: u32) -> Option<bool>;
    /// trmx-263: the foreground group leader of MANY shells in one call — `Some(tpgid)` per shell a
    /// row came back for (`None` in the value = no controlling terminal / no foreground group), a
    /// gone shell absent; outer `None` only when the call itself failed. The busy pass's one call.
    fn leaders(&self, shell_pids: &[u32]) -> Option<HashMap<u32, Option<u32>>>;
    /// trmx-263: the display names of MANY pids in one call (same absence / outer-`None` rules).
    /// The title pass's one call, over the distinct leaders.
    fn names(&self, pids: &[u32]) -> Option<HashMap<u32, String>>;
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
    fn leaders(&self, shell_pids: &[u32]) -> Option<HashMap<u32, Option<u32>>> {
        foreground_leaders(shell_pids)
    }
    fn names(&self, pids: &[u32]) -> Option<HashMap<u32, String>> {
        process_names(pids)
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
            // trmx-197: an interpreter-shim leader (`node …/bin/codex`) is unwrapped to the CLI it
            // fronts — name from the script's basename, args from the script's own tail — so the
            // counter buckets it and the classifier sees the true invocation shape; a missing argv
            // degrades to the raw comm name (today's behavior).
            let (name, args) = match resolver.args(fg.pid) {
                Some(raw) => match unwrap_interpreter_shim(&fg.name, &raw) {
                    Some((unwrapped, rest)) => (unwrapped, Some(rest)),
                    None => (fg.name, Some(raw)),
                },
                None => (fg.name, None),
            };
            event.foreground_args = args;
            event.foreground_stdin_tty = resolver.stdin_tty(fg.pid);
            event.foreground_name = Some(name);
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

/// trmx-197: the DISPLAY name for a resolved foreground leader — the interpreter-shim unwrap
/// applied to the 1 Hz title path, so the hint agrees with the rise metadata. Load-bearing, not
/// cosmetic: the App's title-hint handler also CORRECTS the foreground counting slot, so a
/// disagreeing title would clobber the counter back to the interpreter within a second of a fixed
/// rise. Pure (name/argv in, name out); the argv fetch stays in the loop glue.
fn effective_title_name(fg: ForegroundProcess, args: Option<Vec<String>>) -> String {
    match args.and_then(|a| unwrap_interpreter_shim(&fg.name, &a)) {
        Some((name, _)) => name,
        None => fg.name,
    }
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

/// trmx-263: the pids of an iterator, sorted and de-duplicated — the request list of a bulk call
/// (one `ps -p a,b,c`), so two sessions on one leader ask for it once.
fn sorted_distinct(pids: impl Iterator<Item = u32>) -> Vec<u32> {
    let mut out: Vec<u32> = pids.collect();
    out.sort_unstable();
    out.dedup();
    out
}

/// trmx-263: what one poller iteration produced — the change-only activity events (every tick) and
/// the change-only title hints (title ticks only, else empty). [`run_title_poller`] emits them in
/// that order.
struct PollOutput {
    activity: Vec<SessionActivity>,
    hints: Vec<TitleHint>,
}

/// trmx-263: ONE poller iteration over `snapshot` (`(session_id, shell_pid)`), given the tick and
/// both carry maps — the whole body of [`run_title_poller`] minus the lock, the park and the emits,
/// so it is unit-testable with a counting fake.
///
/// The busy pass makes ONE bulk [`ForegroundResolver::leaders`] call over the sorted, de-duplicated
/// shell pids and evaluates `is_busy`'s truth table on the map: a row whose leader ≠ shell is busy,
/// a row whose leader == shell is idle; a row with no group, a shell with no row (gone), and a
/// failed call all resolve to `None` so [`activity_tick`] carries the previous state. Rises
/// (false→true) are enriched exactly as before — per rise, `foreground`/`args`/`stdin_tty` on the
/// LEADER pid ([`enrich_rises`]).
///
/// On a title tick ([`resolves_titles`]) the title pass reuses THIS iteration's leaders map: ONE bulk
/// [`ForegroundResolver::names`] call over the distinct leaders, then per session the shell's leader
/// → its name → (interpreters only, trmx-197) `args` on the LEADER → [`effective_title_name`] →
/// [`poll_tick`]. A leader is at most one iteration's few milliseconds staler than a separate
/// `ps -o tpgid=` fork was, and the two per-session forks were never atomic either.
fn poll_iteration<R: ForegroundResolver>(
    snapshot: &[(u64, Option<u32>)],
    tick: u64,
    prev_titles: &mut HashMap<u64, String>,
    prev_busy: &mut HashMap<u64, bool>,
    resolver: &R,
) -> PollOutput {
    // trmx-91 + trmx-263: activity every tick (250 ms) — busy = the foreground group leader is not
    // the shell — from ONE bulk call over every shell pid.
    let pids = sorted_distinct(snapshot.iter().filter_map(|(_, pid)| *pid));
    let leaders = resolver.leaders(&pids);
    let busy_now: Vec<(u64, Option<bool>)> = snapshot
        .iter()
        .map(|(id, pid)| {
            (
                *id,
                match (pid, &leaders) {
                    (Some(p), Some(map)) => match map.get(p) {
                        Some(Some(tpgid)) => Some(*tpgid != *p), // a row: busy iff leader ≠ shell
                        Some(None) => None,                      // a row, but no foreground group
                        None => None,                            // no row: gone → carry
                    },
                    _ => None, // no pid, or the call itself failed → carry
                },
            )
        })
        .collect();
    // trmx-159: the rises (false→true) need classification metadata; capture them + the shell pids
    // BEFORE activity_tick consumes busy_now, then enrich the rise events off the LEADER pid.
    let rises = rises_of(&busy_now, prev_busy);
    let (activity, next_busy) = activity_tick(busy_now, prev_busy);
    *prev_busy = next_busy;
    let activity = if rises.is_empty() {
        activity
    } else {
        let shell_pids: HashMap<u64, u32> = snapshot
            .iter()
            .filter_map(|(id, pid)| pid.map(|p| (*id, p)))
            .collect();
        enrich_rises(activity, &rises, &shell_pids, prev_titles, resolver)
    };
    // trmx-75: titles every 4th tick (1 Hz, unchanged) — trmx-263: ONE bulk names call over the
    // distinct leaders of the map above.
    let hints = if resolves_titles(tick) {
        let distinct = sorted_distinct(
            leaders
                .iter()
                .flat_map(|map| map.values().copied().flatten()),
        );
        let names = resolver.names(&distinct);
        let resolved: Vec<(u64, Option<String>)> = snapshot
            .iter()
            .map(|(id, shell)| {
                let name = shell
                    .and_then(|p| leaders.as_ref()?.get(&p).copied().flatten()) // this shell's LEADER
                    .and_then(|tpgid| {
                        let name = names.as_ref()?.get(&tpgid)?; // looked up by LEADER pid
                        // trmx-197: fetch argv only for an interpreter leader — keeps the
                        // KERN_PROCARGS2 sysctl off the 1 Hz path in the common case.
                        let args = if is_interpreter(name) {
                            resolver.args(tpgid)
                        } else {
                            None
                        };
                        Some(effective_title_name(
                            ForegroundProcess {
                                pid: tpgid,
                                name: name.clone(),
                            },
                            args,
                        ))
                    });
                (*id, name)
            })
            .collect();
        let (hints, next_titles) = poll_tick(resolved, prev_titles);
        *prev_titles = next_titles;
        hints
    } else {
        Vec::new()
    };
    PollOutput { activity, hints }
}

/// trmx-75 + trmx-91: the foreground poller loop, spawned once in `setup`. The base tick is
/// **250 ms** so the FR-7a activity indicator flips near-instantly; **titles are resolved every 4th
/// tick** (unchanged 1 Hz). Each tick snapshots `(id, shell_pid)` under the registry lock and **drops
/// the lock before any `ps` call** (lock discipline — subprocess latency must never stall
/// `pty_write`); an empty snapshot clears BOTH carry maps (a reopened world starts fresh) and parks on
/// the [`PollerGate`] condvar until `open_pty` wakes it. Otherwise [`poll_iteration`] runs over the
/// real resolver ([`RealForeground`]) — trmx-263: one bulk `ps` for every session's busy state, one
/// more for the titles on a title tick — and the loop emits its change-only `session:activity`
/// events, then its `session:title-hint`s, best-effort. It NEVER writes core titles — the frontend
/// is the single writer.
pub(crate) fn run_title_poller(
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
        let PollOutput { activity, hints } = poll_iteration(
            &snapshot,
            tick,
            &mut prev_titles,
            &mut prev_busy,
            &RealForeground,
        );
        for event in activity {
            let _ = app.emit("session:activity", event);
        }
        for hint in hints {
            let _ = app.emit("session:title-hint", hint);
        }
        tick = tick.wrapping_add(1);
        std::thread::sleep(Duration::from_millis(250));
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;

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
        args: Vec<String>,
        foreground_calls: RefCell<Vec<u32>>,
        args_calls: RefCell<Vec<u32>>,
        stdin_calls: RefCell<Vec<u32>>,
    }

    impl FakeForeground {
        fn new(leader: u32, name: &str) -> Self {
            Self::with_args(leader, name, &["-p", "hi"])
        }

        /// trmx-197: a fake whose argv tail is chosen by the test (the shim cases need the script
        /// path in argv[0] of the tail).
        fn with_args(leader: u32, name: &str, args: &[&str]) -> Self {
            Self {
                leader,
                name: name.to_string(),
                args: args.iter().map(|s| s.to_string()).collect(),
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
            Some(self.args.clone())
        }
        fn stdin_tty(&self, pid: u32) -> Option<bool> {
            self.stdin_calls.borrow_mut().push(pid);
            Some(true)
        }
        /// trmx-263: every requested shell's leader is `self.leader` — the bulk shape of `foreground`.
        fn leaders(&self, shell_pids: &[u32]) -> Option<HashMap<u32, Option<u32>>> {
            Some(shell_pids.iter().map(|p| (*p, Some(self.leader))).collect())
        }
        /// trmx-263: every requested pid is named `self.name`.
        fn names(&self, pids: &[u32]) -> Option<HashMap<u32, String>> {
            Some(pids.iter().map(|p| (*p, self.name.clone())).collect())
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
    fn enrich_rises_unwraps_an_interpreter_shim_leader() {
        // trmx-197: an npm-shim CLI rises with leader comm `node` and the CLI's launcher path in
        // the argv tail; the emitted metadata must carry the CLI identity — name `codex`, args =
        // the CLI's OWN tail (empty here) — so the counter buckets it and the classifier sees the
        // true invocation shape (bare ⇒ interactive).
        let fake = FakeForeground::with_args(
            9999,
            "node",
            &["/Users/x/.nvm/versions/node/v24.12.0/bin/codex"],
        );
        let mut prev_titles = HashMap::new();
        let shell_pids = HashMap::from([(1u64, 100u32)]);
        let enriched = enrich_rises(
            vec![SessionActivity::bare(1, true)],
            &[1],
            &shell_pids,
            &mut prev_titles,
            &fake,
        );
        assert_eq!(enriched[0].foreground_name, Some("codex".to_string()));
        assert_eq!(enriched[0].foreground_args, Some(vec![]));
        assert_eq!(enriched[0].foreground_stdin_tty, Some(true));
    }

    #[test]
    fn effective_title_name_unwraps_a_shim_and_keeps_raw_names_otherwise() {
        // trmx-197: the title path applies the SAME unwrap as the rise metadata — the App's title
        // hint corrects the counting slot, so the two sites must agree.
        let fg = |name: &str| ForegroundProcess {
            pid: 42,
            name: name.to_string(),
        };
        assert_eq!(
            effective_title_name(fg("node"), Some(vec!["/x/bin/codex".to_string()])),
            "codex",
            "the shim shape unwraps for the title hint"
        );
        assert_eq!(
            effective_title_name(fg("node"), None),
            "node",
            "no argv (resolution failed / non-macOS) keeps the raw comm name"
        );
        assert_eq!(
            effective_title_name(fg("sleep"), Some(vec!["30".to_string()])),
            "sleep",
            "a non-interpreter leader is untouched"
        );
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

    // --- trmx-263 (grill A3): the bulk paths through the seam — one `ps` per pass ----------------

    /// A scripted resolver whose BULK calls are counted: `leaders` / `names` answer from the scripted
    /// maps restricted to the requested pids (`None` when the matching `fail_*` flag is set) and log
    /// each request list; the per-pid `foreground` / `args` / `stdin_tty` answer from the SAME maps
    /// (`foreground` only when both the leader row and its name exist) and log each pid. A test can
    /// therefore prove the periodic passes make exactly one bulk call each and never resolve per pid,
    /// while a rise still resolves per pid on the LEADER.
    struct CountingForeground {
        leaders: HashMap<u32, Option<u32>>,
        names: HashMap<u32, String>,
        args: HashMap<u32, Vec<String>>,
        fail_leaders: bool,
        fail_names: bool,
        leaders_calls: RefCell<Vec<Vec<u32>>>,
        names_calls: RefCell<Vec<Vec<u32>>>,
        foreground_calls: RefCell<Vec<u32>>,
        args_calls: RefCell<Vec<u32>>,
        stdin_calls: RefCell<Vec<u32>>,
    }

    impl CountingForeground {
        fn new(leader_rows: &[(u32, Option<u32>)], name_rows: &[(u32, &str)]) -> Self {
            Self {
                leaders: leader_rows.iter().copied().collect(),
                names: name_rows
                    .iter()
                    .map(|(pid, name)| (*pid, (*name).to_string()))
                    .collect(),
                args: HashMap::new(),
                fail_leaders: false,
                fail_names: false,
                leaders_calls: RefCell::new(Vec::new()),
                names_calls: RefCell::new(Vec::new()),
                foreground_calls: RefCell::new(Vec::new()),
                args_calls: RefCell::new(Vec::new()),
                stdin_calls: RefCell::new(Vec::new()),
            }
        }

        fn with_args(mut self, pid: u32, args: &[&str]) -> Self {
            self.args
                .insert(pid, args.iter().map(|s| (*s).to_string()).collect());
            self
        }

        fn failing_leaders(mut self) -> Self {
            self.fail_leaders = true;
            self
        }

        fn failing_names(mut self) -> Self {
            self.fail_names = true;
            self
        }
    }

    impl ForegroundResolver for CountingForeground {
        fn foreground(&self, shell_pid: u32) -> Option<ForegroundProcess> {
            self.foreground_calls.borrow_mut().push(shell_pid);
            let tpgid = (*self.leaders.get(&shell_pid)?)?;
            let name = self.names.get(&tpgid)?.clone();
            Some(ForegroundProcess { pid: tpgid, name })
        }
        fn args(&self, pid: u32) -> Option<Vec<String>> {
            self.args_calls.borrow_mut().push(pid);
            self.args.get(&pid).cloned()
        }
        fn stdin_tty(&self, pid: u32) -> Option<bool> {
            self.stdin_calls.borrow_mut().push(pid);
            Some(true)
        }
        fn leaders(&self, shell_pids: &[u32]) -> Option<HashMap<u32, Option<u32>>> {
            self.leaders_calls.borrow_mut().push(shell_pids.to_vec());
            if self.fail_leaders {
                return None;
            }
            Some(
                shell_pids
                    .iter()
                    .filter_map(|p| self.leaders.get(p).map(|leader| (*p, *leader)))
                    .collect(),
            )
        }
        fn names(&self, pids: &[u32]) -> Option<HashMap<u32, String>> {
            self.names_calls.borrow_mut().push(pids.to_vec());
            if self.fail_names {
                return None;
            }
            Some(
                pids.iter()
                    .filter_map(|p| self.names.get(p).map(|name| (*p, name.clone())))
                    .collect(),
            )
        }
    }

    /// `n` sessions `(i, Some(1000 + i))`, i = 1..=n — the T-1 / T-2 fixture shape.
    fn sessions(n: u32) -> Vec<(u64, Option<u32>)> {
        (1..=n).map(|i| (u64::from(i), Some(1000 + i))).collect()
    }

    #[test]
    fn poll_iteration_makes_exactly_one_leaders_call_for_n_sessions() {
        // T-1: the activity pass costs ONE bulk `leaders` call whatever N is — over the sorted,
        // de-duplicated shell pids — and, off a title tick with no rise, nothing else: no `names`
        // call and no per-pid `foreground`.
        for n in [1u32, 10, 100] {
            let snapshot = sessions(n);
            let shells: Vec<u32> = (1..=n).map(|i| 1000 + i).collect();
            let leader_rows: Vec<(u32, Option<u32>)> =
                shells.iter().map(|p| (*p, Some(*p))).collect();
            let name_rows: Vec<(u32, &str)> = shells.iter().map(|p| (*p, "zsh")).collect();
            let fake = CountingForeground::new(&leader_rows, &name_rows);
            let mut prev_titles = HashMap::new();
            let mut prev_busy = HashMap::new();
            poll_iteration(&snapshot, 1, &mut prev_titles, &mut prev_busy, &fake);
            assert_eq!(
                *fake.leaders_calls.borrow(),
                vec![shells.clone()],
                "N = {n}: exactly one leaders call, over the sorted de-duplicated shell pids"
            );
            assert!(
                fake.names_calls.borrow().is_empty(),
                "N = {n}: tick 1 is not a title tick"
            );
            assert!(
                fake.foreground_calls.borrow().is_empty(),
                "N = {n}: no per-pid resolution on a non-rise path"
            );
        }
    }

    #[test]
    fn title_tick_makes_exactly_one_names_call_over_the_distinct_leaders() {
        // T-2: ten busy sessions, two sharing leader 900 and the other eight on 901..908 — the
        // title pass costs ONE bulk `names` call over the nine DISTINCT leaders (sorted), not one
        // per session and not over the shell pids; still no per-pid `foreground`.
        let snapshot = sessions(10);
        let mut leader_rows = vec![(1001, Some(900)), (1002, Some(900))];
        leader_rows.extend((1003..=1010).map(|shell| (shell, Some(shell - 102)))); // 1003→901 … 1010→908
        let name_rows: Vec<(u32, &str)> = (900..=908).map(|p| (p, "sleep")).collect();
        let fake = CountingForeground::new(&leader_rows, &name_rows);
        let mut prev_titles = HashMap::new();
        let mut prev_busy: HashMap<u64, bool> = (1..=10).map(|id| (id, true)).collect();
        poll_iteration(&snapshot, 4, &mut prev_titles, &mut prev_busy, &fake);
        assert_eq!(
            *fake.names_calls.borrow(),
            vec![(900..=908).collect::<Vec<u32>>()],
            "exactly one names call, over the nine distinct leaders"
        );
        assert!(fake.foreground_calls.borrow().is_empty());
    }

    #[test]
    fn busy_truth_table_through_the_leaders_map() {
        // T-3: is_busy's truth table evaluated on the bulk map — a row whose leader ≠ shell is busy
        // (B), a row whose leader == shell is idle (B), a row with no group carries (C), a shell
        // with no row (gone) carries (D); and a failed call carries EVERY session (E).
        let snapshot = vec![(1, Some(11)), (2, Some(12)), (3, Some(13)), (4, Some(14))];
        let leader_rows = [(11, Some(11)), (12, Some(77)), (13, None)]; // 14 absent
        let fake = CountingForeground::new(&leader_rows, &[]);
        let mut prev_titles = HashMap::new();
        let mut prev_busy = HashMap::new();
        let out = poll_iteration(&snapshot, 1, &mut prev_titles, &mut prev_busy, &fake);
        assert_eq!(out.activity, vec![activity(1, false), activity(2, true)]);
        assert!(
            !prev_busy.contains_key(&3) && !prev_busy.contains_key(&4),
            "a no-group row and an absent row carry nothing"
        );
        // (E): the call itself failed — nothing is emitted and the carry is untouched.
        let fake = CountingForeground::new(&leader_rows, &[]).failing_leaders();
        let mut prev_busy = busy_map(&[(1, true)]);
        let out = poll_iteration(&snapshot, 1, &mut prev_titles, &mut prev_busy, &fake);
        assert!(
            out.activity.is_empty(),
            "a failed leaders call emits nothing"
        );
        assert_eq!(prev_busy, busy_map(&[(1, true)]));
    }

    #[test]
    fn a_failed_leaders_call_carries_every_session() {
        // T-4: sessions whose live state is the OPPOSITE of their carry — a failed bulk call must
        // flip neither, nor fall back to per-pid resolution: a transient `ps` failure is invisible.
        let snapshot = vec![(1, Some(11)), (2, Some(12))];
        let fake = CountingForeground::new(&[(11, Some(11)), (12, Some(77))], &[(77, "sleep")])
            .failing_leaders();
        let mut prev_titles = HashMap::new();
        let mut prev_busy = busy_map(&[(1, true), (2, false)]);
        let out = poll_iteration(&snapshot, 1, &mut prev_titles, &mut prev_busy, &fake);
        assert!(out.activity.is_empty());
        assert_eq!(prev_busy, busy_map(&[(1, true), (2, false)]));
        assert!(fake.foreground_calls.borrow().is_empty());
    }

    #[test]
    fn a_failed_names_call_carries_every_title() {
        // T-5: a failed bulk `names` call on a title tick hints nothing and keeps every carried
        // title (the poll_tick carry, now fed by the bulk path).
        let snapshot = vec![(1, Some(11))];
        let fake = CountingForeground::new(&[(11, Some(88))], &[(88, "emacs")]).failing_names();
        let mut prev_titles = names(&[(1, "vim")]);
        let mut prev_busy = busy_map(&[(1, true)]);
        let out = poll_iteration(&snapshot, 4, &mut prev_titles, &mut prev_busy, &fake);
        assert!(out.hints.is_empty());
        assert_eq!(prev_titles, names(&[(1, "vim")]));
    }

    #[test]
    fn rise_enrichment_resolves_per_rise_on_the_leader_pid_only() {
        // T-6: a false→true rise still resolves its metadata per pid — `foreground` on the shell
        // ONCE, `args`/`stdin_tty` on the LEADER — on top of the one bulk `leaders` call; the bulk
        // pass itself never goes per pid.
        let snapshot = vec![(1, Some(11))];
        let fake =
            CountingForeground::new(&[(11, Some(77))], &[(77, "sleep")]).with_args(77, &["30"]);
        let mut prev_titles = HashMap::new();
        let mut prev_busy = busy_map(&[(1, false)]);
        let out = poll_iteration(&snapshot, 1, &mut prev_titles, &mut prev_busy, &fake);
        assert_eq!(
            out.activity,
            vec![SessionActivity {
                session_id: 1,
                busy: true,
                foreground_name: Some("sleep".to_string()),
                foreground_args: Some(vec!["30".to_string()]),
                foreground_stdin_tty: Some(true),
            }]
        );
        assert_eq!(*fake.foreground_calls.borrow(), vec![11]);
        assert_eq!(*fake.args_calls.borrow(), vec![77]);
        assert_eq!(*fake.stdin_calls.borrow(), vec![77]);
        assert_eq!(fake.leaders_calls.borrow().len(), 1);
    }

    #[test]
    fn title_tick_unwraps_an_interpreter_leader_via_args_on_the_leader_pid() {
        // T-7: on a title tick an interpreter leader (`node` fronting an npm-shim CLI) is unwrapped
        // via `args` fetched on the LEADER pid, once; a non-interpreter leader (`vim`) never costs an
        // `args` call. No rise (both already busy), so the title path alone calls `args`.
        let snapshot = vec![(1, Some(101)), (2, Some(102))];
        let fake = CountingForeground::new(
            &[(101, Some(501)), (102, Some(502))],
            &[(501, "node"), (502, "vim")],
        )
        .with_args(501, &["/usr/local/lib/node_modules/.bin/codex", "--x"]);
        let mut prev_titles = HashMap::new();
        let mut prev_busy = busy_map(&[(1, true), (2, true)]);
        let out = poll_iteration(&snapshot, 4, &mut prev_titles, &mut prev_busy, &fake);
        assert_eq!(out.hints, vec![hint(1, "codex"), hint(2, "vim")]);
        assert_eq!(*fake.args_calls.borrow(), vec![501]);
    }

    #[test]
    fn title_names_for_a_leader_new_this_iteration_resolve_this_iteration() {
        // T-8: the title pass reuses THIS iteration's leaders map, so a leader first seen now is
        // named now — no extra tick of latency versus the per-session path.
        let snapshot = vec![(1, Some(11))];
        let fake = CountingForeground::new(&[(11, Some(88))], &[(88, "emacs")]);
        let mut prev_titles = names(&[(1, "vim")]);
        let mut prev_busy = busy_map(&[(1, true)]);
        let out = poll_iteration(&snapshot, 4, &mut prev_titles, &mut prev_busy, &fake);
        assert_eq!(out.hints, vec![hint(1, "emacs")]);
        assert_eq!(prev_titles.get(&1).map(String::as_str), Some("emacs"));
    }
}
