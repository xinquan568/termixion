// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-263 (grill A3) — the EQUIVALENCE test: the batched resolvers (`foreground_leaders`,
// `process_names` — one `ps -p a,b,c` each) agree with the per-pid ones (`is_busy`,
// `foreground_process` — one `ps` fork each) on the SAME live processes, through real PTYs.
// Six rc-free interactive shells: all idle (each is its own foreground leader), then two of them
// run `/bin/sleep` (the child's group takes the terminal), then one shell is killed and reaped
// while still listed (its row must simply be absent). Same conventions as `activity.rs`: `zsh -f`,
// a pump thread per reader, deadline polls as bounded liveness waits (never timing assertions),
// SIGINT to end the jobs before teardown, and `ps -o stat=` no-zombie hygiene on every pid.
// macOS-only (the whole file compiles away elsewhere).
#![cfg(unix)]

use std::process::Command;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use termixion_core::{PtyReader, PtySize, Session, SessionSpec};
use termixion_platform::{
    UnixPtyFactory, foreground_leaders, foreground_process, is_busy, process_names,
};

/// The process state of `pid` via `ps -o stat=` — `None` if the pid is gone (see `activity.rs`).
fn process_state(pid: u32) -> Option<String> {
    let out = Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let state = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if state.is_empty() { None } else { Some(state) }
}

/// A dead child must be REAPED AND GONE — poll until `ps` stops reporting the pid (the trmx-74
/// convention; rationale in `activity.rs`).
fn assert_no_zombie(pid: u32) {
    let mut last_state: Option<String> = None;
    for _ in 0..40 {
        match process_state(pid) {
            None => return,
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

/// The deterministic, rc-free interactive shell (`zsh -f`; job control on, so a foreground job
/// really does get its own process group — the mechanism both resolvers observe).
fn rc_free_zsh() -> SessionSpec {
    let mut spec = SessionSpec::shell("/bin/zsh");
    spec.args.push("-f".into());
    spec
}

/// Move the blocking [`PtyReader`] onto its own thread so the kernel PTY buffer never fills while
/// the test polls `ps`; exits at EOF / a torn-down PTY, so joining after `kill` cannot hang.
fn pump_reader(
    mut reader: Box<dyn PtyReader>,
) -> (mpsc::Receiver<Vec<u8>>, std::thread::JoinHandle<()>) {
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let pump = std::thread::spawn(move || {
        let mut buf = [0u8; 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    (rx, pump)
}

/// Deadline-poll `is_busy(shell_pid)` every ~100 ms until it equals `Some(want)` — a bounded
/// liveness wait on a real process, generous relative to the sub-second reality; never a timing
/// assertion.
fn poll_is_busy_until(shell_pid: u32, want: bool, deadline: Instant) -> Option<bool> {
    loop {
        let observed = is_busy(shell_pid);
        if observed == Some(want) || Instant::now() >= deadline {
            return observed;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

struct Shell {
    session: Session,
    pid: u32,
    _rx: mpsc::Receiver<Vec<u8>>,
    pump: std::thread::JoinHandle<()>,
}

fn spawn_shell(id: u64) -> Shell {
    let mut session = Session::spawn(id, &UnixPtyFactory, &rc_free_zsh(), PtySize::new(24, 80))
        .expect("spawn an rc-free shell through the trait");
    let pid = session.process_id().expect("a real PTY has a child pid");
    let reader = session.take_reader().expect("a real PTY yields a reader");
    let (rx, pump) = pump_reader(reader);
    Shell {
        session,
        pid,
        _rx: rx,
        pump,
    }
}

fn teardown(shell: Shell) -> u32 {
    let Shell {
        mut session,
        pid,
        _rx,
        pump,
    } = shell;
    session.kill().expect("kill the live shell");
    pump.join().expect("the reader thread exits at EOF");
    pid
}

#[test]
fn batched_resolution_agrees_with_the_per_pid_functions_on_real_shells() {
    let mut shells: Vec<Shell> = (1..=6).map(spawn_shell).collect();
    let pids: Vec<u32> = shells.iter().map(|s| s.pid).collect();

    // Phase 1 — all idle: every shell is its own foreground leader.
    for &pid in &pids {
        assert_eq!(
            poll_is_busy_until(pid, false, Instant::now() + Duration::from_secs(10)),
            Some(false),
            "shell {pid} must reach its prompt (idle) first"
        );
    }
    let leaders = foreground_leaders(&pids).expect("ps ran");
    assert_eq!(leaders.len(), 6, "one row per live shell: {leaders:?}");
    for &pid in &pids {
        assert_eq!(
            leaders[&pid],
            Some(pid),
            "idle shell {pid} is its own leader"
        );
        assert_eq!(is_busy(pid), Some(false), "…and is_busy agrees");
    }
    let names = process_names(&pids).expect("ps ran");
    for &pid in &pids {
        assert_eq!(
            names[&pid], "zsh",
            "an idle shell's leader name is the shell's"
        );
        assert_eq!(
            foreground_process(pid).map(|fg| fg.name),
            Some("zsh".to_string()),
            "…and foreground_process agrees"
        );
    }

    // Phase 2 — two shells run a job. `/bin/sleep` by absolute path: `zsh -f` skips rc files but
    // does not fix PATH, and the assertion below is on the resolved `comm` name.
    for shell in shells.iter_mut().take(2) {
        shell
            .session
            .write(b"/bin/sleep 30\n")
            .expect("write the job");
    }
    for &pid in pids.iter().take(2) {
        assert_eq!(
            poll_is_busy_until(pid, true, Instant::now() + Duration::from_secs(5)),
            Some(true),
            "shell {pid} must report busy while its job runs"
        );
    }
    let leaders = foreground_leaders(&pids).expect("ps ran");
    let mut job_pids = Vec::new();
    for (i, &pid) in pids.iter().enumerate() {
        let per_pid = foreground_process(pid).expect("per-pid resolution of a live shell");
        assert_eq!(
            leaders[&pid],
            Some(per_pid.pid),
            "batched leader of shell {pid} equals foreground_process's"
        );
        if i < 2 {
            assert_ne!(
                leaders[&pid],
                Some(pid),
                "a busy shell's leader is the job, not the shell"
            );
            job_pids.push(per_pid.pid);
        } else {
            assert_eq!(
                leaders[&pid],
                Some(pid),
                "an idle shell stays its own leader"
            );
        }
    }
    let job_names = process_names(&job_pids).expect("ps ran");
    for job in &job_pids {
        assert_eq!(job_names[job], "sleep", "the job's leader name, batched");
    }

    // Phase 3 — a dead pid in the list is simply absent; the live rows are unaffected.
    let dead = teardown(shells.pop().expect("six shells"));
    assert_no_zombie(dead);
    let leaders = foreground_leaders(&pids).expect("ps ran");
    assert!(
        !leaders.contains_key(&dead),
        "a reaped shell must have no row (ps omits it, exit 0)"
    );
    for &pid in pids.iter().take(5) {
        assert!(
            leaders.contains_key(&pid),
            "live shell {pid} still has a row"
        );
    }

    // Teardown: end the jobs (SIGINT to the foreground group), wait for idle, then kill the
    // shells — so no orphaned `sleep` outlives the test.
    for shell in shells.iter_mut().take(2) {
        shell.session.write(b"\x03").expect("interrupt the job");
    }
    for &pid in pids.iter().take(2) {
        assert_eq!(
            poll_is_busy_until(pid, false, Instant::now() + Duration::from_secs(5)),
            Some(false),
            "shell {pid} must return to its prompt after SIGINT"
        );
    }
    for job in &job_pids {
        assert_no_zombie(*job);
    }
    for shell in shells {
        let pid = teardown(shell);
        assert_no_zombie(pid);
    }
}
