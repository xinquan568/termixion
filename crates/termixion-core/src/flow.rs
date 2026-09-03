// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-244 (grill M5): PTY→transport flow control, moved here from `termixion-tauri/src/pty_io.rs`.
//!
//! The ADR-0001 machinery between the reader [`crate::pump`] and whatever transport the shell owns:
//! natural batching ([`next_batch`], [`run_batch_sender`]) and the unacked-byte credit window
//! ([`CreditCell`]). Platform-free and transport-agnostic — the shell injects `send_batch` and
//! `on_done` closures, exactly as it injects `send`/`on_exit` into [`crate::pump`] — so every
//! invariant below is unit-tested headless on the Linux job rather than only on the macOS gate.
//!
//! The invariants live in the doc comments beside the code that implements them: a BOUNDED hand-off
//! queue ([`PTY_HANDOFF_CHUNKS`]) so a slow consumer backpressures the producer instead of growing a
//! queue, a [`PTY_BATCH_MAX_BYTES`] cap on one coalesced message, and a [`PTY_CREDIT_BYTES`] window
//! the consumer refills as it parses — with a floor ([`PTY_CREDIT_FLOOR`]) so overdraw is bounded
//! and a dead transport ends the loop rather than parking forever.
//!
//! trmx-250: the WAITS are behind a seam — not just the clock. The sender takes everything it
//! needs from time and the hand-off through [`BatchIo`] (production: the `mpsc::Receiver` itself);
//! the credit cell parks through [`Park`] (production: a `Condvar`). The unit tests script arrivals
//! on a virtual clock and script park outcomes, and assert the DECISIONS — which chunks rode
//! together, which deadline each wait asked for, whether a consume parked, probed or stayed parked
//! — rather than how long a call took. A clock-only seam would have reproduced the vacuity the
//! old tests had: they read the real clock around real blocking calls, so the "idle send is
//! immediate-ish" test passed even with the idle path DISABLED (`recv_timeout` on a channel whose
//! producer has hung up returns at once), and the credit tests parked real threads for real
//! milliseconds and flaked under CI load. Both seams are std-only (R2) and, like the rest of this
//! crate, panic-free in non-test code (R3 — `unwrap`/`expect` are denied crate-wide); the fakes
//! live in the test module and are the only place that panics, deliberately, on a broken script.

use std::sync::mpsc::Receiver;
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

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
pub const PTY_HANDOFF_CHUNKS: usize = 256;

/// Cap one coalesced message at 256 KiB — bounds per-message parse cost without re-fragmenting
/// floods into the message storm this exists to fix.
pub const PTY_BATCH_MAX_BYTES: usize = 262_144;

/// Flow-control window (trmx-78 round 2b): at most this many UNACKED bytes may be in flight to
/// the webview. The webview acks bytes on xterm PARSE COMPLETION (`pty_ack`, wired to the
/// `write(data, cb)` callback), so ingestion is bounded by the terminal's real parse rate and the
/// kernel ultimately blocks a flooding producer (`yes`) on the full PTY buffer — the classic
/// terminal feedback loop the issue's ladder names as "respect the parse callback".
pub const PTY_CREDIT_BYTES: i64 = 1_048_576;

/// Bounded park slice while credits are exhausted. Above the overdraw floor the sender proceeds
/// after this wait as a PROBE — the send failure of a genuinely dead channel ends the loop. At
/// the floor probes stop and the park repeats indefinitely (an occluded webview stops acking but
/// must never lose its session; in a single-window app a truly dead webview ends the app anyway).
pub const PTY_CREDIT_WAIT: Duration = Duration::from_millis(500);

/// The overdraw floor (R2 step-8 F1): timeout probes may drive credits negative at most this far,
/// hard-bounding unacked bytes at PTY_CREDIT_BYTES + |floor| even against a channel that queues
/// forever without acking.
pub const PTY_CREDIT_FLOOR: i64 = -PTY_CREDIT_BYTES;

/// The credit cell's wait, behind a seam (trmx-250). Production is a `Condvar` ([`CondvarPark`]);
/// the test module scripts outcomes. This is the observable trmx-241 (L4) found the cell lacked:
/// not a return value production ignores, but the wait primitive production USES — the same
/// shape as the `send_batch`/`on_done` closures of [`run_batch_sender`].
pub trait Park {
    /// Park while `exhausted(credits)` holds, for at most `slice`; returns the guard and whether
    /// the slice timed out. Does not park at all when `exhausted` is already false (that is the
    /// `wait_timeout_while` contract, and the scripted fake keeps it). `None` = the lock was
    /// poisoned; the cell then degrades to unthrottled, as it always has.
    fn park_while<'a>(
        &self,
        guard: MutexGuard<'a, i64>,
        slice: Duration,
        exhausted: fn(&mut i64) -> bool,
    ) -> Option<(MutexGuard<'a, i64>, bool)>;

    /// Wake every parked consumer (a refill arrived).
    fn wake_all(&self);
}

/// The production [`Park`]: `Condvar::wait_timeout_while` / `notify_all`.
pub struct CondvarPark(Condvar);

impl Park for CondvarPark {
    fn park_while<'a>(
        &self,
        guard: MutexGuard<'a, i64>,
        slice: Duration,
        exhausted: fn(&mut i64) -> bool,
    ) -> Option<(MutexGuard<'a, i64>, bool)> {
        self.0
            .wait_timeout_while(guard, slice, exhausted)
            .ok()
            .map(move |(g, r)| (g, r.timed_out()))
    }

    fn wake_all(&self) {
        self.0.notify_all();
    }
}

/// Per-session unacked-byte accounting (trmx-78 round 2b). Consumers park at <= 0; `pty_ack`
/// refills on parse completion. Negative overdraw is bounded by one batch (PTY_BATCH_MAX_BYTES).
///
/// Generic over the wait ([`Park`]) with the production default (trmx-250), so the shell's
/// `Arc<CreditCell>` and `CreditCell::new` read exactly as before; `CreditCell<CondvarPark>` stays
/// `Send + Sync` by auto-trait.
pub struct CreditCell<P: Park = CondvarPark> {
    credits: Mutex<i64>,
    park: P,
}

impl CreditCell<CondvarPark> {
    pub fn new(initial: i64) -> Self {
        Self::with_park(initial, CondvarPark(Condvar::new()))
    }
}

impl<P: Park> CreditCell<P> {
    /// A cell that parks through `park`. Production goes through [`CreditCell::new`]; the test
    /// module passes a scripted park and reads its recorders afterwards.
    pub fn with_park(initial: i64, park: P) -> Self {
        Self {
            credits: Mutex::new(initial),
            park,
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
    /// distinction is not observable to a caller anyway: every arm deducts and returns. What
    /// matters (parking, the slice wait, floor-bounded overdraw) is the wait itself — which is
    /// exactly what [`Park`] exposes, and what the unit tests assert as decisions (trmx-250).
    pub fn consume_floored(&self, bytes: i64, slice: Duration, floor: i64) {
        loop {
            let Ok(guard) = self.credits.lock() else {
                return; // poisoned peer: degrade to unthrottled
            };
            let Some((mut guard, timed_out)) =
                self.park.park_while(guard, slice, |credits| *credits <= 0)
            else {
                return; // poisoned while parked: degrade to unthrottled, no deduction
            };
            if !timed_out {
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
    pub fn refill(&self, bytes: i64) {
        if let Ok(mut credits) = self.credits.lock() {
            *credits = (*credits + bytes).min(PTY_CREDIT_BYTES);
        }
        self.park.wake_all();
    }

    /// Test-only read of the balance (lock, copy).
    #[cfg(test)]
    fn credits(&self) -> i64 {
        *self.credits.lock().expect("credits lock")
    }

    /// Test-only access to the park, so a scripted park's recorders can be read after `with_park`
    /// moved it into the cell.
    #[cfg(test)]
    fn park(&self) -> &P {
        &self.park
    }
}

/// The pacing window under sustained load (trmx-78 round 2, measured): `channel.send` queues
/// internally and returns fast — no backpressure — so drain-only batching never accumulates a
/// backlog (a `yes` flood still produced millions of tiny messages). After each send the sender
/// therefore accumulates for up to this window before the next send, bounding the message rate
/// at ~1000/WINDOW per second with growing batches. The idle path is untouched: a chunk arriving
/// after a quiet period (typing echoes at ≥50 ms spacing) is sent immediately.
pub const PTY_BATCH_WINDOW_MS: u64 = 4;

/// What the sender takes from the hand-off and the clock (trmx-250). Production is the channel
/// itself (impl below); the test module scripts arrivals on a virtual clock. std-only (R2).
///
/// `now` takes `&mut self` on purpose: a scripted clock advances as the fake is consumed, and the
/// trait is what makes that a legal implementation.
pub trait BatchIo {
    /// The clock the pacing deadlines are computed against.
    fn now(&mut self) -> Instant;
    /// Block for the next chunk; `None` = closed and empty.
    fn recv(&mut self) -> Option<Vec<u8>>;
    /// A chunk already queued, else `None` (empty right now, or closed).
    fn try_recv(&mut self) -> Option<Vec<u8>>;
    /// A chunk arriving before `deadline`, else `None` (deadline passed, or closed).
    fn recv_until(&mut self, deadline: Instant) -> Option<Vec<u8>>;
}

impl BatchIo for Receiver<Vec<u8>> {
    fn now(&mut self) -> Instant {
        Instant::now()
    }

    fn recv(&mut self) -> Option<Vec<u8>> {
        Receiver::recv(self).ok()
    }

    fn try_recv(&mut self) -> Option<Vec<u8>> {
        Receiver::try_recv(self).ok()
    }

    fn recv_until(&mut self, deadline: Instant) -> Option<Vec<u8>> {
        // Timeout and disconnect both read as `None`: either way the batch being built is complete.
        self.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .ok()
    }
}

/// So a test can pass `&mut scripted` and inspect the fake afterwards: the sender takes `io` by
/// value — which is what makes the drop order in [`run_batch_sender`] hold for the owned
/// `Receiver` — and a `&mut T` is a value.
impl<T: BatchIo + ?Sized> BatchIo for &mut T {
    fn now(&mut self) -> Instant {
        (**self).now()
    }

    fn recv(&mut self) -> Option<Vec<u8>> {
        (**self).recv()
    }

    fn try_recv(&mut self) -> Option<Vec<u8>> {
        (**self).try_recv()
    }

    fn recv_until(&mut self, deadline: Instant) -> Option<Vec<u8>> {
        (**self).recv_until(deadline)
    }
}

/// One batch: block for the first chunk, then opportunistically drain the backlog up to `max`
/// bytes (the first chunk always rides, even if larger than `max`). `None` = closed and empty.
/// Pure over the [`BatchIo`] seam — unit-tested (order, cap, residue-after-close).
fn next_batch(io: &mut impl BatchIo, max: usize) -> Option<Vec<u8>> {
    let mut batch = io.recv()?;
    while batch.len() < max {
        match io.try_recv() {
            Some(chunk) => batch.extend_from_slice(&chunk),
            None => break, // empty right now, or closed — either way this batch is complete
        }
    }
    Some(batch)
}

/// The sender loop: forward coalesced batches into `send_batch` until the stream ends (producer
/// dropped, queue drained) or the transport rejects a batch; then run `on_done` exactly once.
/// Dropping `io` on return releases a producer blocked on the full bounded queue (`SendError`).
/// Tauri-free seam — unit-tested with fake callbacks (flush-before-done, exactly-once,
/// fail-close, blocked-producer release) and, since trmx-250, with a scripted [`BatchIo`] for the
/// pacing decisions (an idle send enters no wait; every wait asks for exactly `last_send +
/// window`; the cap ends a wait before its deadline); `open_pty` instantiates it with the real
/// channel + reap/emit.
pub fn run_batch_sender(
    io: impl BatchIo,
    max: usize,
    window: Duration,
    mut send_batch: impl FnMut(Vec<u8>) -> bool,
    on_done: impl FnOnce(),
) {
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
    // Re-bind io AFTER the guard: locals drop in reverse order (and parameters last of all), so
    // this makes the receiver drop BEFORE on_done fires — a producer blocked on the full hand-off
    // is already released (SendError) when the reap runs (R2 step-8 F2).
    let mut io = io;
    // `None` = idle: the very first chunk (and any chunk after a quiet period) sends immediately —
    // the pacing only bites while the producer sustains output. trmx-250: this used to be
    // `Instant::now() - window`, and its test was vacuous — it timed a real `recv_timeout` on a
    // channel whose producer had already hung up, which returns at once, so "immediate-ish" held
    // even with the idle path disabled. The decision is what is asserted now: an idle first send
    // records no wait at all.
    let mut last_send: Option<Instant> = None;
    while let Some(mut batch) = next_batch(&mut io, max) {
        // Micro-window pacing: if the previous send was within the window, keep accumulating
        // until the window elapses (or the cap is hit / the stream ends) — forced coalescing
        // against a transport that queues instead of backpressuring. The deadline is exactly
        // `last_send + window`, which is what the scripted tests assert.
        let now = io.now();
        if let Some(since) = last_send.map(|t| now.saturating_duration_since(t))
            && since < window
        {
            let deadline = now + (window - since);
            while batch.len() < max {
                if io.now() >= deadline {
                    break;
                }
                match io.recv_until(deadline) {
                    Some(chunk) => batch.extend_from_slice(&chunk),
                    None => break, // window elapsed with no data, or producer closed
                }
            }
        }
        if !send_batch(batch) {
            break; // transport gone (webview/channel closed)
        }
        last_send = Some(io.now());
    }
    // io (re-bound local) drops first — releasing a blocked producer — then the guard fires.
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::collections::VecDeque;
    use std::sync::mpsc::{Receiver, sync_channel};
    use std::sync::{Arc, Mutex};

    use super::*;

    // --- trmx-78 round 2: the natural-batching sender seam ------------------------------------

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
        let mut rx = chunks(8, &[b"x" as &[u8]]);
        assert_eq!(next_batch(&mut rx, 1024), Some(b"x".to_vec()));
    }

    #[test]
    fn next_batch_coalesces_a_backlog_into_one_ordered_batch() {
        let mut rx = chunks(8, &[b"aa" as &[u8], b"bb", b"cc"]);
        assert_eq!(next_batch(&mut rx, 1024), Some(b"aabbcc".to_vec()));
    }

    #[test]
    fn next_batch_respects_the_cap_and_leaves_the_rest_queued() {
        let mut rx = chunks(8, &[b"aaaa" as &[u8], b"bbbb", b"cccc"]);
        // Cap of 6 bytes: the first chunk always goes; the drain stops once the batch reaches it.
        assert_eq!(next_batch(&mut rx, 6), Some(b"aaaabbbb".to_vec()));
        assert_eq!(next_batch(&mut rx, 6), Some(b"cccc".to_vec()));
    }

    #[test]
    fn next_batch_returns_none_when_closed_and_empty() {
        let (tx, mut rx) = sync_channel::<Vec<u8>>(1);
        drop(tx);
        assert_eq!(next_batch(&mut rx, 1024), None);
    }

    #[test]
    fn next_batch_drains_residue_after_close_then_none() {
        let (tx, mut rx) = sync_channel::<Vec<u8>>(4);
        tx.send(b"tail".to_vec()).expect("queue");
        drop(tx);
        assert_eq!(next_batch(&mut rx, 1024), Some(b"tail".to_vec()));
        assert_eq!(next_batch(&mut rx, 1024), None);
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

    // --- trmx-250: the sender's pacing DECISIONS on a scripted hand-off ------------------------

    /// A discrete-event hand-off: chunks arrive at virtual offsets from `base`, the clock advances
    /// only as the sender consumes them, and every `recv_until` deadline is recorded. No threads,
    /// no sleeps, no real clock — the assertions are on which chunks rode together and on which
    /// deadline each wait asked for.
    struct ScriptedIo {
        base: Instant,
        now: Instant,
        arrivals: VecDeque<(Duration, Vec<u8>)>,
        waits: Vec<Instant>,
    }

    /// An `Instant` has no constructor but the clock, so the virtual clock's origin is read ONCE,
    /// through the production seam, and never read again: every time in a script is an offset
    /// from it and every assertion is on offsets. Nothing here depends on the real clock advancing.
    fn clock_anchor() -> Instant {
        let (_tx, mut rx) = sync_channel::<Vec<u8>>(1);
        rx.now()
    }

    impl ScriptedIo {
        /// `arrivals` = (offset in ms from `base`, chunk), in arrival order.
        fn new(arrivals: Vec<(u64, Vec<u8>)>) -> Self {
            let base = clock_anchor();
            Self {
                base,
                now: base,
                arrivals: arrivals
                    .into_iter()
                    .map(|(ms, chunk)| (Duration::from_millis(ms), chunk))
                    .collect(),
                waits: Vec::new(),
            }
        }

        /// The recorded deadlines as offsets from `base`, in call order.
        fn wait_offsets(&self) -> Vec<Duration> {
            self.waits
                .iter()
                .map(|w| w.duration_since(self.base))
                .collect()
        }

        fn next_arrives_by(&self, t: Instant) -> bool {
            self.arrivals
                .front()
                .is_some_and(|(at, _)| self.base + *at <= t)
        }

        fn advance_to(&mut self, t: Instant) {
            self.now = self.now.max(t);
        }
    }

    impl BatchIo for ScriptedIo {
        fn now(&mut self) -> Instant {
            self.now
        }

        fn recv(&mut self) -> Option<Vec<u8>> {
            let (at, chunk) = self.arrivals.pop_front()?; // exhausted = closed
            self.advance_to(self.base + at);
            Some(chunk)
        }

        fn try_recv(&mut self) -> Option<Vec<u8>> {
            if self.next_arrives_by(self.now) {
                self.recv()
            } else {
                None
            }
        }

        fn recv_until(&mut self, deadline: Instant) -> Option<Vec<u8>> {
            self.waits.push(deadline);
            if self.next_arrives_by(deadline) {
                self.recv()
            } else {
                self.advance_to(deadline);
                None
            }
        }
    }

    const WINDOW: Duration = Duration::from_millis(PTY_BATCH_WINDOW_MS);

    fn two_byte_chunks_at(offsets_ms: impl IntoIterator<Item = u64>) -> ScriptedIo {
        ScriptedIo::new(
            offsets_ms
                .into_iter()
                .map(|ms| (ms, vec![b'y'; 2]))
                .collect(),
        )
    }

    /// Run the sender over a scripted hand-off with a transport that accepts everything; returns
    /// the batches in send order. The fake survives the call (passed as `&mut`), so its recorders
    /// are readable afterwards.
    fn drive(io: &mut ScriptedIo, max: usize) -> Vec<Vec<u8>> {
        let mut sends = Vec::new();
        run_batch_sender(
            io,
            max,
            WINDOW,
            |batch| {
                sends.push(batch);
                true
            },
            || {},
        );
        sends
    }

    #[test]
    fn sender_first_send_after_idle_enters_no_wait() {
        // The pacing must never tax the idle path: a lone echo byte after a quiet period goes out
        // without entering the window wait at all (typing latency budget). Asserted as the
        // decision — no `recv_until` was asked for — not as "it came back quickly".
        let mut io = ScriptedIo::new(vec![(0, b"x".to_vec())]);
        let sends = drive(&mut io, 1024);
        assert_eq!(sends, vec![b"x".to_vec()]);
        assert!(
            io.waits.is_empty(),
            "an idle first send must not wait: {:?}",
            io.wait_offsets()
        );
    }

    #[test]
    fn sender_idle_gap_at_least_a_window_sends_without_waiting() {
        // A chunk arriving a full window (or more) after the previous send is idle again: it is
        // forwarded immediately, with no wait — the pacing only bites while output is sustained.
        let mut io = ScriptedIo::new(vec![(0, b"a".to_vec()), (100, b"b".to_vec())]);
        let sends = drive(&mut io, 1024);
        assert_eq!(sends, vec![b"a".to_vec(), b"b".to_vec()]);
        assert!(
            io.waits.is_empty(),
            "neither send may wait: {:?}",
            io.wait_offsets()
        );
    }

    #[test]
    fn sender_paces_a_flood_into_windowed_batches() {
        // Field evidence (round 2): Tauri's channel.send returns quickly (internal queueing, no
        // backpressure), so drain-only "natural batching" never accumulates — a `yes` flood still
        // became millions of tiny messages. The sender must FORCE coalescing: after a send,
        // accumulate until `last_send + window` before the next one. 50 two-byte chunks one
        // virtual millisecond apart: c0 rides alone (idle), then every batch closes when the clock
        // reaches its deadline — four chunks per 4 ms window — and c49's window expires with
        // nothing queued.
        let mut io = two_byte_chunks_at(0..50);
        let sends = drive(&mut io, 1024 * 1024);
        let partition: Vec<usize> = sends.iter().map(|batch| batch.len() / 2).collect();
        assert_eq!(
            partition,
            vec![1, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 1],
            "chunks per send"
        );
        assert_eq!(sends.concat().len(), 100, "every byte arrives exactly once");
        let mut deadlines = io.wait_offsets();
        deadlines.sort();
        deadlines.dedup();
        let expected: Vec<Duration> = (1..=13).map(|k| Duration::from_millis(4 * k)).collect();
        assert_eq!(
            deadlines, expected,
            "every wait asked for exactly last_send + window"
        );
    }

    #[test]
    fn sender_window_wait_ends_at_the_cap_before_the_deadline() {
        // Four two-byte chunks at 0, 1, 2, 3 ms with a 6-byte cap. c0 is alone (idle, no wait).
        // c1 arrives inside the window, so the PACED drain takes c2 and c3 and then stops because
        // the batch has reached the cap — at 3 ms, before the 4 ms deadline. The script never
        // pre-queues more than the cap, so `next_batch`'s own cap is not what closes the batch:
        // exactly two `recv_until` calls, both for deadline 4, and no third.
        let mut io = two_byte_chunks_at(0..4);
        let sends = drive(&mut io, 6);
        let partition: Vec<usize> = sends.iter().map(|batch| batch.len() / 2).collect();
        assert_eq!(partition, vec![1, 3], "chunks per send");
        assert_eq!(
            io.wait_offsets(),
            vec![Duration::from_millis(4), Duration::from_millis(4)],
            "two waits, both for last_send + window, and no third"
        );
    }

    // --- trmx-78 round 2b / trmx-250: the credit cell's DECISIONS on a scripted park ------------

    /// What one required park resolves to.
    enum Outcome {
        /// A refill of this many credits arrived while parked (the wait returns, not timed out).
        /// It does NOT go through `CreditCell::refill` — the production wake path has its own test.
        Refill(i64),
        /// The slice elapsed with credits still exhausted.
        TimedOut,
        /// The lock was poisoned while parked (`park_while` → `None`).
        Poisoned,
    }

    /// A scripted [`Park`]. `park_while` takes `&self`, so the recorders use interior mutability
    /// (single-threaded test code). Like the real `wait_timeout_while` it does not park — and
    /// consumes no outcome — when `exhausted` is already false. A required park with an exhausted
    /// script PANICS, naming the slice: a fake that silently returns is how a test passes by
    /// accident.
    struct ScriptedPark {
        outcomes: RefCell<VecDeque<Outcome>>,
        parks: RefCell<Vec<Duration>>,
        wakes: Cell<usize>,
    }

    impl ScriptedPark {
        fn script(outcomes: impl IntoIterator<Item = Outcome>) -> Self {
            Self {
                outcomes: RefCell::new(outcomes.into_iter().collect()),
                parks: RefCell::new(Vec::new()),
                wakes: Cell::new(0),
            }
        }

        /// The slices actually parked, in order.
        fn parks(&self) -> Vec<Duration> {
            self.parks.borrow().clone()
        }

        fn wakes(&self) -> usize {
            self.wakes.get()
        }

        /// Outcomes still unconsumed.
        fn remaining(&self) -> usize {
            self.outcomes.borrow().len()
        }
    }

    impl Park for ScriptedPark {
        fn park_while<'a>(
            &self,
            mut guard: MutexGuard<'a, i64>,
            slice: Duration,
            exhausted: fn(&mut i64) -> bool,
        ) -> Option<(MutexGuard<'a, i64>, bool)> {
            if !exhausted(&mut guard) {
                return Some((guard, false));
            }
            self.parks.borrow_mut().push(slice);
            let Some(outcome) = self.outcomes.borrow_mut().pop_front() else {
                panic!(
                    "ScriptedPark: a park of {slice:?} was required but the script is exhausted"
                );
            };
            match outcome {
                Outcome::Refill(bytes) => {
                    *guard += bytes;
                    Some((guard, false))
                }
                Outcome::TimedOut => Some((guard, true)),
                Outcome::Poisoned => None,
            }
        }

        fn wake_all(&self) {
            self.wakes.set(self.wakes.get() + 1);
        }
    }

    const SLICE: Duration = Duration::from_millis(500);

    #[test]
    fn credit_cell_positive_credits_consume_without_parking() {
        // Positive credits never park — a batch may overdraw into negative (bounded by the batch
        // cap), which is what makes the accounting simple: park only at <= 0. A refilled cell
        // consumes without parking too.
        let cell = CreditCell::with_park(8, ScriptedPark::script([]));
        cell.consume_floored(6, SLICE, -100);
        cell.consume_floored(6, SLICE, -100); // 2 left: positive, overdraws to -4
        cell.refill(100);
        cell.consume_floored(50, SLICE, -100);
        assert!(cell.park().parks().is_empty(), "no parking while positive");
        assert_eq!(cell.credits(), 46);
    }

    #[test]
    fn credit_cell_parks_at_zero_and_a_refill_releases_it() {
        // floor 0: at zero credits there is no probe headroom — a pure park-until-refill. The
        // refill arrives during the park; the consume then deducts from the refilled balance.
        let cell = CreditCell::with_park(4, ScriptedPark::script([Outcome::Refill(10)]));
        cell.consume_floored(4, SLICE, 0); // now 0 — the next one parks
        cell.consume_floored(2, SLICE, 0);
        assert_eq!(cell.park().parks(), vec![SLICE]);
        assert_eq!(cell.credits(), 8);
    }

    #[test]
    fn credit_cell_timeout_probe_proceeds_above_the_floor() {
        // A webview that stops acking: the bounded wait expires and the consumer PROBES (the send
        // failure of a dead channel ends the loop) — one park, then the deduction goes through
        // because credits are still above the floor.
        let cell = CreditCell::with_park(1, ScriptedPark::script([Outcome::TimedOut]));
        cell.consume_floored(1, SLICE, -100);
        cell.consume_floored(1, SLICE, -100);
        assert_eq!(
            cell.park().parks().len(),
            1,
            "exactly one slice, then the probe"
        );
        assert_eq!(cell.credits(), -1);
    }

    #[test]
    fn credit_cell_at_the_floor_keeps_parking_until_a_refill() {
        // R2 step-8 F1: timeout-proceed must NOT allow unbounded overdraw against a channel that
        // queues forever without acks. Probes proceed only while credits stay above the floor;
        // at the floor the consumer parks slice after slice until a refill. Floor -4:
        // 4 -> 0 (positive, no park) -> -4 (park, time out, probe: 0 > -4) -> at the floor the
        // next consume parks, times out, is NOT above the floor, parks again, and takes the refill.
        let cell = CreditCell::with_park(
            4,
            ScriptedPark::script([Outcome::TimedOut, Outcome::TimedOut, Outcome::Refill(100)]),
        );
        cell.consume_floored(4, SLICE, -4);
        cell.consume_floored(4, SLICE, -4);
        // After the probe: one park, and the overdraw reached the floor. This intermediate
        // assertion is what separates "never probe" and "always park" from production — both
        // consume the same three outcomes overall and end at 92.
        assert_eq!(cell.park().parks().len(), 1, "the probe took one slice");
        assert_eq!(cell.credits(), -4);
        cell.consume_floored(4, SLICE, -4);
        assert_eq!(
            cell.park().parks().len(),
            3,
            "at the floor: park, park again, refill"
        );
        assert_eq!(cell.credits(), 92);
    }

    #[test]
    fn credit_cell_refill_wakes_parked_consumers() {
        // The production wake path (`pty_ack` → `refill` → `wake_all`), separate from the scripted
        // refill above, which models a refill arriving while parked and never calls `refill`.
        let cell = CreditCell::with_park(0, ScriptedPark::script([Outcome::TimedOut]));
        cell.refill(1);
        assert_eq!(cell.park().wakes(), 1, "one wake per refill");
        assert_eq!(cell.park().remaining(), 1, "no outcome consumed");
        assert!(cell.park().parks().is_empty(), "a refill never parks");
        assert_eq!(cell.credits(), 1);
    }

    #[test]
    fn credit_cell_poisoned_wait_degrades_to_unthrottled() {
        // A poisoned lock while parked returns without deducting — the cell degrades to
        // unthrottled rather than panicking or accounting against a balance it cannot trust.
        let cell = CreditCell::with_park(0, ScriptedPark::script([Outcome::Poisoned]));
        cell.consume_floored(5, SLICE, -100);
        assert_eq!(cell.park().parks(), vec![SLICE], "the park was entered");
        assert_eq!(cell.credits(), 0, "no deduction on the degrade path");
    }
}
