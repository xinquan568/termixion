// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
//! trmx-99 (FR-7b): the "Reveal snippets" affordance for OSC 133 shell integration. The zsh/bash
//! snippets ship EMBEDDED in the binary (`include_str!` from `resources/shell-integration/`); the reveal
//! command writes them to `~/.config/termixion/shell-integration/` and opens that folder in Finder, so a
//! user can `source` them from their rc file. We deliberately do NOT edit rc files (the conservative,
//! documented install — see docs/activity-indicator.md). Thin glue over `std::fs` + the opener plugin;
//! the same XDG base as scripts_io/themes_io, then `termixion/shell-integration`.

use std::path::{Path, PathBuf};

use tauri_plugin_opener::OpenerExt;

/// The embedded snippet sources (the single source of truth is `resources/shell-integration/`).
const ZSH_SNIPPET: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../resources/shell-integration/termixion.zsh"
));
const BASH_SNIPPET: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../resources/shell-integration/termixion.bash"
));

/// `$XDG_CONFIG_HOME` wins; otherwise `<home>/.config`, then `termixion/shell-integration`.
pub fn shell_integration_dir_from(xdg_config_home: Option<&str>, home: &str) -> PathBuf {
    let base = match xdg_config_home.filter(|dir| !dir.is_empty()) {
        Some(xdg) => PathBuf::from(xdg),
        None => Path::new(home).join(".config"),
    };
    base.join("termixion").join("shell-integration")
}

/// The real shell-integration directory, from the process environment.
pub fn shell_integration_dir() -> PathBuf {
    let xdg = std::env::var("XDG_CONFIG_HOME").ok();
    let home = std::env::var("HOME").unwrap_or_default();
    shell_integration_dir_from(xdg.as_deref(), &home)
}

/// Write the two snippets into `dir` (overwriting — the binary is the source of truth). Pure over the
/// path so it is unit-testable with a tempdir.
pub fn write_snippets(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("could not create {}: {error}", dir.display()))?;
    std::fs::write(dir.join("termixion.zsh"), ZSH_SNIPPET)
        .map_err(|error| format!("could not write termixion.zsh: {error}"))?;
    std::fs::write(dir.join("termixion.bash"), BASH_SNIPPET)
        .map_err(|error| format!("could not write termixion.bash: {error}"))?;
    Ok(())
}

/// Write the snippets to the user's config dir and reveal the folder in Finder.
#[tauri::command]
pub fn shell_integration_reveal(app: tauri::AppHandle) -> Result<(), String> {
    let dir = shell_integration_dir();
    write_snippets(&dir)?;
    app.opener()
        .open_path(dir.display().to_string(), None::<&str>)
        .map_err(|error| format!("could not open {}: {error}", dir.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_uses_xdg_then_home_default() {
        assert_eq!(
            shell_integration_dir_from(Some("/x/cfg"), "/home/u"),
            PathBuf::from("/x/cfg/termixion/shell-integration")
        );
        assert_eq!(
            shell_integration_dir_from(None, "/home/u"),
            PathBuf::from("/home/u/.config/termixion/shell-integration")
        );
        assert_eq!(
            shell_integration_dir_from(Some(""), "/home/u"), // empty XDG → home default
            PathBuf::from("/home/u/.config/termixion/shell-integration")
        );
    }

    #[test]
    fn write_snippets_creates_both_files_with_the_markers() {
        let dir = std::env::temp_dir().join(format!("trmx99-{}", std::process::id()));
        write_snippets(&dir).expect("write");
        let zsh = std::fs::read_to_string(dir.join("termixion.zsh")).expect("zsh");
        let bash = std::fs::read_to_string(dir.join("termixion.bash")).expect("bash");
        assert!(zsh.contains("133;C") && zsh.contains("__termixion_precmd"));
        assert!(bash.contains("133;C") && bash.contains("PROMPT_COMMAND"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
