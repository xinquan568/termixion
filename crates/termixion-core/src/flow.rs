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

use std::sync::{Condvar, Mutex};
use std::time::Duration;

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

/// Per-session unacked-byte accounting (trmx-78 round 2b). Consumers park at <= 0; `pty_ack`
/// refills on parse completion. Negative overdraw is bounded by one batch (PTY_BATCH_MAX_BYTES).
pub struct CreditCell {
    credits: Mutex<i64>,
    refilled: Condvar,
}

impl CreditCell {
    pub fn new(initial: i64) -> Self {
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
    pub fn consume_floored(&self, bytes: i64, slice: Duration, floor: i64) {
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
    pub fn refill(&self, bytes: i64) {
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
pub const PTY_BATCH_WINDOW_MS: u64 = 4;

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
pub fn run_batch_sender(
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

#[cfg(test)]
mod tests {
    // trmx-244: `mpsc` was imported by the shell test module these cases came from; a test-module
    // import does not follow the code across a module boundary, so it is re-declared here.
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};

    use super::*;

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
