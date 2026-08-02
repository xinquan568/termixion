// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// Shared fixture for the real-PTY shell tests in this crate (trmx-206, trmx-230): a hermetic temp
// $HOME + materialized ZDOTDIR shim, the zsh spawn helper, and the status probe/parser.
//
// This lives in `tests/common/` rather than being duplicated per test target because the fixture's
// HERMETICITY is itself load-bearing (trmx-230): the spawned shell must observe a known environment,
// not the developer's. Two copies would mean the next hermeticity fix has to be applied twice --
// which is exactly the bug trmx-230 fixed.
//
// A `tests/common/` subdirectory is not compiled as its own test binary; each test target that
// declares `mod common;` compiles its own copy, so items one target does not use are dead_code there.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use termixion_core::zdotdir::{ENV_AUTOSUGGEST, ENV_HIGHLIGHT, ENV_PLUGINS_DIR, shim_files};
use termixion_core::{PtySize, Session, SessionSpec};
use termixion_platform::UnixPtyFactory;

pub fn process_state(pid: u32) -> Option<String> {
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

pub fn assert_no_zombie(pid: u32) {
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
    panic!(
        "child pid {pid} still present after teardown (state {})",
        last_state.unwrap_or_default()
    );
}

/// The vendored plugin trees, straight from the repo (no tauri dependency).
pub fn plugins_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../resources/shell-enhancements")
}

/// One hermetic fixture: a temp root with `home/` and the materialized shim dir.
pub struct Fixture {
    pub root: PathBuf,
    pub home: PathBuf,
    pub shim: PathBuf,
}

pub fn fixture(name: &str) -> Fixture {
    let root = std::env::temp_dir().join(format!("trmx206-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let home = root.join("home");
    let shim = root.join("zdotdir");
    std::fs::create_dir_all(&home).expect("home");
    std::fs::create_dir_all(&shim).expect("shim");
    for (file, content) in shim_files() {
        std::fs::write(shim.join(file), content).expect("shim file");
    }
    Fixture { root, home, shim }
}

/// Spawn an interactive zsh through the shim, run `probe`, return the full output.
pub fn run_zsh(
    fixture: &Fixture,
    extra_env: &[(&str, &str)],
    enable_flags: bool,
    probe: &str,
) -> String {
    let mut spec = SessionSpec::shell("/bin/zsh");
    spec.cwd = Some(fixture.home.clone());
    spec.env
        .push(("HOME".into(), fixture.home.clone().into_os_string()));
    spec.env
        .push(("ZDOTDIR".into(), fixture.shim.clone().into_os_string()));
    spec.env
        .push((ENV_PLUGINS_DIR.into(), plugins_dir().into_os_string()));
    if enable_flags {
        spec.env.push((ENV_AUTOSUGGEST.into(), "1".into()));
        spec.env.push((ENV_HIGHLIGHT.into(), "1".into()));
    }
    for (key, value) in extra_env {
        spec.env.push(((*key).into(), (*value).into()));
    }

    let factory = UnixPtyFactory;
    let mut session =
        Session::spawn(1, &factory, &spec, PtySize::new(24, 100)).expect("spawn zsh via shim");
    let pid = session.process_id().expect("pid");
    session
        .write(format!("{probe}; exit\n").as_bytes())
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
    assert_no_zombie(pid);
    String::from_utf8_lossy(&output).into_owned()
}

pub const STATUS_PROBE: &str = r#"print -r -- "S|rc=${TERMIXION_TEST_RC-none}|as=$+functions[_zsh_autosuggest_fetch]|hl=${ZSH_HIGHLIGHT_VERSION:-none}|zd=${ZDOTDIR-UNSET}""#;

pub fn parse_status(output: &str) -> Option<String> {
    // The LAST S| line is the child's expansion (earlier ones can be PTY echo of the command).
    output
        .lines()
        .rfind(|line| line.starts_with("S|rc="))
        .map(str::to_string)
}
