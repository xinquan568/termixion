// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-91 (FR-7a) golden test: `is_busy` observes a REAL shell's activity through a real PTY —
// idle at the prompt (the foreground leader IS the shell → not busy) → `sleep 2` (a child job
// becomes the foreground leader → busy) → and BACK to idle when it exits. This pins the activity
// indicator's *busy* predicate to actual foreground handoffs; it is the boolean sibling of
// `tests/foreground.rs`'s by-name round-trip. Same conventions as `session_lifecycle.rs`: rc-free
// `zsh -f`, a pump thread on the blocking reader, deadline polls, and `ps -o stat=` no-zombie
// hygiene on every captured pid. macOS-only (the whole file compiles away elsewhere).
#![cfg(unix)]

use std::process::Command;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use termixion_core::{PtyReader, PtySize, Session, SessionSpec};
use termixion_platform::{UnixPtyFactory, foreground_process, is_busy};

/// The process state of `pid` via `ps -o stat=` — `None` if the pid is gone, else the state string
/// (a leading `Z` means a zombie). We check the *zombie state* specifically, not mere existence,
/// because a freed pid can be reused by an unrelated process (e.g. a `cargo` subprocess during a
/// full-workspace `cargo test`) — and a reused *live* process must not be mistaken for our leak.
fn process_state(pid: u32) -> Option<String> {
    let out = Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !out.status.success() {
        return None; // pid no longer exists — reaped and gone
    }
    let state = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if state.is_empty() { None } else { Some(state) }
}

fn assert_no_zombie(pid: u32) {
    // A dead child must be REAPED AND GONE — `ps` must stop reporting the pid (the strengthened
    // trmx-74 convention: poll until GONE). A persistent `Z…` state is the classic zombie leak; a
    // persistent *live* state is worse (the kill never landed / an orphan survived) and must fail
    // just as loudly — merely "not a zombie" would hide a still-running child. The 2 s deadline
    // only lets an in-flight reap settle; the residual pid-reuse race (freed pid re-issued to an
    // unrelated process within the window) is accepted — macOS allocates pids forward, making a
    // same-window reuse vanishingly unlikely.
    let mut last_state: Option<String> = None;
    for _ in 0..40 {
        match process_state(pid) {
            None => return, // reaped & gone — the only pass
            Some(state) => {
                last_state = Some(state);
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
    let state = last_state.unwrap_or_default();
    if state.starts_with('Z') {
        panic!("child pid {pid} was left as a zombie after teardown (state {state})");
    }
    panic!(
        "child pid {pid} is still alive after teardown (state {state}) — kill/reap never landed"
    );
}

/// The deterministic, rc-free interactive shell every golden test uses (see the rationale in
/// `session_lifecycle.rs`): `zsh -f` (NO_RCS) skips all startup files, so a dev/CI rc hook can
/// never garble or hang this test. Interactive zsh enables job control (MONITOR), so a foreground
/// job really does get its own process group — the exact mechanism `is_busy` observes.
fn rc_free_zsh() -> SessionSpec {
    let mut spec = SessionSpec::shell("/bin/zsh");
    spec.args.push("-f".into());
    spec
}

/// Move the blocking [`PtyReader`] onto its own thread (ADR-0001), forwarding chunks over a
/// channel so the kernel PTY buffer never fills while the test spends ~2 s polling `ps`. The pump
/// exits at EOF or on a torn-down PTY, so joining it after `kill` cannot hang. The receiver must
/// stay alive for the test's duration — a dropped receiver would end the pump early.
fn pump_reader(
    mut reader: Box<dyn PtyReader>,
) -> (mpsc::Receiver<Vec<u8>>, std::thread::JoinHandle<()>) {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let pump = std::thread::spawn(move || {
        let mut buf = [0u8; 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break, // EOF (shell exited) or a torn-down PTY
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break; // the test stopped listening
                    }
                }
            }
        }
    });
    (rx, pump)
}

/// Deadline-poll `is_busy(shell_pid)` every ~100 ms until it equals `Some(want)`, returning the
/// last observation (so a caller's assert message shows what it actually saw, including a `None`).
/// The bound is only load-bearing when the plumbing is broken — a loaded CI box must not flake a
/// green pin, so every caller's window is generous relative to the sub-second reality.
fn poll_is_busy_until(shell_pid: u32, want: bool, deadline: Instant) -> Option<bool> {
    loop {
        let observed = is_busy(shell_pid);
        if observed == Some(want) || Instant::now() >= deadline {
            return observed;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// trmx-91: the full idle → busy → idle activity round-trip through a real PTY, asserted on the
/// `is_busy` boolean. Idle, the terminal's foreground leader IS the shell → `Some(false)`; `sleep 2`
/// moves the foreground to the child's own group → `Some(true)`; when it exits the shell reclaims
/// the foreground → `Some(false)` again. Teardown leaves no zombie on EITHER captured pid.
#[test]
fn is_busy_tracks_the_shells_activity_round_trip() {
    let factory = UnixPtyFactory;
    let mut session = Session::spawn(1, &factory, &rc_free_zsh(), PtySize::new(24, 80))
        .expect("spawn an rc-free shell through the trait");
    let shell_pid = session.process_id().expect("a real PTY has a child pid");
    assert!(session.is_alive());

    // Pump output on its own thread so ~2 s of `ps`-polling never backs up the kernel PTY buffer.
    let reader = session.take_reader().expect("a real PTY yields a reader");
    let (_rx, pump) = pump_reader(reader);

    // Phase 1 — idle: at its prompt the interactive shell is its own foreground group leader
    // (portable-pty spawns it as the PTY's session + group leader, so tpgid == its pid) → not busy.
    // Poll (not a bare assert) to absorb shell startup; the 5 s bound is pure flake insurance.
    assert_eq!(
        poll_is_busy_until(shell_pid, false, Instant::now() + Duration::from_secs(5)),
        Some(false),
        "a shell at its prompt is its own foreground leader → is_busy must be Some(false)"
    );

    // Phase 2 — busy: `sleep 2` forks a child that job-control zsh moves into the terminal's
    // foreground group, so the leader's pid differs from the shell's → busy. The flip lands fast
    // (normally < 200 ms); the 3 s bound, polled every ~100 ms, is generous flake insurance.
    session
        .write(b"sleep 2\n")
        .expect("write `sleep 2` to the pty");
    assert_eq!(
        poll_is_busy_until(shell_pid, true, Instant::now() + Duration::from_secs(3)),
        Some(true),
        "while `sleep` runs, the foreground leader is the child job → is_busy must be Some(true)"
    );
    // Capture the busy foreground leader's pid (the `sleep` child) for teardown hygiene. `sleep 2`
    // is still running, so this observes the same child — and it must not be the shell.
    let sleep_pid = foreground_process(shell_pid).map(|fg| fg.pid);
    assert_ne!(
        sleep_pid,
        Some(shell_pid),
        "the busy foreground leader must be the child job, not the shell itself"
    );

    // Phase 3 — back to idle: when `sleep` exits, zsh reaps it and reclaims the terminal's
    // foreground group → is_busy returns to Some(false). The bound is generous (the sleep is 2 s;
    // allow it to finish plus ample slack) so a loaded CI box can't flake a green pin.
    assert_eq!(
        poll_is_busy_until(shell_pid, false, Instant::now() + Duration::from_secs(5)),
        Some(false),
        "after `sleep` exits the shell reclaims the foreground → is_busy must return to Some(false)"
    );

    // Teardown: kill the live shell (SIGKILL + reap); the pump sees EOF and exits, so the join can't
    // hang. No zombie may linger on the shell — nor on the `sleep` child (zsh reaped it at exit,
    // before Phase 3 could pass), so both captured pids get the `ps -o stat=` hygiene check.
    session.kill().expect("kill the live shell");
    assert!(!session.is_alive());
    pump.join().expect("the reader thread exits at EOF");
    assert_no_zombie(shell_pid);
    if let Some(sp) = sleep_pid {
        assert_no_zombie(sp);
    }
}

/// trmx-91 (review-1): a PIPELINE whose group LEADER exits before the tail must still read as busy.
/// `true | sleep 2` — job-control zsh puts the pipeline in one foreground group whose leader is
/// `true` (it exits almost immediately), while `sleep 2` keeps the group foregrounding the terminal.
/// The tpgid stays != the shell's pid, so `is_busy` must be `Some(true)` for the sleep's duration.
/// The pre-fix `is_busy` (via `foreground_process`, which needs `ps -p <tpgid> -o comm=` on the now-
/// DEAD leader) would have returned `None` here and shown the pane idle — this pins that it does not.
#[test]
fn is_busy_reports_busy_for_a_pipeline_whose_leader_has_exited() {
    let factory = UnixPtyFactory;
    let mut session = Session::spawn(1, &factory, &rc_free_zsh(), PtySize::new(24, 80))
        .expect("spawn an rc-free shell through the trait");
    let shell_pid = session.process_id().expect("a real PTY has a child pid");
    let reader = session.take_reader().expect("a real PTY yields a reader");
    let (_rx, pump) = pump_reader(reader);

    // Settle at the idle prompt first (not busy).
    assert_eq!(
        poll_is_busy_until(shell_pid, false, Instant::now() + Duration::from_secs(5)),
        Some(false),
    );

    // The pipeline: `true` (the group leader) exits at once; `sleep 2` (the tail) keeps the group
    // foreground. is_busy must be Some(true) even though the leader is already gone.
    session
        .write(b"true | sleep 2\n")
        .expect("write the pipeline to the pty");
    assert_eq!(
        poll_is_busy_until(shell_pid, true, Instant::now() + Duration::from_secs(3)),
        Some(true),
        "a pipeline with a short-lived leader must still read busy (tpgid-only, review-1)"
    );

    // Back to idle when the pipeline completes.
    assert_eq!(
        poll_is_busy_until(shell_pid, false, Instant::now() + Duration::from_secs(5)),
        Some(false),
    );

    session.kill().expect("kill the live shell");
    pump.join().expect("the reader thread exits at EOF");
    assert_no_zombie(shell_pid);
}
