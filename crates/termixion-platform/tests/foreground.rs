// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-75 (FR-2.4) golden test: `foreground_process` observes a REAL shell's foreground churn
// through a real PTY — idle (the leader IS the shell) → `sleep 1` (the leader is the child job)
// → and BACK to the shell — pinning that tpgid tracks foreground handoffs, not just the first
// hop. Same conventions as `session_lifecycle.rs`: rc-free `zsh -f`, a pump thread on the
// blocking reader, deadline polls, and `ps -o stat=` no-zombie hygiene on EVERY captured pid.
// macOS-only (the whole file compiles away elsewhere).
#![cfg(target_os = "macos")]

use std::process::Command;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use termixion_core::{PtyReader, PtySize, SessionRegistry, SessionSpec};
use termixion_platform::{ForegroundProcess, MacosPtyFactory, foreground_process};

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
/// job really does get its own process group — the exact mechanism `foreground_process` observes.
fn rc_free_zsh() -> SessionSpec {
    let mut spec = SessionSpec::shell("/bin/zsh");
    spec.args.push("-f".into());
    spec
}

/// Move the blocking [`PtyReader`] onto its own thread (ADR-0001), forwarding chunks over a
/// channel so the kernel PTY buffer never fills while the test is busy polling `ps`. The pump
/// exits at EOF or on a torn-down PTY, so joining it after `close` cannot hang. The receiver must
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

/// Deadline-poll `foreground_process(shell_pid)` until the resolved name equals `want`, returning
/// that observation. 50 ms steps under a generous 5 s window — the deadline is only load-bearing
/// when the plumbing is actually broken, and a loaded CI box must not flake a green pin. Panics
/// (with the last observation) on timeout.
fn poll_foreground_until(shell_pid: u32, want: &str) -> ForegroundProcess {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut last: Option<ForegroundProcess> = None;
    loop {
        if let Some(fg) = foreground_process(shell_pid) {
            if fg.name == want {
                return fg;
            }
            last = Some(fg);
        }
        assert!(
            Instant::now() < deadline,
            "foreground of pid {shell_pid} never became {want:?} before the deadline; \
             last observation: {last:?}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// trmx-75: the full there-AND-BACK foreground round-trip through a real registry-spawned PTY.
/// Idle, the terminal's foreground process-group leader IS the shell (the FR-7a "busy" predicate's
/// ground state); `sleep 1` moves the foreground to the child's own group (name flips to "sleep",
/// pid to the child's); when it exits the shell reclaims the foreground (name flips BACK) — so
/// tpgid demonstrably tracks foreground churn. Teardown leaves no zombie on EITHER captured pid.
#[test]
fn foreground_process_tracks_the_shells_foreground_round_trip() {
    let factory = MacosPtyFactory;
    let mut registry = SessionRegistry::new();
    let (id, reader) = registry
        .spawn(&factory, &rc_free_zsh(), PtySize::new(24, 80))
        .expect("spawn an rc-free shell through the registry");
    let shell_pid = registry
        .process_id(id)
        .expect("the session is live")
        .expect("a real PTY has a child pid");
    let (_rx, pump) = pump_reader(reader);

    // Phase 1 — idle: once the interactive shell is up, the foreground leader is the shell
    // itself (portable-pty spawns it as the PTY's session + group leader, so tpgid == its pid).
    let idle = poll_foreground_until(shell_pid, "zsh");
    assert_eq!(
        idle.pid, shell_pid,
        "idle, the foreground leader must be the shell itself"
    );

    // Phase 2 — there: a foreground job takes over the terminal's foreground group. Capture the
    // leader's pid so teardown can assert ITS hygiene too, not just the shell's.
    registry.write(id, b"sleep 1\n").expect("write `sleep 1`");
    let fg = poll_foreground_until(shell_pid, "sleep");
    let sleep_pid = fg.pid;
    assert_ne!(
        sleep_pid, shell_pid,
        "a foreground job runs in its own process group, not the shell's"
    );

    // Phase 3 — and back: when the job exits, the shell reclaims the foreground.
    poll_foreground_until(shell_pid, "zsh");

    // Teardown: close reaps the shell; zsh reaped its own job at exit. NEITHER pid may linger.
    registry.close(id).expect("close the session");
    assert_no_zombie(shell_pid);
    assert_no_zombie(sleep_pid);
    pump.join().expect("the reader thread exits at EOF");
}

/// trmx-75: a pid `ps` has never heard of resolves to `None` — never a junk name, never a panic.
/// `u32::MAX` is far above macOS's pid ceiling (~99999), so it can never be a live process.
#[test]
fn foreground_process_is_none_for_an_unknown_pid() {
    assert!(foreground_process(u32::MAX).is_none());
}
