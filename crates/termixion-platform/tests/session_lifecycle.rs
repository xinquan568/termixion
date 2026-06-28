// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// C-1 acceptance: the full core `Session` lifecycle driven through the trait against a real macOS
// PTY — spawn the login shell, resize, write, read back, tear down with no zombie. macOS-only (the
// whole file compiles away elsewhere), since it uses the `termixion-platform` macOS backend.
#![cfg(target_os = "macos")]

use std::process::Command;
use std::time::Duration;

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
