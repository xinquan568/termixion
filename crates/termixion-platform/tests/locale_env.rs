// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-145 (reopened): a spec-carried `LANG` must reach the spawned shell. The core policy
// (`SessionSpec::login_shell` forcing `LANG=en_US.UTF-8` onto a locale-less environment) is
// unit-tested string-level in `termixion-core`; this golden test proves the delivery half —
// `spec.env` → `CommandBuilder::env` → a real PTY child sees the value — because a locale that
// never reaches the child would leave the C-locale ZLE mangling (the reopened trmx-145 symptom)
// in place with every unit test green. Env-delivery only, by design: asserting actual ZLE
// rendering would depend on the host having the locale *installed*, which non-macOS CI may not.
// Same conventions as `session_lifecycle.rs`: rc-free `zsh -f` (dev/CI rc hooks must never run
// here), a read-to-EOF loop, and the `ps -o stat=` no-zombie teardown check.
#![cfg(unix)]

use std::process::Command;
use std::time::Duration;

use termixion_core::{PtySize, Session, SessionSpec};
use termixion_platform::UnixPtyFactory;

/// `ps -o stat=` process state — `None` once the pid is reaped and gone (see
/// `session_lifecycle.rs` for why state, not existence, is what must be checked).
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
            None => return, // reaped & gone — the only pass
            Some(state) => {
                last_state = Some(state);
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
    let state = last_state.unwrap_or_default();
    panic!("child pid {pid} still present after teardown (state {state})");
}

#[test]
fn spec_env_lang_reaches_the_spawned_shell() {
    let factory = UnixPtyFactory;
    // Deterministic rc-free shell + the exact env entry the trmx-145 core policy emits.
    let mut spec = SessionSpec::shell("/bin/zsh");
    spec.args.push("-f".into());
    spec.env.push(("LANG".into(), "en_US.UTF-8".into()));

    let mut session = Session::spawn(1, &factory, &spec, PtySize::new(24, 80))
        .expect("spawn an rc-free shell with a spec-carried LANG");
    let pid = session.process_id().expect("a real PTY has a child pid");

    // The typed source is `${LANG}` inside brackets — the expected output line
    // `LANG=[en_US.UTF-8]` can only come from the CHILD expanding its environment, never from
    // the PTY echoing the command text back.
    session
        .write(b"print -r -- \"LANG=[${LANG}]\"; exit\n")
        .expect("write to the pty");

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
        text.contains("LANG=[en_US.UTF-8]"),
        "expected the child shell to see the spec-carried LANG; got: {text:?}"
    );

    session
        .kill()
        .expect("kill is idempotent on an exited child");
    assert_no_zombie(pid);
}
