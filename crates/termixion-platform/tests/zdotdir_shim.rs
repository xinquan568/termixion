// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-206: the ZDOTDIR-shim behavioral matrix — real zsh, real PTY, hermetic fixtures. The shim
// CONTENT is unit-pinned in termixion-core::zdotdir; these golden tests prove the mechanics in a
// live shell: the user's rc runs first, the plugins layer with working double-load guards, the
// user's original ZDOTDIR state survives (unset stays unset), a user `.zshenv` that mutates or
// unsets ZDOTDIR is honored, and disabled flags spawn plugin-free.
//
// Hermeticity per house convention: every spawn gets a temp $HOME (the developer's dotfiles must
// never run), the shim + vendored plugin trees are composed from the repo (core content fns +
// resources/shell-enhancements), and teardown asserts no zombie via `ps -o stat=`.
#![cfg(unix)]

mod common;

use common::{PROMPT_PROBE, STATUS_PROBE, fixture, parse_prompt_status, parse_status, run_zsh};
use termixion_core::zdotdir::{ENV_ORIG_ZDOTDIR, ENV_PROMPT, ENV_STARSHIP_BIN};

#[test]
fn fresh_home_runs_user_rc_first_and_activates_both_plugins() {
    let fx = fixture("fresh");
    std::fs::write(fx.home.join(".zshrc"), "TERMIXION_TEST_RC=ran\n").unwrap();
    let out = run_zsh(&fx, &[], true, STATUS_PROBE);
    let status = parse_status(&out).unwrap_or_else(|| panic!("no status in {out:?}"));
    assert!(status.contains("|rc=ran|"), "user rc must run: {status}");
    assert!(
        status.contains("|as=1|"),
        "autosuggestions active: {status}"
    );
    assert!(
        !status.contains("|hl=none|"),
        "highlighting active: {status}"
    );
    assert!(
        status.ends_with("|zd=UNSET"),
        "original unset state restored: {status}"
    );
    std::fs::remove_dir_all(&fx.root).ok();
}

#[test]
fn preloaded_plugins_skip_the_shim_layers() {
    let fx = fixture("preloaded");
    // The fixture rc mimics an oh-my-zsh-style setup that already loaded both plugins: the
    // guards must skip — the sentinel version survives and the REAL autosuggestions plugin
    // (which would define _zsh_autosuggest_fetch) is never sourced.
    std::fs::write(
        fx.home.join(".zshrc"),
        "TERMIXION_TEST_RC=ran\nZSH_HIGHLIGHT_VERSION=preloaded\n_zsh_autosuggest_start() { : }\n",
    )
    .unwrap();
    let out = run_zsh(&fx, &[], true, STATUS_PROBE);
    let status = parse_status(&out).expect("status");
    assert!(status.contains("|rc=ran|"));
    assert!(
        status.contains("|as=0|"),
        "guard skipped the real plugin: {status}"
    );
    assert!(
        status.contains("|hl=preloaded|"),
        "sentinel version survives: {status}"
    );
    std::fs::remove_dir_all(&fx.root).ok();
}

#[test]
fn user_zdotdir_is_forwarded_and_restored() {
    let fx = fixture("userzdot");
    let user_zdot = fx.root.join("user-zdot");
    std::fs::create_dir_all(&user_zdot).unwrap();
    std::fs::write(
        user_zdot.join(".zshrc"),
        "TERMIXION_TEST_RC=from-user-zdot\n",
    )
    .unwrap();
    let user_zdot_str = user_zdot.to_string_lossy().into_owned();
    let out = run_zsh(
        &fx,
        &[(ENV_ORIG_ZDOTDIR, user_zdot_str.as_str())],
        true,
        STATUS_PROBE,
    );
    let status = parse_status(&out).expect("status");
    assert!(
        status.contains("|rc=from-user-zdot|"),
        "their ZDOTDIR rc ran: {status}"
    );
    assert!(
        status.ends_with(&format!("|zd={user_zdot_str}")),
        "their ZDOTDIR value restored: {status}"
    );
    std::fs::remove_dir_all(&fx.root).ok();
}

#[test]
fn user_zshenv_mutating_zdotdir_is_adopted() {
    let fx = fixture("mutate");
    let alt = fx.root.join("alt-zdot");
    std::fs::create_dir_all(&alt).unwrap();
    std::fs::write(alt.join(".zshrc"), "TERMIXION_TEST_RC=from-alt\n").unwrap();
    std::fs::write(
        fx.home.join(".zshenv"),
        format!("export ZDOTDIR=\"{}\"\n", alt.display()),
    )
    .unwrap();
    let out = run_zsh(&fx, &[], true, STATUS_PROBE);
    let status = parse_status(&out).expect("status");
    assert!(
        status.contains("|rc=from-alt|"),
        "the mutated target's rc ran: {status}"
    );
    assert!(
        status.contains("|as=1|"),
        "shim still layered (was not skipped): {status}"
    );
    assert!(
        status.ends_with(&format!("|zd={}", alt.display())),
        "mutated value is the session's ZDOTDIR: {status}"
    );
    std::fs::remove_dir_all(&fx.root).ok();
}

#[test]
fn user_zshenv_unsetting_zdotdir_is_adopted_too() {
    let fx = fixture("unset");
    let orig = fx.root.join("orig-zdot");
    std::fs::create_dir_all(&orig).unwrap();
    // Their .zshenv (in their original ZDOTDIR) unsets it — the user target becomes $HOME.
    std::fs::write(orig.join(".zshenv"), "unset ZDOTDIR\n").unwrap();
    std::fs::write(fx.home.join(".zshrc"), "TERMIXION_TEST_RC=home-rc\n").unwrap();
    let orig_str = orig.to_string_lossy().into_owned();
    let out = run_zsh(
        &fx,
        &[(ENV_ORIG_ZDOTDIR, orig_str.as_str())],
        true,
        STATUS_PROBE,
    );
    let status = parse_status(&out).expect("status");
    assert!(
        status.contains("|rc=home-rc|"),
        "$HOME rc becomes the target: {status}"
    );
    assert!(
        status.contains("|as=1|"),
        "shim still reached its .zshrc: {status}"
    );
    assert!(
        status.ends_with("|zd=UNSET"),
        "the unset choice sticks: {status}"
    );
    std::fs::remove_dir_all(&fx.root).ok();
}

#[test]
fn disabled_flags_spawn_plugin_free_with_rc_intact() {
    let fx = fixture("flagsoff");
    std::fs::write(fx.home.join(".zshrc"), "TERMIXION_TEST_RC=ran\n").unwrap();
    let out = run_zsh(&fx, &[], false, STATUS_PROBE);
    let status = parse_status(&out).expect("status");
    assert!(status.contains("|rc=ran|"));
    assert!(status.contains("|as=0|"), "no autosuggestions: {status}");
    assert!(status.contains("|hl=none|"), "no highlighting: {status}");
    std::fs::remove_dir_all(&fx.root).ok();
}

#[test]
fn nested_zsh_sees_the_original_unset_state() {
    let fx = fixture("nested");
    std::fs::write(fx.home.join(".zshrc"), "TERMIXION_TEST_RC=ran\n").unwrap();
    // A nested interactive zsh inherits the session env; because .zshrc restored (unset) the
    // original state before anything user-visible runs, the child gets NO ZDOTDIR and reads
    // $HOME/.zshrc — the shim never re-enters.
    let probe =
        r#"print -r -- "N|inner=$(ZDOTDIR_PROBE=1 /bin/zsh -c 'print -r -- ${ZDOTDIR-UNSET}')""#;
    let out = run_zsh(&fx, &[], true, probe);
    let line = out
        .lines()
        .rfind(|line| line.starts_with("N|inner="))
        .expect("nested probe line");
    assert!(
        line.ends_with("inner=UNSET"),
        "nested shell sees unset: {line}"
    );
    std::fs::remove_dir_all(&fx.root).ok();
}

// ---------------------------------------------------------------------------------------------
// trmx-207: the prompt selector matrix — the shim's prompt block in live zsh.
// ---------------------------------------------------------------------------------------------

#[test]
fn existing_prompt_stays_byte_identical_with_no_prompt_env() {
    let fx = fixture("prompt-existing");
    std::fs::write(
        fx.home.join(".zshrc"),
        "PROMPT='MARKER> '\nRPROMPT='RMARK'\n",
    )
    .unwrap();
    // No ENV_PROMPT / ENV_STARSHIP_BIN passed — the default "existing" path.
    let out = run_zsh(&fx, &[], true, PROMPT_PROBE);
    let status = parse_prompt_status(&out).expect("status");
    assert!(
        status.contains("|prompt=MARKER> |"),
        "PROMPT untouched: {status}"
    );
    assert!(
        status.contains("|rprompt=RMARK|"),
        "RPROMPT untouched: {status}"
    );
    assert!(status.contains("|pure=0|") && status.contains("|p10k=0|"));
    assert!(status.ends_with("|ss=none"), "no starship env: {status}");
    std::fs::remove_dir_all(&fx.root).ok();
}

#[test]
fn pure_prompt_activates_from_the_vendored_tree() {
    let fx = fixture("prompt-pure");
    std::fs::write(fx.home.join(".zshrc"), "TERMIXION_TEST_RC=ran\n").unwrap();
    // Pure's PROMPT is multi-line — embedding it in a probe splits the output, so probe ONLY
    // the setup-function marker.
    let probe = r##"print -r -- "PU|pure=$+functions[prompt_pure_setup]""##;
    let out = run_zsh(&fx, &[(ENV_PROMPT, "pure")], true, probe);
    let line = out
        .lines()
        .filter_map(|line| line.find("PU|pure=").map(|i| line[i..].to_string()))
        .next_back()
        .expect("status");
    assert!(line.contains("PU|pure=1"), "pure initialized: {line}");
    std::fs::remove_dir_all(&fx.root).ok();
}

#[test]
fn powerlevel10k_activates_without_wizard_or_network_cache() {
    let fx = fixture("prompt-p10k");
    std::fs::write(fx.home.join(".zshrc"), "TERMIXION_TEST_RC=ran\n").unwrap();
    let out = run_zsh(&fx, &[(ENV_PROMPT, "powerlevel10k")], true, PROMPT_PROBE);
    let status = parse_prompt_status(&out).expect("status");
    assert!(status.contains("|p10k=1|"), "p10k initialized: {status}");
    assert!(
        !out.contains("configuration wizard"),
        "wizard must never launch: {out:?}"
    );
    assert!(
        !fx.home.join(".cache/gitstatus").exists(),
        "no gitstatus download/cache"
    );
    std::fs::remove_dir_all(&fx.root).ok();
}

#[test]
fn adversarial_p10k_user_config_cannot_reopen_gitstatus() {
    let fx = fixture("prompt-p10k-adv");
    std::fs::write(fx.home.join(".zshrc"), "TERMIXION_TEST_RC=ran\n").unwrap();
    // A user ~/.p10k.zsh that tries to re-enable gitstatus/auto-install: the shim re-asserts
    // the no-network switches AFTER sourcing it.
    std::fs::write(
        fx.home.join(".p10k.zsh"),
        "typeset -g POWERLEVEL9K_DISABLE_GITSTATUS=false\ntypeset -g GITSTATUS_AUTO_INSTALL=1\n",
    )
    .unwrap();
    let probe = r##"print -r -- "A|p10k=$+functions[p10k]|dg=${POWERLEVEL9K_DISABLE_GITSTATUS-unset}|ai=${GITSTATUS_AUTO_INSTALL-unset}""##;
    let out = run_zsh(&fx, &[(ENV_PROMPT, "powerlevel10k")], true, probe);
    let line = out
        .lines()
        .filter_map(|line| line.find("A|p10k=").map(|i| line[i..].to_string()))
        .next_back()
        .expect("status");
    assert!(line.contains("|p10k=1|"), "{line}");
    assert!(
        line.contains("|dg=true|"),
        "gitstatus stays disabled: {line}"
    );
    assert!(line.ends_with("|ai=0"), "auto-install stays off: {line}");
    assert!(!fx.home.join(".cache/gitstatus").exists());
    assert!(!out.contains("configuration wizard"));
    std::fs::remove_dir_all(&fx.root).ok();
}

#[test]
fn starship_initializes_via_the_provided_binary_when_available() {
    // Uses the machine's starship (the resolver's dev/test fallback tier) — skipped
    // gracefully where absent (CI variance); the sidecar path is the bundling story.
    let Some(starship) = ["/opt/homebrew/bin/starship", "/usr/local/bin/starship"]
        .iter()
        .find(|p| std::path::Path::new(p).is_file())
    else {
        eprintln!("skipping: no starship binary on this machine");
        return;
    };
    let fx = fixture("prompt-starship");
    std::fs::write(fx.home.join(".zshrc"), "TERMIXION_TEST_RC=ran\n").unwrap();
    let out = run_zsh(
        &fx,
        &[(ENV_PROMPT, "starship"), (ENV_STARSHIP_BIN, starship)],
        true,
        PROMPT_PROBE,
    );
    let status = parse_prompt_status(&out).expect("status");
    assert!(
        status.contains("|ss=zsh"),
        "STARSHIP_SHELL set by init: {status}"
    );
    std::fs::remove_dir_all(&fx.root).ok();
}

#[test]
fn starship_double_init_guard_never_executes_the_binary() {
    // Round-2 F4: a session whose rc already initialized starship (STARSHIP_SHELL set) must
    // skip the shim's init WITHOUT executing the provided binary — proven by a fake starship
    // that would drop a marker file if invoked.
    let fx = fixture("prompt-starship-guard");
    let marker = fx.root.join("invoked-marker");
    let fake = fx.root.join("fake-starship");
    std::fs::write(
        &fake,
        format!(
            "#!/bin/sh\ntouch {}\necho 'init zsh output'\n",
            marker.display()
        ),
    )
    .unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    std::fs::write(
        fx.home.join(".zshrc"),
        "export STARSHIP_SHELL=preexisting\n",
    )
    .unwrap();
    let fake_str = fake.to_string_lossy().into_owned();
    let probe = r##"print -r -- "G|ss=${STARSHIP_SHELL-none}""##;
    let out = run_zsh(
        &fx,
        &[
            (ENV_PROMPT, "starship"),
            (ENV_STARSHIP_BIN, fake_str.as_str()),
        ],
        true,
        probe,
    );
    let line = out
        .lines()
        .filter_map(|line| line.find("G|ss=").map(|i| line[i..].to_string()))
        .next_back()
        .expect("status");
    assert!(
        line.ends_with("ss=preexisting"),
        "guard preserved the value: {line}"
    );
    assert!(
        !marker.exists(),
        "the binary must never run when STARSHIP_SHELL is set"
    );
    std::fs::remove_dir_all(&fx.root).ok();
}
