// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-206: the ZDOTDIR shim — PURE generation of the zsh startup files Termixion points a
//! session at (via `ZDOTDIR` in `SessionSpec.env`) to layer the bundled enhancements
//! (zsh-autosuggestions, zsh-syntax-highlighting) over the user's own configuration WITHOUT
//! ever editing a user file. The tauri layer owns the impure halves (embedding, materialization,
//! spawn gating); this module owns the content and the Rust↔shim env-var contract, so the two
//! sides can never drift.
//!
//! The dance (zsh re-evaluates `ZDOTDIR` between startup files):
//!   1. `.zshenv` CAPTURES the shim dir + the user's original state ("set to X" vs "unset" —
//!      distinct states a nested shell must see faithfully), RESTORES that state while
//!      forwarding to the user's real `.zshenv`, ADOPTS any mutation their `.zshenv` made (in
//!      both directions: set/changed AND unset), then RE-PINS `ZDOTDIR` to the shim so zsh still
//!      reads the shim's remaining startup files.
//!   2. `.zshrc` RESTORES the (possibly adopted) user state BEFORE sourcing the user's real
//!      `.zshrc` — their rc and any nested zsh see their own world — then LAYERS the plugins,
//!      each behind a double-load guard and a per-session `TERMIXION_*` flag;
//!      zsh-syntax-highlighting is sourced LAST (its documented requirement).
//!   3. `.zprofile` forwards with the same restore/re-pin sandwich (login shells only — not
//!      Termixion's hot path); `.zlogin`/`.zlogout` run after `.zshrc`'s restoration, so they
//!      forward from `${ZDOTDIR:-$HOME}`, which IS the user target by then.

/// Bump when any generated content changes — the tauri materializer keys its refresh on this.
pub const SHIM_VERSION: &str = "1";

/// Spawn → shim: the user's original `ZDOTDIR` value; ABSENT means "originally unset" (the
/// spawn sets it only when the app process actually inherited a value).
pub const ENV_ORIG_ZDOTDIR: &str = "TERMIXION_ORIG_ZDOTDIR";
/// Spawn → shim: `"1"` enables the autosuggestions layer for this session.
pub const ENV_AUTOSUGGEST: &str = "TERMIXION_ENH_AUTOSUGGEST";
/// Spawn → shim: `"1"` enables the syntax-highlighting layer for this session.
pub const ENV_HIGHLIGHT: &str = "TERMIXION_ENH_HIGHLIGHT";
/// Spawn → shim: the materialized plugins root (`…/plugins`), version-pinned per spawn.
pub const ENV_PLUGINS_DIR: &str = "TERMIXION_ENH_PLUGINS_DIR";

fn header(file: &str) -> String {
    format!(
        "# Termixion ZDOTDIR shim v{SHIM_VERSION} — {file} (trmx-206). GENERATED — do not edit.\n\
         # Forwards to your own zsh startup files and layers the bundled enhancements on top.\n\
         # Termixion never edits your files; disable under Settings → Terminal → Shell enhancements.\n"
    )
}

fn zshenv() -> String {
    format!(
        "{header}\
_termixion_shim_dir=\"$ZDOTDIR\"\n\
if [[ -n \"${{{orig}+x}}\" ]]; then\n\
  _termixion_user_zdotdir=\"${{{orig}}}\"\n\
  _termixion_orig_set=1\n\
else\n\
  _termixion_user_zdotdir=\"$HOME\"\n\
  _termixion_orig_set=0\n\
fi\n\
# Restore the user's own view while THEIR .zshenv runs.\n\
if (( _termixion_orig_set )); then\n\
  export ZDOTDIR=\"$_termixion_user_zdotdir\"\n\
else\n\
  unset ZDOTDIR\n\
fi\n\
if [[ -r \"$_termixion_user_zdotdir/.zshenv\" ]]; then\n\
  source \"$_termixion_user_zdotdir/.zshenv\"\n\
fi\n\
# Adopt any mutation their .zshenv made — in BOTH directions (set/changed vs unset).\n\
if [[ -n \"${{ZDOTDIR+x}}\" ]]; then\n\
  _termixion_user_zdotdir=\"$ZDOTDIR\"\n\
  _termixion_orig_set=1\n\
else\n\
  _termixion_user_zdotdir=\"$HOME\"\n\
  _termixion_orig_set=0\n\
fi\n\
# Re-pin so zsh reads the SHIM's remaining startup files.\n\
export ZDOTDIR=\"$_termixion_shim_dir\"\n",
        header = header(".zshenv"),
        orig = ENV_ORIG_ZDOTDIR,
    )
}

fn zshrc() -> String {
    format!(
        "{header}\
# Restore the user's original ZDOTDIR state BEFORE their rc runs: their config and any nested\n\
# zsh see their own world (an originally-unset ZDOTDIR stays unset).\n\
if (( _termixion_orig_set )); then\n\
  export ZDOTDIR=\"$_termixion_user_zdotdir\"\n\
else\n\
  unset ZDOTDIR\n\
fi\n\
if [[ -r \"$_termixion_user_zdotdir/.zshrc\" ]]; then\n\
  source \"$_termixion_user_zdotdir/.zshrc\"\n\
fi\n\
# Layer the bundled enhancements. The guards make an already-loaded plugin a no-op, so a\n\
# setup that sources either plugin itself (oh-my-zsh etc.) double-loads nothing.\n\
if [[ \"${{{auto}}}\" == \"1\" ]] && (( ! $+functions[_zsh_autosuggest_start] )); then\n\
  if [[ -r \"${{{plugins}}}/zsh-autosuggestions/zsh-autosuggestions.zsh\" ]]; then\n\
    source \"${{{plugins}}}/zsh-autosuggestions/zsh-autosuggestions.zsh\"\n\
  fi\n\
fi\n\
# zsh-syntax-highlighting MUST be sourced last (its documented requirement) — keep this the\n\
# final layering block in this file.\n\
if [[ \"${{{hl}}}\" == \"1\" ]] && [[ -z \"$ZSH_HIGHLIGHT_VERSION\" ]]; then\n\
  if [[ -r \"${{{plugins}}}/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh\" ]]; then\n\
    source \"${{{plugins}}}/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh\"\n\
  fi\n\
fi\n\
unset _termixion_shim_dir _termixion_user_zdotdir _termixion_orig_set\n",
        header = header(".zshrc"),
        auto = ENV_AUTOSUGGEST,
        hl = ENV_HIGHLIGHT,
        plugins = ENV_PLUGINS_DIR,
    )
}

fn zprofile() -> String {
    format!(
        "{header}\
# Login shells only (Termixion spawns interactive non-login today). Same restore/re-pin\n\
# sandwich as .zshenv: the user's .zprofile runs in their own world.\n\
if (( _termixion_orig_set )); then\n\
  export ZDOTDIR=\"$_termixion_user_zdotdir\"\n\
else\n\
  unset ZDOTDIR\n\
fi\n\
if [[ -r \"$_termixion_user_zdotdir/.zprofile\" ]]; then\n\
  source \"$_termixion_user_zdotdir/.zprofile\"\n\
fi\n\
export ZDOTDIR=\"$_termixion_shim_dir\"\n",
        header = header(".zprofile"),
    )
}

fn post_rc_forwarder(file: &str) -> String {
    format!(
        "{header}\
# Runs AFTER .zshrc restored the user's ZDOTDIR state — ${{ZDOTDIR:-$HOME}} IS the user target.\n\
if [[ -r \"${{ZDOTDIR:-$HOME}}/{file}\" ]]; then\n\
  source \"${{ZDOTDIR:-$HOME}}/{file}\"\n\
fi\n",
        header = header(file),
    )
}

/// Every startup file the shim directory carries, as `(file name, content)` pairs.
pub fn shim_files() -> Vec<(&'static str, String)> {
    vec![
        (".zshenv", zshenv()),
        (".zshrc", zshrc()),
        (".zprofile", zprofile()),
        (".zlogin", post_rc_forwarder(".zlogin")),
        (".zlogout", post_rc_forwarder(".zlogout")),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str) -> String {
        shim_files()
            .into_iter()
            .find(|(n, _)| *n == name)
            .map(|(_, c)| c)
            .expect("file exists")
    }

    #[test]
    fn every_startup_file_is_generated_with_the_version_header() {
        let files = shim_files();
        let names: Vec<_> = files.iter().map(|(n, _)| *n).collect();
        assert_eq!(
            names,
            [".zshenv", ".zshrc", ".zprofile", ".zlogin", ".zlogout"]
        );
        for (name, content) in &files {
            assert!(
                content.contains(&format!("shim v{SHIM_VERSION}")),
                "{name} missing the version marker"
            );
            assert!(
                content.contains("GENERATED"),
                "{name} missing the generated notice"
            );
        }
    }

    #[test]
    fn zshenv_captures_restores_adopts_both_directions_and_repins() {
        let env = file(".zshenv");
        // Capture: the shim dir is saved from the entry ZDOTDIR before anything else.
        let capture = env
            .find("_termixion_shim_dir=\"$ZDOTDIR\"")
            .expect("captures shim dir");
        // Original state is derived from the spawn contract var, distinguishing set from unset.
        assert!(env.contains(&format!("${{{ENV_ORIG_ZDOTDIR}+x}}")));
        assert!(env.contains("_termixion_orig_set=1"));
        assert!(env.contains("_termixion_orig_set=0"));
        // Restore-or-unset happens BEFORE the user's .zshenv is sourced.
        let restore = env.find("unset ZDOTDIR").expect("has the unset branch");
        let forward = env.find("/.zshenv\"").expect("forwards the user's .zshenv");
        assert!(capture < restore && restore < forward);
        // Adoption in BOTH directions after the forward: a set check AND an unset fallback.
        let adopt = env.rfind("${ZDOTDIR+x}").expect("adopts mutation");
        assert!(forward < adopt);
        let unset_fallback = env.rfind("_termixion_orig_set=0").expect("unset adoption");
        assert!(
            adopt < unset_fallback
                || env
                    .rfind("_termixion_user_zdotdir=\"$HOME\"")
                    .expect("home fallback")
                    > adopt
        );
        // Re-pin is the LAST action so the shim's .zshrc still runs.
        let repin = env
            .rfind("export ZDOTDIR=\"$_termixion_shim_dir\"")
            .expect("re-pins");
        assert!(adopt < repin);
        assert!(
            env.trim_end()
                .ends_with("export ZDOTDIR=\"$_termixion_shim_dir\"")
        );
    }

    #[test]
    fn zshrc_restores_before_user_rc_then_layers_with_guards_highlighting_last() {
        let rc = file(".zshrc");
        let restore_set = rc
            .find("export ZDOTDIR=\"$_termixion_user_zdotdir\"")
            .expect("restore");
        let restore_unset = rc.find("unset ZDOTDIR").expect("unset branch");
        let user_rc = rc.find("/.zshrc\"").expect("sources user rc");
        assert!(restore_set < user_rc && restore_unset < user_rc);
        // Guards: autosuggestions skips when already loaded; highlighting when version is set.
        assert!(rc.contains("$+functions[_zsh_autosuggest_start]"));
        assert!(rc.contains("-z \"$ZSH_HIGHLIGHT_VERSION\""));
        // Flags gate each layer through the contract vars.
        assert!(
            rc.contains(ENV_AUTOSUGGEST)
                && rc.contains(ENV_HIGHLIGHT)
                && rc.contains(ENV_PLUGINS_DIR)
        );
        // Order: user rc → autosuggestions → highlighting; highlighting is the LAST source.
        let auto = rc.find("zsh-autosuggestions.zsh").expect("autosuggestions");
        let hl = rc
            .find("zsh-syntax-highlighting.zsh")
            .expect("highlighting");
        assert!(user_rc < auto && auto < hl);
        let last_source = rc.rfind("source ").expect("has sources");
        assert!(rc[last_source..].contains("zsh-syntax-highlighting"));
    }

    #[test]
    fn forwarders_target_the_user_files_never_the_shim() {
        let profile = file(".zprofile");
        assert!(profile.contains("/.zprofile\""));
        assert!(profile.contains("export ZDOTDIR=\"$_termixion_shim_dir\"")); // re-pins after
        for name in [".zlogin", ".zlogout"] {
            let content = file(name);
            // Post-rc forwarders use the restored state — never a hard-coded $HOME-only path.
            assert!(content.contains(&format!("${{ZDOTDIR:-$HOME}}/{name}")));
            assert!(!content.contains("_termixion_shim_dir")); // no shim references remain
        }
    }

    #[test]
    fn env_contract_names_are_the_single_source_of_truth() {
        // The drift guard: every TERMIXION_* occurrence in generated content is one of the
        // exported constants (a renamed constant that misses the content — or vice versa —
        // fails here).
        let known = [
            ENV_ORIG_ZDOTDIR,
            ENV_AUTOSUGGEST,
            ENV_HIGHLIGHT,
            ENV_PLUGINS_DIR,
        ];
        for (name, content) in shim_files() {
            for (index, _) in content.match_indices("TERMIXION_") {
                let tail = &content[index..];
                assert!(
                    known.iter().any(|k| tail.starts_with(k)),
                    "{name}: unknown TERMIXION_* var at byte {index}"
                );
            }
        }
    }
}
