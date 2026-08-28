// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-238 (L1 + L7): the ONE debounced filesystem watcher the config, theme and script watchers
//! all run on.
//!
//! Two bugs motivated it. **L1**: every one of the three copies opened its notify callback with
//! `if let Ok(event)`, silently dropping the `Err` arm — and a notify error is not noise, it is the
//! backend reporting that *events were lost*. Worse, that is only half the loss channel: notify also
//! reports lost events *successfully*, as `Ok(Event)` with [`notify::Event::need_rescan`] set, and on
//! macOS FSEvents builds that event with **no paths at all** — so every copy's `event.paths.iter()
//! .any(..)` filter discarded it too. **L7**: the three copies were ~50-line near-duplicates.
//!
//! Waking on a lost-event report is safe because every wake body here is idempotent by construction:
//! the config wake is latched by `last_write_hash` and re-reads the whole file, and the theme/script
//! wakes emit a bare "re-read" signal.
//!
//! Testability is the reason for the seams: [`should_wake`] is pure, [`drain_debounced`] takes a
//! plain channel, and [`run_watcher_with`] takes the event stream as a parameter — so the whole path
//! from a scripted event to a wake is exercised with no notify backend, no `AppHandle`, and no real
//! watcher (there were no watcher-loop tests to lean on before this).

use notify::{RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;

/// Everything that differs between the three watchers.
pub struct WatchSpec {
    /// The directory to watch (never a file — editors replace files, so we watch the parent).
    pub dir: PathBuf,
    /// `Recursive` for scripts (nested script dirs), `NonRecursive` for config and themes.
    pub mode: RecursiveMode,
    /// Quiet period before acting; a burst of events collapses into one wake.
    pub debounce: Duration,
    /// Which paths this watcher cares about. Note it is NOT consulted for lost-event reports.
    pub filter: Arc<dyn Fn(&Path) -> bool + Send + Sync>,
}

/// The L1 decision, pure: should this notify callback invocation wake the loop?
///
/// - `Err(_)` → yes. The watcher is telling us it lost events; a re-read is the only safe answer.
/// - `Ok(e)` with [`need_rescan`](notify::Event::need_rescan) → yes, **ignoring the path filter**:
///   the macOS FSEvents rescan notice carries no paths, so filtering it drops exactly the signal
///   that says "you are now out of sync".
/// - otherwise → only if some path passes the filter (the pre-existing behavior; it is what keeps
///   the temp-file traffic of atomic writes from waking us).
pub fn should_wake(
    event: &Result<notify::Event, notify::Error>,
    filter: &dyn Fn(&Path) -> bool,
) -> bool {
    match event {
        Err(_) => true,
        Ok(event) if event.need_rescan() => true,
        Ok(event) => event.paths.iter().any(|path| filter(path)),
    }
}

/// Block until a WAKE-WORTHY event arrives. `false` = the event stream ended and the loop is done.
///
/// Filtering happens here rather than in a fan-in thread: an earlier revision fanned events into a
/// second channel from inside `std::thread::scope`, which could DEADLOCK — a panic in `on_wake`
/// unwinds into the scope's implicit join, but the fan-in thread stays blocked on a stream whose
/// sender lives in the notify watcher one frame further out, so it never ends. One thread, one
/// channel, no join, no deadlock.
fn wait_for_wake(
    events: &Receiver<Result<notify::Event, notify::Error>>,
    filter: &dyn Fn(&Path) -> bool,
) -> bool {
    while let Ok(event) = events.recv() {
        if should_wake(&event, filter) {
            if let Err(err) = &event {
                log::warn!("termixion: file watcher reported lost events: {err}");
            }
            return true;
        }
    }
    false
}

/// After a wake-worthy event, swallow everything until `debounce` of quiet — a burst of events (an
/// editor's atomic-write dance, a bulk copy) collapses into ONE wake. Anything arriving in the
/// quiet window extends it, filtered or not: the point is to act once the filesystem settles.
pub fn drain_debounced(
    events: &Receiver<Result<notify::Event, notify::Error>>,
    debounce: Duration,
) {
    while events.recv_timeout(debounce).is_ok() {}
}

/// The loop, with the event stream injected. Production passes a real notify watcher's receiver
/// (see [`run_debounced`]); tests pass a plain channel they script.
pub fn run_watcher_with(
    spec: &WatchSpec,
    events: Receiver<Result<notify::Event, notify::Error>>,
    mut on_wake: impl FnMut(),
) {
    while wait_for_wake(&events, spec.filter.as_ref()) {
        drain_debounced(&events, spec.debounce);
        on_wake();
    }
}

/// Start a real notify watcher for `spec` and run the debounced loop over it. Returns (having
/// logged) if the watcher cannot be created or attached — a watch we cannot start is a degraded
/// mode, never a crash.
pub fn run_debounced(spec: &WatchSpec, on_wake: impl FnMut()) {
    let (tx, rx) = channel::<Result<notify::Event, notify::Error>>();
    let mut watcher = match notify::recommended_watcher(move |event| {
        let _ = tx.send(event);
    }) {
        Ok(watcher) => watcher,
        Err(err) => {
            log::warn!(
                "termixion: could not create the watcher for {}: {err}",
                spec.dir.display()
            );
            return;
        }
    };
    if let Err(err) = watcher.watch(&spec.dir, spec.mode) {
        log::warn!(
            "termixion: could not watch {}: {err}; file watching disabled",
            spec.dir.display()
        );
        return;
    }
    run_watcher_with(spec, rx, on_wake);
    // `watcher` is deliberately still alive here: dropping it earlier would close the event stream
    // and end the loop immediately. It drops when this function returns, which is what lets
    // run_watcher_with observe the stream ending.
    drop(watcher);
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::{Event, EventKind, event::Flag};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn spec_for(filter: impl Fn(&Path) -> bool + Send + Sync + 'static) -> WatchSpec {
        WatchSpec {
            dir: PathBuf::from("/tmp/x"),
            mode: RecursiveMode::NonRecursive,
            debounce: Duration::from_millis(20),
            filter: Arc::new(filter),
        }
    }

    fn matches_toml(path: &Path) -> bool {
        path.extension().is_some_and(|ext| ext == "toml")
    }

    #[test]
    fn an_error_event_wakes_the_loop_because_it_means_events_were_lost() {
        let event = Err(notify::Error::generic("queue overflow"));
        assert!(should_wake(&event, &matches_toml));
    }

    #[test]
    fn a_pathless_rescan_notice_wakes_the_loop_despite_the_path_filter() {
        // This is exactly what notify's macOS FSEvents backend constructs when the kernel drops
        // events (notify-8.2.0/src/fsevent.rs): EventKind::Other, Flag::Rescan, and NO paths.
        // The pre-trmx-238 `event.paths.iter().any(..)` filter discarded it.
        let event = Ok(Event::new(EventKind::Other).set_flag(Flag::Rescan));
        assert!(
            event.as_ref().unwrap().paths.is_empty(),
            "the fixture must mirror the real pathless rescan notice"
        );
        assert!(should_wake(&event, &matches_toml));
    }

    #[test]
    fn an_ordinary_event_still_obeys_the_path_filter() {
        let matching = Ok(Event::new(EventKind::Other).add_path(PathBuf::from("/tmp/x/a.toml")));
        assert!(should_wake(&matching, &matches_toml));
        // Atomic-write temp traffic must stay filtered out — that is why the filter exists.
        let other = Ok(Event::new(EventKind::Other).add_path(PathBuf::from("/tmp/x/a.toml.tmp")));
        assert!(!should_wake(&other, &matches_toml));
    }

    // Deterministic by construction: every event is queued BEFORE the loop runs and the loop is
    // single-threaded, so the drain sees them all already buffered — no scheduler race, and the
    // 20 ms debounce is only ever waited out once, after the queue is empty.
    #[test]
    fn a_burst_of_events_collapses_into_exactly_one_wake() {
        let (tx, rx) = channel::<Result<notify::Event, notify::Error>>();
        for _ in 0..5 {
            tx.send(Ok(
                Event::new(EventKind::Other).add_path(PathBuf::from("/tmp/x/a.toml"))
            ))
            .expect("scripted send");
        }
        drop(tx);
        let wakes = AtomicUsize::new(0);
        run_watcher_with(&spec_for(matches_toml), rx, || {
            wakes.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(
            wakes.load(Ordering::SeqCst),
            1,
            "a debounced burst is one wake"
        );
    }

    #[test]
    fn lost_event_reports_reach_the_wake_through_the_whole_loop() {
        // The end-to-end wiring both loss channels must survive: an Err and a pathless rescan,
        // neither of which the path filter would pass.
        let (tx, rx) = channel::<Result<notify::Event, notify::Error>>();
        tx.send(Err(notify::Error::generic("kernel dropped")))
            .expect("scripted send");
        drop(tx);
        let wakes = AtomicUsize::new(0);
        run_watcher_with(&spec_for(matches_toml), rx, || {
            wakes.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(wakes.load(Ordering::SeqCst), 1, "an Err must wake the loop");

        let (tx, rx) = channel::<Result<notify::Event, notify::Error>>();
        tx.send(Ok(Event::new(EventKind::Other).set_flag(Flag::Rescan)))
            .expect("scripted send");
        drop(tx);
        let wakes = AtomicUsize::new(0);
        run_watcher_with(&spec_for(matches_toml), rx, || {
            wakes.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(
            wakes.load(Ordering::SeqCst),
            1,
            "a pathless rescan must wake the loop"
        );
    }

    #[test]
    fn the_loop_ends_when_the_event_stream_closes_and_never_joins_a_helper_thread() {
        // Regression for the scoped-fan-in deadlock: a panicking on_wake must not hang. There is
        // no helper thread to join now, so the panic simply propagates.
        let (tx, rx) = channel::<Result<notify::Event, notify::Error>>();
        tx.send(Ok(
            Event::new(EventKind::Other).add_path(PathBuf::from("/tmp/x/a.toml"))
        ))
        .expect("scripted send");
        drop(tx);
        let spec = spec_for(matches_toml);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_watcher_with(&spec, rx, || panic!("wake exploded"));
        }));
        assert!(
            result.is_err(),
            "the panic propagates instead of deadlocking"
        );
    }

    #[test]
    fn a_filtered_out_event_produces_no_wake_at_all() {
        let (tx, rx) = channel::<Result<notify::Event, notify::Error>>();
        tx.send(Ok(
            Event::new(EventKind::Other).add_path(PathBuf::from("/tmp/x/ignored.txt"))
        ))
        .expect("scripted send");
        drop(tx);
        let wakes = AtomicUsize::new(0);
        run_watcher_with(&spec_for(matches_toml), rx, || {
            wakes.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(wakes.load(Ordering::SeqCst), 0);
    }
}
