// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-146: the CLI-query contract, end-to-end against the REAL binary. Each spawn carries a hard
// timeout: the failure mode under test is precisely "the flag fell through to a full GUI launch
// and the process never exits", which must surface as a clean assertion, not a hung CI job. (The
// "no window / no updater side effects" half is structural — the fork returns before the Tauri
// builder — and the packaged-app manual checklist covers the rest, same split as trmx-145.)
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Spawn the termixion binary with `args`; return (exit code, stdout, stderr). Kills and panics
/// if the process is still alive after 10 s — a CLI query must exit immediately.
fn run_cli(args: &[&str]) -> (i32, String, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_termixion"))
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn termixion");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait().expect("try_wait") {
            Some(status) => {
                let mut out = String::new();
                let mut err = String::new();
                child
                    .stdout
                    .take()
                    .expect("stdout piped")
                    .read_to_string(&mut out)
                    .expect("read stdout");
                child
                    .stderr
                    .take()
                    .expect("stderr piped")
                    .read_to_string(&mut err)
                    .expect("read stderr");
                return (status.code().unwrap_or(-1), out, err);
            }
            None if Instant::now() > deadline => {
                let _ = child.kill();
                panic!(
                    "termixion {args:?} did not exit within 10s — did the CLI query fall through to a GUI launch?"
                );
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

#[test]
fn version_prints_one_line_and_exits_zero() {
    for spelling in [&["--version"][..], &["-V"][..]] {
        let (code, out, err) = run_cli(spelling);
        assert_eq!(code, 0, "{spelling:?} stderr: {err}");
        assert!(err.is_empty(), "{spelling:?} wrote to stderr: {err}");
        let line = out.trim_end();
        assert_eq!(line, format!("termixion {}", env!("CARGO_PKG_VERSION")));
        assert!(!line.contains('\n'), "version output is exactly one line");
    }
}

#[test]
fn help_prints_usage_and_exits_zero() {
    for spelling in [&["--help"][..], &["-h"][..]] {
        let (code, out, err) = run_cli(spelling);
        assert_eq!(code, 0, "{spelling:?} stderr: {err}");
        assert!(err.is_empty(), "{spelling:?} wrote to stderr: {err}");
        for needle in ["USAGE:", "ctl <command>", "--version", "internal"] {
            assert!(
                out.contains(needle),
                "{spelling:?} usage must mention {needle:?}; got:\n{out}"
            );
        }
        assert!(
            !out.contains("ctl --help"),
            "usage must not advertise nonexistent ctl --help"
        );
    }
}

#[test]
fn unknown_flag_prints_usage_to_stderr_and_exits_two() {
    let (code, out, err) = run_cli(&["--bogus"]);
    assert_eq!(code, 2);
    assert!(
        out.is_empty(),
        "rejection goes to stderr, stdout stays clean; got:\n{out}"
    );
    assert!(
        err.contains("--bogus"),
        "the offending flag is named; got:\n{err}"
    );
    assert!(
        err.contains("USAGE:"),
        "usage accompanies the rejection; got:\n{err}"
    );
}

#[test]
fn help_wins_even_next_to_an_unknown_flag() {
    // Precedence end-to-end: an answerable question gets its answer (plan §2).
    let (code, out, err) = run_cli(&["--bogus", "--help"]);
    assert_eq!(code, 0, "stderr: {err}");
    assert!(out.contains("USAGE:"));
}
