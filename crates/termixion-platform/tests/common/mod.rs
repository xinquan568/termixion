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

use termixion_core::zdotdir::{
    ENV_AUTOSUGGEST, ENV_HIGHLIGHT, ENV_ORIG_ZDOTDIR, ENV_PLUGINS_DIR, ENV_PROMPT,
    ENV_STARSHIP_BIN, shim_files,
};
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

/// Ambient variables scrubbed from the inherited environment by [`run_zsh`] (trmx-230).
///
/// The criterion is **assertion-relevant and not already pinned by the fixture** — deliberately not
/// "everything the shim or the probes touch". `PROMPT` and `RPROMPT` are read by [`PROMPT_PROBE`]
/// but are absent here on purpose: the test that asserts on them sets both in its own `.zshrc`, so
/// the fixture already determines them. Adding names that cannot change an assertion would grow the
/// list without making any test more deterministic.
///
/// Two sources feed it:
///
/// * **the shim's control contract** — the `termixion_core::zdotdir::ENV_*` constants, named
///   symbolically so renaming one breaks the build here rather than silently un-scrubbing it.
/// * **variables a probe expands** — `TERMIXION_TEST_RC` and `ZSH_HIGHLIGHT_VERSION`
///   ([`STATUS_PROBE`]) and `STARSHIP_SHELL` ([`PROMPT_PROBE`]); an ambient value forges a result
///   with no shim involvement at all.
///
/// Two entries are deliberately redundant rather than load-bearing. `ENV_PLUGINS_DIR` is always
/// overwritten by `run_zsh`, and `STARSHIP_SESSION_KEY` is read by nothing here — it is scrubbed
/// because starship exports it alongside `STARSHIP_SHELL`, and leaving half a pair behind invites a
/// confusing partial leak later.
///
/// Listing a name a caller also passes through `extra_env` is harmless: `spec.env` wins over
/// `env_remove` by construction (pinned in `tests/spec_env_remove.rs`), so `ENV_ORIG_ZDOTDIR` is
/// scrubbed for the tests that omit it and honored for the tests that supply it.
const CONTAMINABLE: &[&str] = &[
    ENV_ORIG_ZDOTDIR,
    ENV_AUTOSUGGEST,
    ENV_HIGHLIGHT,
    ENV_PLUGINS_DIR,
    ENV_PROMPT,
    ENV_STARSHIP_BIN,
    "STARSHIP_SHELL",
    "STARSHIP_SESSION_KEY",
    "TERMIXION_TEST_RC",
    "ZSH_HIGHLIGHT_VERSION",
];

/// Spawn an interactive zsh through the shim, run `probe`, return the full output.
pub fn run_zsh(
    fixture: &Fixture,
    extra_env: &[(&str, &str)],
    enable_flags: bool,
    probe: &str,
) -> String {
    let mut spec = SessionSpec::shell("/bin/zsh");
    spec.cwd = Some(fixture.home.clone());
    for key in CONTAMINABLE {
        spec.env_remove.push((*key).into());
    }
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

pub const PROMPT_PROBE: &str = r##"print -r -- "P|prompt=${PROMPT-none}|rprompt=${RPROMPT-none}|pure=$+functions[prompt_pure_setup]|p10k=$+functions[p10k]|ss=${STARSHIP_SHELL-none}""##;

pub fn parse_prompt_status(output: &str) -> Option<String> {
    // ZLE redraw escapes can prefix the probe line (pure's multi-line prompt), so find the
    // marker ANYWHERE in a line, not just at line start.
    output
        .lines()
        .filter_map(|line| line.find("P|prompt=").map(|i| line[i..].to_string()))
        .next_back()
}
