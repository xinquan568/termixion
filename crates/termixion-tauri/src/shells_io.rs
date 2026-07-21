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
