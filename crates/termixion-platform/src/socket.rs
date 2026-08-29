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

use std::collections::HashSet;
use std::fs::File;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

/// Lock files this PROCESS holds. POSIX record locks are per-PROCESS: a second `F_SETLK` from the
/// same process succeeds even while the first is held, so the kernel supplies only the
/// cross-process half of the exclusion. This set supplies the in-process half.
static HELD: LazyLock<Mutex<HashSet<PathBuf>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

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

/// The liveness token for a control socket: an exclusive POSIX record lock on a sibling `.lock`
/// file, held for as long as the socket is served.
///
/// Why not just connect to the socket? Because `UnixStream::connect` succeeding proves only that
/// SOME descriptor for the listening socket still exists — never that anyone is accepting on it.
/// macOS cannot create a socket with `FD_CLOEXEC` atomically (there is no `SOCK_CLOEXEC`; `std`
/// does `socket()` then `ioctl(FIOCLEX)`), so a `posix_spawn` from another thread landing between
/// those two syscalls hands an unrelated child a permanent copy of the descriptor. That child
/// keeps a DEAD instance's socket connectable for as long as it runs, and the old probe read that
/// as "another instance is running" — refusing to start, for as long as the stray process lived
/// (trmx-278).
///
/// A POSIX record lock has exactly the property the probe lacked: it is NOT inherited across
/// `fork`, and the kernel drops it when the owning process dies. (`flock` would NOT do — it
/// attaches to the open file description, so a leaked descriptor WOULD keep it held.)
#[derive(Debug)]
pub struct SocketLock {
    /// Held open for as long as the socket is served: closing it releases the record lock.
    _file: File,
    path: PathBuf,
}

impl Drop for SocketLock {
    fn drop(&mut self) {
        HELD.lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.path);
        // Closing `_file` releases the lock. The lock NODE is deliberately left on disk: unlinking
        // it would let a newcomer lock a fresh inode while an existing owner still held the old
        // one, and both would believe they had won.
    }
}

/// A bound control socket and the liveness lock that says it is ours. They belong together —
/// releasing the lock while still serving the listener would let a second instance reclaim the
/// path out from under this one.
#[derive(Debug)]
pub struct ControlSocket {
    listener: UnixListener,
    lock: SocketLock,
}

impl ControlSocket {
    /// The bound, non-blocking, `0600` listener.
    pub fn listener(&self) -> &UnixListener {
        &self.listener
    }

    /// Split into the listener and its liveness lock, for callers that move the listener into an
    /// acceptor thread. Keep the lock alive alongside it and drop both at teardown.
    pub fn into_parts(self) -> (UnixListener, SocketLock) {
        (self.listener, self.lock)
    }
}

/// Where a socket's liveness lock lives: a sibling `<name>.lock` in the same (already guaranteed
/// private) directory. The parent is canonicalized so two spellings of one path cannot each take
/// the lock and both conclude they are alone.
fn lock_path_for(socket: &Path) -> Result<PathBuf, String> {
    let parent = socket
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", socket.display()))?;
    let name = socket
        .file_name()
        .ok_or_else(|| format!("{} has no file name", socket.display()))?;
    let dir = std::fs::canonicalize(parent)
        .map_err(|e| format!("could not resolve {}: {e}", parent.display()))?;
    Ok(dir.join(format!("{}.lock", name.to_string_lossy())))
}

/// Take the liveness lock, or `None` if a LIVE instance holds it.
fn take_liveness_lock(lock_path: &Path) -> Result<Option<SocketLock>, String> {
    // `HELD` is held across the whole operation: two threads racing here would otherwise both pass
    // the in-process check and then both win the (per-process) kernel lock.
    let mut held = HELD.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if held.contains(lock_path) {
        return Ok(None);
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(lock_path)
        .map_err(|e| format!("could not open {}: {e}", lock_path.display()))?;
    std::fs::set_permissions(lock_path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("could not chmod {}: {e}", lock_path.display()))?;

    let req = libc::flock {
        l_start: 0,
        l_len: 0, // 0 == through end of file, however long it grows
        l_pid: 0,
        l_type: libc::F_WRLCK as libc::c_short,
        l_whence: libc::SEEK_SET as libc::c_short,
    };
    // SAFETY: `fcntl` is variadic; `F_SETLK` consumes exactly one `*const flock`, which is what we
    // pass, and `req` outlives the call. `file` owns the descriptor, so it is open throughout.
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETLK, &req) } != 0 {
        let err = std::io::Error::last_os_error();
        // EAGAIN/EACCES is the answer we asked for: someone alive holds it. Anything else is a
        // real failure and must not be misreported as "another instance".
        return match err.raw_os_error() {
            Some(libc::EAGAIN) | Some(libc::EACCES) => Ok(None),
            _ => Err(format!("could not lock {}: {err}", lock_path.display())),
        };
    }
    held.insert(lock_path.to_path_buf());
    Ok(Some(SocketLock {
        _file: file,
        path: lock_path.to_path_buf(),
    }))
}

/// Create + bind a non-blocking `0600` socket at `path`. Liveness is decided by the sibling lock
/// (see [`SocketLock`]), NOT by connecting to the socket: a LIVE instance is never clobbered
/// (Err), while a socket whose owner is gone is reclaimed however many descriptors for it leaked
/// into other processes (trmx-278). A non-socket node is never touched. Binds ONCE, so a race
/// yields an Err rather than a re-clobber. The PARENT-directory guarantee is the caller's to
/// establish first (see [`ensure_private_dir`] / [`require_private_dir`]) — which of the two
/// applies is the shell's policy decision, not this module's.
pub fn create_socket_at(path: &Path) -> Result<ControlSocket, String> {
    // Only ever touch a SOCKET node at `path`: never delete a regular file / symlink / directory a
    // misconfigured socket_path might point at. Checked BEFORE anything is created, so refusing
    // leaves no lock file beside a path that was never ours.
    let stale = match std::fs::symlink_metadata(path) {
        Ok(md) if !md.file_type().is_socket() => {
            return Err(format!(
                "{} exists and is not a socket; refusing to touch it",
                path.display()
            ));
        }
        Ok(_) => true,
        Err(_) => false,
    };

    let lock_path = lock_path_for(path)?;
    let Some(lock) = take_liveness_lock(&lock_path)? else {
        return Err(format!(
            "{} is a live control socket (another instance?); not clobbering",
            path.display()
        ));
    };

    // We hold the lock, so no live instance owns this path: whatever socket node is left is stale.
    if stale {
        let _ = std::fs::remove_file(path);
    }
    let listener =
        UnixListener::bind(path).map_err(|e| format!("bind {} failed: {e}", path.display()))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("could not chmod {}: {e}", path.display()))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("set_nonblocking failed: {e}"))?;
    Ok(ControlSocket { listener, lock })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream;

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

        // Dropped ⇒ stale ⇒ reclaimable.
        drop(listener);
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

    /// trmx-278: an unrelated child that inherited the listening socket's descriptor must NOT make a
    /// dead instance look alive. macOS has no `SOCK_CLOEXEC`, so `UnixListener::bind` sets
    /// `FD_CLOEXEC` in a SECOND syscall; a `posix_spawn` from another thread landing in that window
    /// hands the child a permanent copy. `dup` reproduces that leak deterministically (it returns a
    /// descriptor WITHOUT `FD_CLOEXEC`), so this pins the bug instead of racing for it.
    #[test]
    fn create_socket_at_reclaims_a_socket_whose_descriptor_leaked_into_a_live_child() {
        let base = tmp_dir("leak");
        std::fs::remove_dir_all(&base).ok();
        std::fs::create_dir_all(&base).expect("base");
        let path = base.join("c.sock");

        let sock = create_socket_at(&path).expect("bind");
        // SAFETY: `dup` on a descriptor we own and keep alive across the call; the copy it returns
        // is closed below. Unlike the original it carries no `FD_CLOEXEC`, so it survives `exec`.
        let leaked = unsafe { libc::dup(sock.listener().as_raw_fd()) };
        assert!(leaked >= 0, "dup");
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn");
        // SAFETY: closing our own copy of a descriptor no longer used here; the child keeps the
        // one it inherited, which is the whole point of the scenario.
        unsafe { libc::close(leaked) };
        drop(sock); // the OWNER is gone; only the child's inherited descriptor remains

        assert!(
            UnixStream::connect(&path).is_ok(),
            "precondition: a leaked descriptor keeps a DEAD instance's socket connectable — which \
             is exactly why connect() cannot be the liveness authority"
        );

        let again = create_socket_at(&path);
        let _ = child.kill(); // before any assert, so a failure never strands the child
        let _ = child.wait();
        assert!(
            again.is_ok(),
            "a socket whose OWNER is gone is reclaimed, however many descriptors leaked: {:?}",
            again.err()
        );

        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn current_euid_is_stable() {
        assert_eq!(current_euid(), current_euid());
    }
}
