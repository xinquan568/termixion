// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-159 (T1) golden test: `foreground_args` and `foreground_stdin_is_tty` observe a REAL
// foreground job through a real PTY. It runs `sleep 30` (stdin = the pty) — pinning that the argv
// TAIL is `["30"]` (argv[0] "sleep" excluded) and that stdin reads as a tty — then interrupts it
// and runs `sleep 30 </dev/null`, pinning that the redirected stdin reads as NOT a tty. Same
// conventions as `foreground.rs`: rc-free `zsh -f`, a pump thread on the blocking reader, deadline
// polls, and `ps -o stat=` no-zombie hygiene on EVERY captured pid. macOS is where the real impl
// lives; on other unix the helpers return `None` (the whole file still compiles).
#![cfg(unix)]

use std::process::Command;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use termixion_core::{PtyReader, PtySize, SessionRegistry, SessionSpec};
use termixion_platform::{
    ForegroundProcess, UnixPtyFactory, foreground_args, foreground_process, foreground_stdin_is_tty,
};

/// The process state of `pid` via `ps -o stat=` — `None` if the pid is gone, else the state string
/// (a leading `Z` means a zombie). We check the *zombie state* specifically, not mere existence,
/// because a freed pid can be reused by an unrelated process — a reused *live* process must not be
/// mistaken for our leak.
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
    // A dead child must be REAPED AND GONE — `ps` must stop reporting the pid. A persistent `Z…`
    // state is the classic zombie leak; a persistent *live* state is worse (the kill never landed)
    // and must fail just as loudly. The 2 s deadline only lets an in-flight reap settle.
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

/// The deterministic, rc-free interactive shell (see `foreground.rs`): `zsh -f` (NO_RCS) skips all
/// startup files, and interactive zsh enables job control so a foreground job gets its own process
/// group — the exact mechanism these helpers observe.
fn rc_free_zsh() -> SessionSpec {
    let mut spec = SessionSpec::shell("/bin/zsh");
    spec.args.push("-f".into());
    spec
}

/// Move the blocking [`PtyReader`] onto its own thread (ADR-0001), forwarding chunks over a channel
/// so the kernel PTY buffer never fills while the test polls. The pump exits at EOF or on a
/// torn-down PTY, so joining it after `close` cannot hang.
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
/// that observation. 50 ms steps under a generous 5 s window so a loaded CI box does not flake.
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

/// trmx-159 (T1): the two foreground-metadata helpers observed against a REAL registry-spawned PTY.
/// A `sleep 30` foreground job exposes its argv tail (`["30"]`, argv[0] excluded) and a tty stdin;
/// the same job with `</dev/null` exposes a NON-tty stdin. An unknown pid yields `None` from both.
/// Teardown leaves no zombie on any captured pid. macOS-only in effect: on other unix the helpers
/// return `None`, so this test's positive assertions are guarded behind `cfg(target_os = "macos")`.
#[cfg(target_os = "macos")]
#[test]
fn foreground_meta_reports_args_and_stdin_tty_through_a_real_pty() {
    let factory = UnixPtyFactory;
    let mut registry = SessionRegistry::new();
    let (id, reader) = registry
        .spawn(&factory, &rc_free_zsh(), PtySize::new(24, 80))
        .expect("spawn an rc-free shell through the registry");
    let shell_pid = registry
        .process_id(id)
        .expect("the session is live")
        .expect("a real PTY has a child pid");
    let (_rx, pump) = pump_reader(reader);

    // Settle at the prompt so the first job's foreground handoff is unambiguous.
    poll_foreground_until(shell_pid, "zsh");

    // Job 1 — `sleep 30` with the pty as stdin: capture the foreground leader (the sleep process,
    // its own process-group leader) and pin its metadata while it is demonstrably alive.
    registry.write(id, b"sleep 30\n").expect("write `sleep 30`");
    let job1 = poll_foreground_until(shell_pid, "sleep");
    let sleep_tty_pid = job1.pid;
    assert_ne!(
        sleep_tty_pid, shell_pid,
        "a foreground job runs in its own process group, not the shell's"
    );
    assert_eq!(
        foreground_args(sleep_tty_pid),
        Some(vec!["30".to_string()]),
        "the argv tail is the operands only — argv[0] \"sleep\" is excluded"
    );
    assert_eq!(
        foreground_stdin_is_tty(sleep_tty_pid),
        Some(true),
        "a job launched at the prompt inherits the shell's pty as stdin"
    );

    // Interrupt job 1 (Ctrl-C → SIGINT to the foreground group) and wait for zsh to reclaim the
    // terminal, so job 2's handoff is again unambiguous and job 1 is reaped before teardown.
    registry.write(id, &[0x03]).expect("write Ctrl-C");
    poll_foreground_until(shell_pid, "zsh");

    // Job 2 — `sleep 30 </dev/null`: the shell consumes the redirection, so sleep's argv tail is
    // unchanged (`["30"]`) but its stdin is `/dev/null`, a non-tty character device.
    registry
        .write(id, b"sleep 30 </dev/null\n")
        .expect("write `sleep 30 </dev/null`");
    let job2 = poll_foreground_until(shell_pid, "sleep");
    let sleep_null_pid = job2.pid;
    assert_eq!(
        foreground_args(sleep_null_pid),
        Some(vec!["30".to_string()]),
        "an stdin redirection is not part of argv"
    );
    assert_eq!(
        foreground_stdin_is_tty(sleep_null_pid),
        Some(false),
        "stdin redirected from /dev/null is a character device but NOT a tty"
    );

    // Unknown pid — far above the macOS pid ceiling — yields `None` from both helpers, never junk.
    assert!(foreground_args(u32::MAX).is_none());
    assert!(foreground_stdin_is_tty(u32::MAX).is_none());

    // Interrupt job 2, wait for the prompt, then close. No captured pid may linger.
    registry.write(id, &[0x03]).expect("write Ctrl-C");
    poll_foreground_until(shell_pid, "zsh");
    registry.close(id).expect("close the session");
    assert_no_zombie(shell_pid);
    assert_no_zombie(sleep_tty_pid);
    assert_no_zombie(sleep_null_pid);
    pump.join().expect("the reader thread exits at EOF");
}

/// trmx-159 (T1): a pid the kernel has never heard of resolves to `None` from both helpers on any
/// unix (the non-macOS stubs also return `None`) — never a junk value, never a panic. `u32::MAX`
/// is far above the macOS pid ceiling (~99999), so it can never name a live process.
#[test]
fn foreground_meta_is_none_for_an_unknown_pid() {
    assert!(foreground_args(u32::MAX).is_none());
    assert!(foreground_stdin_is_tty(u32::MAX).is_none());
}
