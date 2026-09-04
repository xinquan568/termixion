// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-263 (grill A3) — a MEASUREMENT, not a test: the poller's steady-state foreground-resolution
// work per four-tick cycle, the per-pid way (`is_busy` every iteration + `foreground_process` on the
// 4th: 6N forks) versus the batched way (`foreground_leaders` every iteration + `process_names` on the
// 4th: 5 forks), against N REAL interactive shells through real PTYs, for N = 1, 10, 50, 100. It
// prints a markdown table and asserts only STRUCTURE (both maps have N entries) — never wall time
// (trmx-250: a timing assertion is a flake waiting for a loaded runner). Ignored by default; run it
// explicitly and read the numbers:
//
//   cargo test -p termixion-platform --test poller_cost -- --ignored --nocapture
//
// The wall cycle is the work plus the loop's four 250 ms post-work sleeps (`poller.rs`), so it is
// reported as `work + 1000 ms` — exact for a steady state with no rises. Rise enrichment (two forks
// per busy→idle→busy flip) is event-driven and not part of this table. macOS-only, like the
// `ps -p` contract it measures.
#![cfg(target_os = "macos")]

use std::collections::BTreeSet;
use std::process::Command;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use termixion_core::{PtyReader, PtySize, Session, SessionSpec};
use termixion_platform::{
    UnixPtyFactory, foreground_leaders, foreground_process, is_busy, process_names,
};

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
    panic!("child pid {pid} not reaped after teardown (state {state})");
}

fn rc_free_zsh() -> SessionSpec {
    let mut spec = SessionSpec::shell("/bin/zsh");
    spec.args.push("-f".into());
    spec
}

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

fn poll_is_busy_until(shell_pid: u32, want: bool, deadline: Instant) -> Option<bool> {
    loop {
        let observed = is_busy(shell_pid);
        if observed == Some(want) || Instant::now() >= deadline {
            return observed;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// 100 PTY sessions need ~300 descriptors; a GitHub macOS runner's default soft limit is 256.
/// Raise the soft limit to `min(hard, 4096)` and report what we got; [`fits_fd_limit`] then skips
/// any N the limit cannot hold, printing the decision, so the run measures the largest reachable
/// N instead of failing mid-spawn.
fn raise_fd_limit() -> u64 {
    // SAFETY: `getrlimit`/`setrlimit` take a pointer to a plain `rlimit` struct that lives for the
    // duration of the call; `RLIMIT_NOFILE` is a valid resource id on every unix.
    unsafe {
        let mut lim = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) != 0 {
            return 0;
        }
        let want = lim.rlim_max.min(4096);
        if lim.rlim_cur < want {
            lim.rlim_cur = want;
            let _ = libc::setrlimit(libc::RLIMIT_NOFILE, &lim);
        }
        let mut now = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut now) == 0 {
            now.rlim_cur
        } else {
            0
        }
    }
}

struct Shell {
    session: Session,
    pid: u32,
    _rx: mpsc::Receiver<Vec<u8>>,
    pump: std::thread::JoinHandle<()>,
}

fn spawn_shells(n: usize) -> Vec<Shell> {
    (1..=n as u64)
        .map(|id| {
            let mut session =
                Session::spawn(id, &UnixPtyFactory, &rc_free_zsh(), PtySize::new(24, 80))
                    .expect("spawn an rc-free shell");
            let pid = session.process_id().expect("child pid");
            let reader = session.take_reader().expect("reader");
            let (rx, pump) = pump_reader(reader);
            Shell {
                session,
                pid,
                _rx: rx,
                pump,
            }
        })
        .collect()
}

/// Each session costs roughly three descriptors (the PTY master, the reader's dup, the pump
/// channel's wakeup) plus the harness's own baseline; a margin of 64 covers cargo/test-runner fds.
fn fits_fd_limit(n: usize, limit: u64) -> bool {
    limit == 0 || (3 * n as u64 + 64) <= limit
}

fn median(mut xs: Vec<Duration>) -> Duration {
    xs.sort();
    xs[xs.len() / 2]
}

#[ignore = "measurement, not a test: run with --ignored --nocapture and read the table"]
#[test]
fn foreground_resolution_work_per_cycle_per_pid_vs_batched() {
    let fd_limit = raise_fd_limit();
    println!();
    println!(
        "poller foreground-resolution work per four-tick cycle (medians of 5); RLIMIT_NOFILE soft = {fd_limit}"
    );
    println!(
        "| N | today: 6N forks — work | today wall cycle (+1000 ms) | batched: 5 forks — work | batched wall cycle (+1000 ms) | per-fork (today work / 6N) |"
    );
    println!("|---|---|---|---|---|---|");
    for &n in &[1usize, 10, 50, 100] {
        if !fits_fd_limit(n, fd_limit) {
            println!(
                "| {n} | skipped: RLIMIT_NOFILE soft {fd_limit} cannot hold ~{} descriptors | | | | |",
                3 * n + 64
            );
            continue;
        }
        let mut shells = spawn_shells(n);
        let pids: Vec<u32> = shells.iter().map(|s| s.pid).collect();
        for &pid in &pids {
            assert_eq!(
                poll_is_busy_until(pid, false, Instant::now() + Duration::from_secs(10)),
                Some(false),
                "shell {pid} must reach its prompt before measuring"
            );
        }

        // Today's path: 4 activity iterations (is_busy per session) + 1 title pass
        // (foreground_process per session), as run_title_poller did before trmx-263.
        let mut today = Vec::new();
        for _ in 0..5 {
            let t0 = Instant::now();
            for _ in 0..4 {
                for &pid in &pids {
                    let _ = is_busy(pid);
                }
            }
            for &pid in &pids {
                let _ = foreground_process(pid);
            }
            today.push(t0.elapsed());
        }

        // The batched path: 4 × foreground_leaders(all) + 1 × process_names(distinct leaders).
        let mut batched = Vec::new();
        for _ in 0..5 {
            let t0 = Instant::now();
            let mut last = None;
            for _ in 0..4 {
                last = foreground_leaders(&pids);
            }
            let leaders = last.expect("ps ran");
            assert_eq!(leaders.len(), n, "one row per live shell");
            let distinct: Vec<u32> = leaders
                .values()
                .flatten()
                .copied()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            let names = process_names(&distinct).expect("ps ran");
            assert_eq!(
                names.len(),
                n,
                "idle shells are their own leaders: one name each"
            );
            batched.push(t0.elapsed());
        }

        let t = median(today);
        let b = median(batched);
        println!(
            "| {n} | {:.0} ms | {:.0} ms | {:.0} ms | {:.0} ms | {:.1} ms |",
            t.as_secs_f64() * 1000.0,
            t.as_secs_f64() * 1000.0 + 1000.0,
            b.as_secs_f64() * 1000.0,
            b.as_secs_f64() * 1000.0 + 1000.0,
            t.as_secs_f64() * 1000.0 / (6.0 * n as f64),
        );

        for shell in shells.drain(..) {
            let Shell {
                mut session,
                pid,
                _rx,
                pump,
            } = shell;
            session.kill().expect("kill the live shell");
            pump.join().expect("the reader thread exits at EOF");
            assert_no_zombie(pid);
        }
    }
}
