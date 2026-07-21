// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-205: the configured-shell precedence is unit-tested string-level in `termixion-core`;
// this golden test proves the delivery half — a spec built by
// `SessionSpec::login_shell_configured(Some(/bin/bash), …)` really spawns BASH in a live PTY
// (asserted via `$BASH_VERSION`, which only bash defines). Hermetic per the house conventions:
// `HOME` points at a temp dir through `spec.env` so the developer/CI rc files never run
// (interactive non-login bash would otherwise source `~/.bashrc`), plus the read-to-EOF loop and
// the `ps -o stat=` no-zombie teardown from `session_lifecycle.rs`.
#![cfg(unix)]

use std::process::Command;
use std::time::Duration;

use termixion_core::{PtySize, Session, SessionSpec};
use termixion_platform::UnixPtyFactory;

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
fn a_configured_bash_actually_spawns_bash() {
    let factory = UnixPtyFactory;

    // The production entry: a valid configured shell wins over $SHELL. The validity probe is the
    // real question the tauri layer answers; here /bin/bash trivially exists on macOS/CI.
    let mut spec = SessionSpec::login_shell_configured(Some("/bin/bash".into()), |path| {
        std::path::Path::new(path).is_file()
    });
    assert_eq!(spec.program, std::ffi::OsString::from("/bin/bash"));

    // Hermetic home: interactive bash sources ~/.bashrc — point HOME at an empty temp dir so a
    // developer/CI rc (with its git hooks) can never run inside this test (house convention).
    let home = std::env::temp_dir().join(format!("trmx205-home-{}", std::process::id()));
    std::fs::create_dir_all(&home).expect("temp home");
    spec.env
        .push(("HOME".into(), home.clone().into_os_string()));
    spec.cwd = Some(home.clone());

    let mut session = Session::spawn(1, &factory, &spec, PtySize::new(24, 80))
        .expect("spawn the configured bash");
    let pid = session.process_id().expect("a real PTY has a child pid");

    // `$BASH_VERSION` is defined only by bash — a zsh/sh child would print `B:[]`. The bracketed
    // expansion comes from the CHILD, never from PTY echo of the command text.
    session
        .write(b"echo \"B:[${BASH_VERSION}]\"; exit\n")
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
    let spawned_bash = text
        .lines()
        .any(|line| line.contains("B:[") && !line.contains("B:[]") && !line.contains("${"));
    assert!(
        spawned_bash,
        "expected a bash child to expand $BASH_VERSION; got: {text:?}"
    );

    session
        .kill()
        .expect("kill is idempotent on an exited child");
    assert_no_zombie(pid);
    std::fs::remove_dir_all(&home).ok();
}
