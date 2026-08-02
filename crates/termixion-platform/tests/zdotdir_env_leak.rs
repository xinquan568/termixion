// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-230: the shim fixture must observe the environment it declares, not the developer's. When
// Termixion is developed INSIDE Termixion (the likeliest way this project is used), the outer app
// exports TERMIXION_ENH_AUTOSUGGEST / TERMIXION_ENH_HIGHLIGHT / TERMIXION_PROMPT and starship adds
// STARSHIP_SHELL — so a "flags off" spawn inherited them and was never actually flags-off. CI cannot
// see this: its environment is clean, so the gate that should catch an env-sensitivity bug is
// precisely the one that is blind to it. This test supplies that missing coverage.
//
// HOW THE LEAK IS ESTABLISHED (and why not `std::env::set_var`): the contamination is INHERITANCE,
// so the variables must already be in the environment of the process that builds the SessionSpec.
// libtest runs every `#[test]` on a spawned thread even at --test-threads=1, so mutating this
// process's environment would be unsound however few tests the binary holds. Instead the outer test
// re-execs THIS test binary via `Command::env`, which sets the variables on the child only; the
// child then inherits them for real and runs the assertions.
#![cfg(unix)]

mod common;

use std::process::Command;

use common::{STATUS_PROBE, fixture, parse_status, run_zsh};

/// The variables an outer Termixion session leaks into a shell it launches, with the enhancement
/// settings on — the exact set from the trmx-230 reproduction.
const LEAKED: &[(&str, &str)] = &[
    ("TERMIXION_ENH_AUTOSUGGEST", "1"),
    ("TERMIXION_ENH_HIGHLIGHT", "1"),
    ("TERMIXION_PROMPT", "starship"),
    ("STARSHIP_SHELL", "zsh"),
    ("STARSHIP_SESSION_KEY", "2944062532246127"),
];

/// The assertions, run only in the re-exec'd child (hence `#[ignore]`): with every variable above
/// inherited, a flags-off spawn must still be plugin-free.
#[test]
#[ignore = "runs only in the re-exec'd child of flags_off_is_flags_off_under_a_leaking_parent_env"]
fn inner_flags_off_under_leaked_env() {
    for (key, _) in LEAKED {
        assert!(
            std::env::var_os(key).is_some(),
            "harness error: {key} must be inherited for this test to mean anything"
        );
    }

    let fx = fixture("envleak");
    std::fs::write(fx.home.join(".zshrc"), "TERMIXION_TEST_RC=ran\n").unwrap();
    let out = run_zsh(&fx, &[], false, STATUS_PROBE);
    let status = parse_status(&out).expect("status");

    assert!(status.contains("|rc=ran|"), "user rc still runs: {status}");
    assert!(
        status.contains("|as=0|"),
        "flags off must mean no autosuggestions even when the parent exports \
         TERMIXION_ENH_AUTOSUGGEST=1: {status}"
    );
    assert!(
        status.contains("|hl=none|"),
        "flags off must mean no highlighting even when the parent exports \
         TERMIXION_ENH_HIGHLIGHT=1: {status}"
    );
    std::fs::remove_dir_all(&fx.root).ok();
}

#[test]
fn flags_off_is_flags_off_under_a_leaking_parent_env() {
    let exe = std::env::current_exe().expect("current test binary");
    let mut cmd = Command::new(&exe);
    cmd.args([
        "--exact",
        "inner_flags_off_under_leaked_env",
        "--ignored",
        "--nocapture",
    ]);
    for (key, value) in LEAKED {
        cmd.env(key, value);
    }

    let out = cmd.output().expect("re-exec the test binary");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);

    // Guard against a silently-empty run: a libtest CLI change that filtered everything out would
    // otherwise exit 0 and make this test vacuous.
    assert!(
        stdout.contains("1 passed") || stdout.contains("1 failed"),
        "expected the child to run exactly one test; stdout:\n{stdout}\nstderr:\n{stderr}"
    );
    assert!(
        out.status.success(),
        "the flags-off spawn was contaminated by the parent environment\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
}
