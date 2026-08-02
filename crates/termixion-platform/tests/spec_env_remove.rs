// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-230: `SessionSpec::env_remove` at the seam. Three properties in one child probe, because
// they only mean anything together:
//
//   1. a variable INHERITED by the spawning process and named in `env_remove` is absent in the child
//      (the point of the affordance — `env` alone can only add or overwrite);
//   2. a name in BOTH `env_remove` and `env` arrives with the `env` value (the precedence contract:
//      removal scrubs the inherited environment, explicit entries still win);
//   3. inherited `PATH` still reaches the child — `env_remove` must stay surgical. `env_clear` would
//      satisfy (1) and break this; `spec_env_is_layered_onto_child` in src/unix.rs pins the same
//      invariant from the other side.
//
// Like tests/zdotdir_env_leak.rs, the inherited state is established by re-execing this test binary
// with `Command::env` rather than by mutating this process's environment: libtest runs each `#[test]`
// on a spawned thread even at --test-threads=1, so `std::env::set_var` would be unsound here.
#![cfg(unix)]

use std::process::Command;
use std::time::Duration;

use termixion_core::{PtySize, Session, SessionSpec};
use termixion_platform::UnixPtyFactory;

/// Scrubbed, and not re-supplied — must be absent in the child.
const SCRUBBED: &str = "TRMX230_SCRUBBED";
/// Scrubbed AND supplied via `spec.env` — the explicit value must win.
const OVERRIDDEN: &str = "TRMX230_OVERRIDDEN";

const INHERITED_VALUE: &str = "from-the-parent";
const EXPLICIT_VALUE: &str = "from-the-spec";

#[test]
#[ignore = "runs only in the re-exec'd child of env_remove_scrubs_inherited_but_yields_to_spec_env"]
fn inner_env_remove_contract() {
    for key in [SCRUBBED, OVERRIDDEN] {
        assert_eq!(
            std::env::var(key).ok().as_deref(),
            Some(INHERITED_VALUE),
            "harness error: {key} must be inherited for this test to mean anything"
        );
    }
    assert!(
        std::env::var_os("PATH").is_some(),
        "harness error: the parent needs a PATH to prove it survives"
    );

    let mut spec = SessionSpec::shell("/bin/sh");
    spec.env_remove.push(SCRUBBED.into());
    spec.env_remove.push(OVERRIDDEN.into());
    spec.env.push((OVERRIDDEN.into(), EXPLICIT_VALUE.into()));

    let factory = UnixPtyFactory;
    let mut session = Session::spawn(1, &factory, &spec, PtySize::new(24, 100)).expect("spawn sh");
    session
        .write(
            format!(
                "printf 'R|scrubbed=[%s]|overridden=[%s]|path=%s\\n' \
                 \"${{{SCRUBBED}-UNSET}}\" \"${{{OVERRIDDEN}-UNSET}}\" \
                 \"$([ -n \"$PATH\" ] && echo yes || echo no)\"; exit\n"
            )
            .as_bytes(),
        )
        .expect("write probe");

    let mut output = Vec::new();
    let mut buf = [0u8; 2048];
    loop {
        match session.read(&mut buf).expect("read") {
            0 => break,
            n => {
                output.extend_from_slice(&buf[..n]);
                if output.len() > (1 << 20) {
                    break;
                }
            }
        }
    }
    session.kill().expect("kill idempotent");
    std::thread::sleep(Duration::from_millis(50));

    let text = String::from_utf8_lossy(&output);
    // The LAST R| line is the child's expansion; earlier ones can be the PTY echo of the command.
    let line = text
        .lines()
        .filter_map(|line| line.find("R|scrubbed=").map(|i| line[i..].to_string()))
        .next_back()
        .unwrap_or_else(|| panic!("no probe line in {text:?}"));

    assert!(
        line.contains("|scrubbed=[UNSET]|"),
        "env_remove must scrub an INHERITED variable: {line}"
    );
    assert!(
        line.contains(&format!("|overridden=[{EXPLICIT_VALUE}]|")),
        "an explicit spec.env entry must win over env_remove: {line}"
    );
    assert!(
        line.contains("|path=yes"),
        "env_remove must stay surgical — inherited PATH must survive: {line}"
    );
}

#[test]
fn env_remove_scrubs_inherited_but_yields_to_spec_env() {
    let exe = std::env::current_exe().expect("current test binary");
    let out = Command::new(&exe)
        .args([
            "--exact",
            "inner_env_remove_contract",
            "--ignored",
            "--nocapture",
        ])
        .env(SCRUBBED, INHERITED_VALUE)
        .env(OVERRIDDEN, INHERITED_VALUE)
        .output()
        .expect("re-exec the test binary");

    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    // Guard against a vacuous pass if a libtest CLI change filtered everything out.
    assert!(
        stdout.contains("1 passed") || stdout.contains("1 failed"),
        "expected the child to run exactly one test; stdout:\n{stdout}\nstderr:\n{stderr}"
    );
    assert!(
        out.status.success(),
        "SessionSpec::env_remove contract violated\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
}
