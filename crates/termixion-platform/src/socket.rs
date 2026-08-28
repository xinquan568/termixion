// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-239 (M12): the Unix uid/mode primitives behind the R1 seam.
//!
//! These moved out of `termixion-tauri`'s `control.rs`, which declared `libc` directly and called
//! `unsafe { libc::geteuid() }` — a direct contradiction of R1, which names `termixion-platform` as
//! the home for platform crates and uid/mode checks. The shell keeps the POLICY CHOICE (which
//! directory rule applies to which socket-path origin, and the control protocol around the
//! listener); this module owns the platform mechanics: the effective uid, the two directory
//! guarantees, and creating a `0600` socket in a private parent.
//!
//! Note the boundary is about the KIND of logic, not which primitive it happens to call:
//! [`create_socket_at`] reaches for `std::os::unix` rather than `libc`, but enforcing
//! `0600` on a security-sensitive node is platform mode policy either way.

use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;

/// The current effective uid.
pub fn current_euid() -> u32 {
    // SAFETY: `geteuid` is always safe — it takes no arguments, reads process credentials, and
    // cannot fail (POSIX specifies no error conditions).
    unsafe { libc::geteuid() }
}

/// DEFAULT-path policy: ensure `dir` is a private, current-uid-owned directory with mode `0700`.
/// Creates it if absent; if it EXISTS as a real directory we own, TIGHTENS it to `0700` (so a
/// `0755` config dir created by another subsystem still yields a private socket dir); rejects a
/// symlink, a non-directory, or a foreign-owned directory rather than trusting/loosening it.
pub fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(dir) {
        Ok(md) => {
            let ft = md.file_type();
            if ft.is_symlink() {
                return Err(format!("{} is a symlink; refusing", dir.display()));
            }
            if !ft.is_dir() {
                return Err(format!("{} is not a directory", dir.display()));
            }
            let euid = current_euid();
            if md.uid() != euid {
                return Err(format!(
                    "{} is owned by uid {} (not {euid}); refusing",
                    dir.display(),
                    md.uid()
                ));
            }
            // We own it → tighten to 0700 (drops any group/world bits).
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| format!("could not chmod {}: {e}", dir.display()))
        }
        Err(_) => {
            std::fs::create_dir_all(dir)
                .map_err(|e| format!("could not create {}: {e}", dir.display()))?;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| format!("could not chmod {}: {e}", dir.display()))
        }
    }
}

/// OVERRIDE-path policy (trmx-235 L12): `dir` must ALREADY be a real, current-uid-owned directory
/// with mode EXACTLY `0700`. Nothing is created and nothing is chmod-ed — a user-supplied socket
/// path under `$HOME` must never silently tighten `$HOME`.
pub fn require_private_dir(dir: &Path) -> Result<(), String> {
    let md = std::fs::symlink_metadata(dir).map_err(|e| {
        format!(
            "{} does not exist ({e}); a custom socket_path parent must be a private 0700 directory you own (it is never created or chmod-ed for you)",
            dir.display()
        )
    })?;
    let ft = md.file_type();
    if ft.is_symlink() {
        return Err(format!("{} is a symlink; refusing", dir.display()));
    }
    if !ft.is_dir() {
        return Err(format!("{} is not a directory", dir.display()));
    }
    let euid = current_euid();
    if md.uid() != euid {
        return Err(format!(
            "{} is owned by uid {} (not {euid}); refusing",
            dir.display(),
            md.uid()
        ));
    }
    let mode = md.mode() & 0o777;
    if mode != 0o700 {
        return Err(format!(
            "{} has mode {mode:04o}; a custom socket_path parent must be exactly 0700 (it is never chmod-ed for you)",
            dir.display()
        ));
    }
    Ok(())
}

/// Create + bind a non-blocking `0600` socket at `path`. Probe-before-unlink: a LIVE listener is
/// NOT clobbered (Err); a stale socket is reclaimed; a non-socket node is never touched. Binds
/// ONCE, so a race yields an Err rather than a re-clobber. The PARENT-directory guarantee is the
/// caller's to establish first (see [`ensure_private_dir`] / [`require_private_dir`]) — which of
/// the two applies is the shell's policy decision, not this module's.
pub fn create_socket_at(path: &Path) -> Result<UnixListener, String> {
    // Only ever touch a SOCKET node at `path`: never delete a regular file / symlink / directory a
    // misconfigured socket_path might point at.
    if let Ok(md) = std::fs::symlink_metadata(path) {
        if !md.file_type().is_socket() {
            return Err(format!(
                "{} exists and is not a socket; refusing to touch it",
                path.display()
            ));
        }
        if UnixStream::connect(path).is_ok() {
            return Err(format!(
                "{} is a live control socket (another instance?); not clobbering",
                path.display()
            ));
        }
        let _ = std::fs::remove_file(path); // a stale SOCKET — reclaim
    }
    let listener =
        UnixListener::bind(path).map_err(|e| format!("bind {} failed: {e}", path.display()))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("could not chmod {}: {e}", path.display()))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("set_nonblocking failed: {e}"))?;
    Ok(listener)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_dir(tag: &str) -> PathBuf {
        // Short names: macOS caps a unix-socket path at 104 bytes.
        std::env::temp_dir().join(format!("trmx239-{tag}-{}", std::process::id()))
    }

    fn mode_of(p: &Path) -> u32 {
        std::fs::metadata(p).expect("metadata").permissions().mode() & 0o777
    }

    #[test]
    fn ensure_private_dir_default_creates_and_tightens_a_0700_dir_we_own() {
        let dir = tmp_dir("priv");
        std::fs::remove_dir_all(&dir).ok();
        // absent → created 0700
        ensure_private_dir(&dir).expect("create");
        assert_eq!(mode_of(&dir), 0o700);
        // a 0755 dir we own (like the shared config dir) is TIGHTENED to 0700, not rejected (finding 3).
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        ensure_private_dir(&dir).expect("tighten");
        assert_eq!(mode_of(&dir), 0o700);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ensure_private_dir_default_rejects_a_symlink_and_a_non_directory() {
        let base = tmp_dir("sym");
        std::fs::remove_dir_all(&base).ok();
        std::fs::create_dir_all(&base).unwrap();
        let real = base.join("real");
        std::fs::create_dir(&real).unwrap();
        let link = base.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(ensure_private_dir(&link).is_err());
        let file = base.join("afile");
        std::fs::write(&file, b"x").unwrap();
        assert!(ensure_private_dir(&file).is_err());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn require_private_dir_refuses_anything_but_an_existing_0700_dir_we_own() {
        // The override policy in isolation: it never creates and never chmods (trmx-235 L12).
        let base = tmp_dir("req");
        std::fs::remove_dir_all(&base).ok();
        std::fs::create_dir_all(&base).expect("base");
        let missing = base.join("nope");
        assert!(require_private_dir(&missing).is_err(), "absent is refused");
        assert!(!missing.exists(), "and is never created");
        for mode in [0o755u32, 0o750, 0o600] {
            let dir = base.join(format!("m{mode:o}"));
            std::fs::create_dir(&dir).expect("dir");
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(mode)).expect("chmod");
            assert!(require_private_dir(&dir).is_err(), "mode {mode:o} refused");
            assert_eq!(mode_of(&dir), mode, "mode {mode:o} must NOT be chmod-ed");
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
                .expect("restore");
        }
        let good = base.join("good");
        std::fs::create_dir(&good).expect("dir");
        std::fs::set_permissions(&good, std::fs::Permissions::from_mode(0o700)).expect("chmod");
        assert!(
            require_private_dir(&good).is_ok(),
            "exactly 0700 is accepted"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn create_socket_at_binds_0600_reclaims_a_stale_socket_and_refuses_a_non_socket() {
        let base = tmp_dir("sock");
        std::fs::remove_dir_all(&base).ok();
        std::fs::create_dir_all(&base).expect("base");
        let path = base.join("c.sock");

        let listener = create_socket_at(&path).expect("bind");
        assert_eq!(mode_of(&path), 0o600, "the socket node is 0600");

        // A LIVE listener must not be clobbered.
        assert!(
            create_socket_at(&path).is_err(),
            "a live socket is never clobbered"
        );

        // Dropped ⇒ stale ⇒ reclaimable. Closing the listener fd does not make `connect` fail
        // instantly on macOS — a connect can still succeed for a moment afterwards — so wait for
        // the socket to actually go dead rather than racing it. (The pre-move `control.rs` test had
        // this same drop-then-immediately-reclaim shape and the same latent race; it surfaced once
        // the code moved into a crate whose tests run alongside more parallel work.)
        drop(listener);
        let mut dead = false;
        for _ in 0..200 {
            if UnixStream::connect(&path).is_err() {
                dead = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(
            dead,
            "the dropped listener never stopped accepting connections"
        );
        let again = create_socket_at(&path).expect("a stale socket is reclaimed");
        drop(again);
        std::fs::remove_file(&path).ok();

        // A non-socket node is never touched.
        let regular = base.join("regular");
        std::fs::write(&regular, b"precious").expect("write");
        assert!(
            create_socket_at(&regular).is_err(),
            "a regular file is refused"
        );
        assert_eq!(
            std::fs::read(&regular).expect("still there"),
            b"precious",
            "and is left untouched"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn current_euid_is_stable() {
        assert_eq!(current_euid(), current_euid());
    }
}
