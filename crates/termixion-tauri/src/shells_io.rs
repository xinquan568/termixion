// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-205: installed-shell discovery (the `shells_list` command) + the impure executable
//! probe the spawn path shares. Curation logic is pure in `termixion_core::shells`; this module
//! supplies the real-filesystem inputs (`/etc/shells` content, the installed probe, the
//! canonicalizer) — the R1 split.

use serde::Serialize;
use termixion_core::shells::curated_shells;

/// One dropdown entry, serialized to the frontend as `{ id, label, path }`.
#[derive(Debug, Clone, Serialize)]
pub struct ShellEntry {
    pub id: String,
    pub label: String,
    pub path: String,
}

/// The impure validity probe (trmx-205): an absolute path to an existing regular file with any
/// executable bit set. `std::fs::metadata` follows symlinks, so a symlinked shell validates
/// against its target. This is the ONE probe both the spawn path and discovery use — the
/// executable-bit check needs `std::os::unix`, which is why it lives here, not in core (R2).
pub fn is_executable_file(path: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let p = std::path::Path::new(path);
    if !p.is_absolute() {
        return false;
    }
    match std::fs::metadata(p) {
        Ok(md) => md.is_file() && md.permissions().mode() & 0o111 != 0,
        Err(_) => false,
    }
}

/// The installed shells the settings dropdown offers (curated + deduplicated; see core::shells).
#[tauri::command]
pub fn shells_list() -> Vec<ShellEntry> {
    let etc = std::fs::read_to_string("/etc/shells").ok();
    curated_shells(etc.as_deref(), is_executable_file, |p| {
        std::fs::canonicalize(p)
            .ok()
            .map(|c| c.to_string_lossy().into_owned())
    })
    .into_iter()
    .map(|c| ShellEntry {
        id: c.id,
        label: c.label,
        path: c.path,
    })
    .collect()
}

/// trmx-206: the effective shell for UI gating — the SAME resolution the spawn uses
/// (configured shell when valid, else the $SHELL chain), so the settings gate and the spawn
/// gate can never drift.
#[derive(Debug, Clone, Serialize)]
pub struct EffectiveShell {
    pub path: String,
    pub kind: String,
}

#[tauri::command]
pub fn effective_shell(state: tauri::State<'_, crate::config_io::ConfigState>) -> EffectiveShell {
    let configured = crate::config_io::configured_shell(&state);
    let spec = termixion_core::SessionSpec::login_shell_configured(
        configured.map(std::ffi::OsString::from),
        is_executable_file,
    );
    let path = spec.program.to_string_lossy().into_owned();
    let kind = std::path::Path::new(&path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    EffectiveShell { path, kind }
}

#[cfg(test)]
mod tests {
    /// trmx-251: the section of the shared command-response golden this module owns.
    ///
    /// One file, asserted here and read verbatim by `app/e2e/fixtures/tauriFake.ts`. The fake
    /// answers the Playwright suite with these exact values, so a DTO whose serialization drifts
    /// breaks this assertion — and a fake that drifts from the file breaks the TypeScript test.
    /// Neither side can move alone, which a hand-written double could.
    fn golden_section(name: &str) -> serde_json::Value {
        let golden: serde_json::Value = serde_json::from_str(include_str!(
            "../tests/fixtures/command-responses-golden.json"
        ))
        .expect("the command-response golden parses");
        golden
            .get(name)
            .unwrap_or_else(|| panic!("the golden has a `{name}` section"))
            .clone()
    }

    #[test]
    fn shell_entry_and_effective_shell_match_the_shared_golden() {
        // Representative values, not a live probe: shells_list() reads the real filesystem, so its
        // CONTENT is machine-dependent while its SHAPE is the contract. serde decides the field
        // names either way, which is what the fake and the frontend depend on.
        let entries = vec![
            ShellEntry {
                id: "system".to_string(),
                label: "System default".to_string(),
                path: String::new(),
            },
            ShellEntry {
                id: "/bin/zsh".to_string(),
                label: "zsh".to_string(),
                path: "/bin/zsh".to_string(),
            },
        ];
        assert_eq!(
            serde_json::to_value(&entries).expect("Vec<ShellEntry> serializes"),
            golden_section("shellsList"),
            "shells_list's wire shape drifted from the shared golden"
        );

        let effective = EffectiveShell {
            path: "/bin/zsh".to_string(),
            kind: "configured".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&effective).expect("EffectiveShell serializes"),
            golden_section("effectiveShell"),
            "effective_shell's wire shape drifted from the shared golden"
        );
    }

    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn probe_accepts_only_absolute_executable_regular_files() {
        let dir = std::env::temp_dir().join(format!("trmx205-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exec = dir.join("shellish");
        let plain = dir.join("datafile");
        std::fs::write(&exec, "#!/bin/sh\n").unwrap();
        std::fs::write(&plain, "not a shell").unwrap();
        std::fs::set_permissions(&exec, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o644)).unwrap();

        assert!(is_executable_file(exec.to_str().unwrap()));
        assert!(!is_executable_file(plain.to_str().unwrap())); // no exec bit
        assert!(!is_executable_file(dir.to_str().unwrap())); // a directory
        assert!(!is_executable_file("relative/shellish")); // not absolute
        assert!(!is_executable_file(dir.join("missing").to_str().unwrap()));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn probe_follows_symlinks_to_the_target() {
        let dir = std::env::temp_dir().join(format!("trmx205-symlink-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("real-shell");
        std::fs::write(&target, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        let link = dir.join("linked-shell");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let dangling = dir.join("dangling");
        std::os::unix::fs::symlink(dir.join("gone"), &dangling).unwrap();

        assert!(is_executable_file(link.to_str().unwrap()));
        assert!(!is_executable_file(dangling.to_str().unwrap()));

        std::fs::remove_dir_all(&dir).ok();
    }
}
