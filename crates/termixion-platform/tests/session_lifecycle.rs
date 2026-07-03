// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// C-1 acceptance: the full core `Session` lifecycle driven through the trait against a real macOS
// PTY — spawn the login shell, resize, write, read back, tear down with no zombie. macOS-only (the
// whole file compiles away elsewhere), since it uses the `termixion-platform` macOS backend.
#![cfg(target_os = "macos")]

use std::process::Command;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use termixion_core::{PtySize, Session, SessionSpec};
use termixion_platform::MacosPtyFactory;

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
    // The only failure is a *persistent zombie* (`Z…`). Reaped-and-gone or pid-reused-by-a-live-process
    // both pass. Reaping is synchronous in teardown, so this normally passes on the first check; the
    // bounded retry only lets an in-flight reap settle.
    for _ in 0..40 {
        match process_state(pid) {
            None => return,                                           // reaped & gone
            Some(state) if !state.starts_with('Z') => return, // pid reused by a live process
            Some(_) => std::thread::sleep(Duration::from_millis(50)), // zombie — wait for the reap
        }
    }
    panic!("child pid {pid} was left as a zombie after teardown");
}

#[test]
fn session_lifecycle_through_the_trait_leaves_no_zombie() {
    let factory = MacosPtyFactory;
    // A deterministic, rc-free interactive shell. A golden integration test must NOT source the
    // developer's / CI's shell rc files: they run prompt/precmd hooks (often git-aware ones) that
    // misbehave when this very test runs inside a `git push` pre-push hook. `zsh -f` (NO_RCS) skips
    // all startup files. The login-shell *resolver* (`SessionSpec::login_shell`) is unit-tested
    // separately in `termixion-core`; here we only need a real PTY + a shell that runs our command.
    let mut spec = SessionSpec::shell("/bin/zsh");
    spec.args.push("-f".into());
    let mut session = Session::spawn(1, &factory, &spec, PtySize::new(24, 80))
        .expect("spawn an rc-free shell through the trait");

    // A real PTY exposes the child pid; capture it now (while alive) for the no-zombie check.
    let pid = session.process_id().expect("a real PTY has a child pid");
    assert!(session.is_alive());

    // resize is part of the lifecycle.
    session
        .resize(PtySize::new(40, 120))
        .expect("resize the live pty");
    assert_eq!(session.size(), PtySize::new(40, 120));

    // Write a command whose OUTPUT is "hello" but whose SOURCE text is not — `hel""lo` concatenates
    // to `hello`, so the literal "hello" can only come from the shell *executing* echo, not from the
    // PTY echoing the typed line. `; exit` makes the shell close, giving us a clean EOF (no hang).
    session
        .write(b"echo hel\"\"lo; exit\n")
        .expect("write to the pty");

    // Read to EOF (the shell exited): accumulate everything the child produced.
    let mut output = Vec::new();
    let mut buf = [0u8; 1024];
    loop {
        match session.read(&mut buf).expect("read from the pty") {
            0 => break, // EOF — the shell exited
            n => {
                output.extend_from_slice(&buf[..n]);
                if output.len() > (1 << 20) {
                    break; // hang guard; teardown below still reaps
                }
            }
        }
    }
    let text = String::from_utf8_lossy(&output);
    assert!(
        text.contains("hello"),
        "expected the shell to execute `echo` and emit 'hello'; got: {text:?}"
    );

    // Teardown: idempotent kill (the child already exited at EOF) marks the session not-alive.
    session
        .kill()
        .expect("kill is idempotent on an exited child");
    assert!(!session.is_alive());

    // The whole point of C-1: teardown left no zombie.
    assert_no_zombie(pid);
}

/// trmx-67: a resize must be observed by the **child**, not just recorded in our bookkeeping. The
/// lifecycle test above asserts `session.size()` after `.resize()` — our own remembered number —
/// but never proves the winsize reached the kernel side of the PTY. `stty size` asks the tty ioctl
/// for the child's winsize, so a `40 120` line in the output can only mean the resize actually
/// landed on the PTY (the spawn size was 24×80, and the echoed command text contains no digits).
#[test]
fn resize_winsize_is_observed_by_the_child() {
    let factory = MacosPtyFactory;
    // The same deterministic, rc-free interactive shell as the lifecycle test (see the rationale
    // there): `zsh -f` (NO_RCS) skips all startup files, so a dev/CI rc hook can never garble or
    // hang this golden test.
    let mut spec = SessionSpec::shell("/bin/zsh");
    spec.args.push("-f".into());
    let mut session = Session::spawn(2, &factory, &spec, PtySize::new(24, 80))
        .expect("spawn an rc-free shell through the trait");
    let pid = session.process_id().expect("a real PTY has a child pid");
    assert!(session.is_alive());

    session
        .resize(PtySize::new(40, 120))
        .expect("resize the live pty");

    // Reads block until data or EOF (the `PtyBackend` contract), so an in-test read loop could
    // hang past any deadline if broken plumbing produced no further output. Keep the wait bounded
    // like `assert_no_zombie`: move the blocking reader onto its own thread — the ADR-0001 split
    // `take_reader` exists for exactly this — and receive chunks over a channel with a deadline.
    let mut reader = session.take_reader().expect("a real PTY yields a reader");
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

    // Ask the CHILD for its winsize; `stty size` prints "<rows> <cols>" straight from the ioctl.
    session.write(b"stty size\n").expect("write to the pty");

    // Read-until the child reports the post-resize winsize. The deadline is generous — it only
    // matters when the plumbing is actually broken, and a loaded CI box must not flake a green pin.
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut transcript = Vec::new();
    while !String::from_utf8_lossy(&transcript).contains("40 120") {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            panic!(
                "child never reported the resized winsize `40 120` via `stty size`; transcript: {:?}",
                String::from_utf8_lossy(&transcript)
            );
        }
        match rx.recv_timeout(remaining) {
            Ok(chunk) => transcript.extend_from_slice(&chunk),
            // Timeout, or the pump ended early (EOF / read error — the shell died under us).
            Err(err) => panic!(
                "pty output ended before `stty size` reported `40 120` ({err}); transcript: {:?}",
                String::from_utf8_lossy(&transcript)
            ),
        }
    }

    // Teardown: kill the live shell (SIGKILL + reap). That closes the PTY, so the pump thread sees
    // EOF and exits — the join cannot hang — and the C-1 no-zombie invariant holds here too.
    session.kill().expect("kill the live shell");
    assert!(!session.is_alive());
    pump.join().expect("the reader thread exits at EOF");
    assert_no_zombie(pid);
}
