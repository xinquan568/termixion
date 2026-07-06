// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
//! trmx-101 (FR-9.4): the control-channel socket edge — the `std::os::unix` listener, its lifecycle, and
//! the request bridge to the webview. OFF by default; socket `0600` in a `0700` dir; NO TCP, ever. Lives
//! in `termixion-tauri` (never core — R2 forbids `std::os` there). The pure protocol codec is `control_io`.
//!
//! Lifecycle: `apply_remote_control` is idempotent + reached from all three config paths (initial load,
//! app-originated write/reset, external file edit). The acceptor is non-blocking (polls a stop flag) and
//! spawns a per-connection worker so a slow client never blocks another. Each request is bridged to the
//! frontend (`control:request`) and awaited via a pending-map + `recv_timeout`; the webview replies through
//! the `control_response` command (the `smoke_done` pattern). The mutex is held ONLY for insert/pop.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::{Value as JsonValue, json};
use tauri::{AppHandle, Emitter, State};

use crate::control_io::{
    PROTOCOL_VERSION, Request, Response, parse_ctl_argv, parse_request, serialize_response,
};
use termixion_core::config::RemoteControlConfig;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const READ_IDLE_TIMEOUT: Duration = Duration::from_secs(5);
const ACCEPT_POLL: Duration = Duration::from_millis(50);

type Pending = Arc<Mutex<HashMap<u64, Sender<JsonValue>>>>;

/// A live listener: its socket path, a stop flag the acceptor polls, and the acceptor thread handle.
struct ListenerHandle {
    path: PathBuf,
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

/// The managed control-channel state (registered via `.manage(...)`).
pub struct ControlState {
    listener: Mutex<Option<ListenerHandle>>,
    pending: Pending,
    next_id: Arc<AtomicU64>,
    /// A deterministic launch (`--smoke`/`--perf`) NEVER opens the socket, from ANY apply path.
    deterministic: bool,
}

impl Default for ControlState {
    fn default() -> Self {
        Self::new(false)
    }
}

impl ControlState {
    pub fn new(deterministic: bool) -> Self {
        Self {
            listener: Mutex::new(None),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(AtomicU64::new(1)),
            deterministic,
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// The default socket path: `<xdg|~/.config>/termixion/control/control.sock`. A DEDICATED `control/`
/// subdir (not the shared `termixion/` config dir, which other subsystems create `0755`) so its parent can
/// be tightened to `0700` without touching the rest of the config tree (review finding 3). Pure (env-free).
pub fn socket_path_from(xdg_config_home: Option<&str>, home: &str) -> PathBuf {
    let base = match xdg_config_home.filter(|d| !d.is_empty()) {
        Some(xdg) => PathBuf::from(xdg),
        None => Path::new(home).join(".config"),
    };
    base.join("termixion").join("control").join("control.sock")
}

/// Resolve the effective socket path: the `socket_path` override if set, else the XDG default.
fn resolve_socket_path(cfg: &RemoteControlConfig) -> PathBuf {
    if !cfg.socket_path.is_empty() {
        return PathBuf::from(&cfg.socket_path);
    }
    let xdg = std::env::var("XDG_CONFIG_HOME").ok();
    let home = std::env::var("HOME").unwrap_or_default();
    socket_path_from(xdg.as_deref(), &home)
}

/// Ensure `dir` is a private, current-uid-owned directory with mode `0700`. Creates it if absent; if it
/// EXISTS as a real directory we own, TIGHTENS it to `0700` (so a `0755` config dir created by another
/// subsystem still yields a private socket dir — review finding 3); rejects a symlink, a non-directory, or
/// a foreign-owned directory (review finding 5) rather than trusting/loosening it.
fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(dir) {
        Ok(md) => {
            let ft = md.file_type();
            if ft.is_symlink() {
                return Err(format!("{} is a symlink; refusing", dir.display()));
            }
            if !ft.is_dir() {
                return Err(format!("{} is not a directory", dir.display()));
            }
            let euid = unsafe { libc::geteuid() };
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

/// Create + bind the socket at `path` with `0600` perms in a `0700` parent. Probe-before-unlink: a LIVE
/// listener is NOT clobbered (Err); a stale socket is reclaimed. Bind ONCE (a race → Err, no re-clobber).
/// AppHandle-free so it is unit-testable.
fn create_socket(path: &Path) -> Result<UnixListener, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "socket path has no parent".to_string())?;
    ensure_private_dir(parent)?;
    // Only ever touch a SOCKET node at `path` (review finding 4): never delete a regular file / symlink /
    // directory a misconfigured socket_path might point at.
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

/// Apply the desired remote-control state idempotently. Called from initial load, config write/reset, and
/// the file watcher — enable a not-listening socket, disable a listening one, no-op otherwise.
pub fn apply_remote_control(app: &AppHandle, desired: &RemoteControlConfig, state: &ControlState) {
    // A --smoke/--perf launch NEVER opens the socket, no matter which apply path calls in (review finding
    // 2): the deterministic-off policy lives here, not only at the initial-load call site.
    let want_enabled = desired.enabled && !state.deterministic;
    let mut guard = lock(&state.listener);
    match (want_enabled, guard.is_some()) {
        (true, false) => {
            let path = resolve_socket_path(desired);
            match create_socket(&path) {
                Ok(listener) => {
                    let stop = Arc::new(AtomicBool::new(false));
                    let thread = spawn_acceptor(
                        listener,
                        app.clone(),
                        state.pending.clone(),
                        state.next_id.clone(),
                        stop.clone(),
                    );
                    *guard = Some(ListenerHandle { path, stop, thread });
                    eprintln!("termixion: remote control listening (opt-in).");
                }
                Err(e) => eprintln!("termixion: remote control not started — {e}"),
            }
        }
        (false, true) => {
            if let Some(handle) = guard.take() {
                // Flip the SHARED stop flag first: the acceptor stops accepting AND every in-flight
                // per-connection worker stops processing further requests (review finding 1).
                handle.stop.store(true, Ordering::SeqCst);
                let _ = handle.thread.join();
                let _ = std::fs::remove_file(&handle.path);
                eprintln!("termixion: remote control stopped.");
            }
        }
        _ => {} // already in the desired state
    }
}

/// Tear down any live listener (on window close).
pub fn shutdown(state: &ControlState) {
    let mut guard = lock(&state.listener);
    if let Some(handle) = guard.take() {
        handle.stop.store(true, Ordering::SeqCst);
        let _ = handle.thread.join();
        let _ = std::fs::remove_file(&handle.path);
    }
}

// The acceptor ACCEPTS ONLY (non-blocking + stop poll) and spawns a per-connection worker, so one slow
// client never blocks another `ctl`.
fn spawn_acceptor(
    listener: UnixListener,
    app: AppHandle,
    pending: Pending,
    next_id: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        loop {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            match listener.accept() {
                Ok((stream, _)) => {
                    let app = app.clone();
                    let pending = pending.clone();
                    let next_id = next_id.clone();
                    let stop = stop.clone();
                    std::thread::spawn(move || {
                        handle_connection(stream, app, pending, next_id, stop)
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(ACCEPT_POLL);
                }
                Err(_) => break,
            }
        }
    })
}

fn handle_connection(
    stream: UnixStream,
    app: AppHandle,
    pending: Pending,
    next_id: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
) {
    let _ = stream.set_read_timeout(Some(READ_IDLE_TIMEOUT));
    let mut writer = match stream.try_clone() {
        Ok(w) => w,
        Err(_) => return,
    };
    let reader = BufReader::new(stream);
    for line in reader.lines() {
        // Stop processing an in-flight connection the moment remote control is disabled (review finding 1).
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let line = match line {
            Ok(l) => l,
            Err(_) => break, // idle timeout / EOF → close
        };
        if line.trim().is_empty() {
            continue;
        }
        let id = next_id.fetch_add(1, Ordering::SeqCst);
        let response = process_line(&app, &pending, id, &line);
        if writer
            .write_all(serialize_response(&response).as_bytes())
            .is_err()
        {
            break;
        }
        let _ = writer.flush();
    }
}

fn process_line(app: &AppHandle, pending: &Pending, id: u64, line: &str) -> Response {
    match parse_request(line) {
        Ok(Request::Version) => Response::ok(
            id,
            Some(json!({ "app": env!("CARGO_PKG_VERSION"), "protocol": PROTOCOL_VERSION })),
        ),
        Ok(_) => bridge_to_webview(app, pending, id, line),
        Err(e) => Response::err(id, e),
    }
}

// Bridge a request to the webview and await its reply. The mutex is held ONLY for the brief insert/remove,
// NEVER across emit or recv_timeout. A timed-out request removes its own pending sender.
fn bridge_to_webview(app: &AppHandle, pending: &Pending, id: u64, line: &str) -> Response {
    let (tx, rx) = mpsc::channel();
    lock(pending).insert(id, tx);
    let request_json: JsonValue = serde_json::from_str(line).unwrap_or_else(|_| json!({}));
    if app
        .emit(
            "control:request",
            json!({ "id": id, "request": request_json }),
        )
        .is_err()
    {
        lock(pending).remove(&id);
        return Response::err(id, "control bridge unavailable");
    }
    match rx.recv_timeout(REQUEST_TIMEOUT) {
        Ok(v) => Response {
            id,
            ok: v.get("ok").and_then(JsonValue::as_bool).unwrap_or(false),
            result: v.get("result").cloned(),
            error: v.get("error").and_then(|e| e.as_str()).map(String::from),
        },
        Err(_) => {
            lock(pending).remove(&id);
            Response::err(id, "timeout")
        }
    }
}

/// The webview reports a request's result; pop the pending sender (a late/removed id is a no-op).
#[tauri::command]
pub fn control_response(id: u64, payload: JsonValue, state: State<'_, ControlState>) {
    if let Some(tx) = lock(&state.pending).remove(&id) {
        let _ = tx.send(payload);
    }
}

/// `termixion ctl <…>`: connect to the socket, send one request, print the response line, exit 0/1 on
/// `ok`. Non-GUI — never builds the tauri app.
pub fn run_ctl<I: IntoIterator<Item = String>>(args: I) -> std::process::ExitCode {
    use std::io::Read;
    let req = match parse_ctl_argv(args) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("termixion ctl: {e}");
            return std::process::ExitCode::FAILURE;
        }
    };
    let path = match req.socket {
        Some(s) => PathBuf::from(s),
        None => {
            let xdg = std::env::var("XDG_CONFIG_HOME").ok();
            let home = std::env::var("HOME").unwrap_or_default();
            socket_path_from(xdg.as_deref(), &home)
        }
    };
    let mut stream = match UnixStream::connect(&path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "termixion ctl: cannot connect to {} ({e}). Is remote control enabled?",
                path.display()
            );
            return std::process::ExitCode::FAILURE;
        }
    };
    let _ = stream.set_read_timeout(Some(REQUEST_TIMEOUT));
    if stream
        .write_all(format!("{}\n", req.request_line).as_bytes())
        .is_err()
    {
        eprintln!("termixion ctl: failed to write the request");
        return std::process::ExitCode::FAILURE;
    }
    let _ = stream.flush();
    let mut buf = String::new();
    let mut reader = BufReader::new(stream);
    // Read one response line.
    let mut byte = [0u8; 1];
    loop {
        match reader.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => {
                if byte[0] == b'\n' {
                    break;
                }
                buf.push(byte[0] as char);
            }
            Err(_) => break,
        }
    }
    if buf.is_empty() {
        eprintln!("termixion ctl: no response");
        return std::process::ExitCode::FAILURE;
    }
    println!("{buf}");
    let ok = serde_json::from_str::<JsonValue>(&buf)
        .ok()
        .and_then(|v| v.get("ok").and_then(JsonValue::as_bool))
        .unwrap_or(false);
    if ok {
        std::process::ExitCode::SUCCESS
    } else {
        std::process::ExitCode::FAILURE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("trmx101-{tag}-{}", std::process::id()))
    }

    #[test]
    fn socket_path_uses_a_dedicated_private_subdir() {
        assert_eq!(
            socket_path_from(Some("/x/cfg"), "/home/u"),
            PathBuf::from("/x/cfg/termixion/control/control.sock")
        );
        assert_eq!(
            socket_path_from(None, "/home/u"),
            PathBuf::from("/home/u/.config/termixion/control/control.sock")
        );
        assert_eq!(
            socket_path_from(Some(""), "/home/u"),
            PathBuf::from("/home/u/.config/termixion/control/control.sock")
        );
    }

    #[test]
    fn ensure_private_dir_creates_and_tightens_a_0700_dir_we_own() {
        let dir = tmp_dir("priv");
        std::fs::remove_dir_all(&dir).ok();
        // absent → created 0700
        ensure_private_dir(&dir).expect("create");
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        // a 0755 dir we own (like the shared config dir) is TIGHTENED to 0700, not rejected (finding 3).
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        ensure_private_dir(&dir).expect("tighten");
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ensure_private_dir_rejects_a_symlink_and_a_non_directory() {
        let base = tmp_dir("sym");
        std::fs::remove_dir_all(&base).ok();
        std::fs::create_dir_all(&base).unwrap();
        // a symlink where a dir is expected → rejected (finding 5)
        let real = base.join("real");
        std::fs::create_dir(&real).unwrap();
        let link = base.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(ensure_private_dir(&link).is_err());
        // a regular file → rejected
        let file = base.join("afile");
        std::fs::write(&file, b"x").unwrap();
        assert!(ensure_private_dir(&file).is_err());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn create_socket_sets_perms_reclaims_stale_socket_but_not_a_live_one_or_a_regular_file() {
        let dir = tmp_dir("sock");
        std::fs::remove_dir_all(&dir).ok();
        let path = dir.join("control.sock");
        let listener = create_socket(&path).expect("bind");
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        // A LIVE listener must NOT be clobbered.
        assert!(create_socket(&path).is_err());
        // Drop the live listener → the file is now a STALE socket → reclaimable.
        drop(listener);
        let relisten = create_socket(&path).expect("reclaim stale socket");
        drop(relisten);
        // A NON-socket at the path (a regular file) is REFUSED, never deleted (finding 4).
        std::fs::remove_file(&path).ok();
        std::fs::write(&path, b"not a socket").unwrap();
        assert!(create_socket(&path).is_err());
        assert!(path.exists(), "the regular file must NOT have been deleted");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn control_state_records_the_deterministic_flag() {
        assert!(!ControlState::default().deterministic);
        assert!(ControlState::new(true).deterministic);
    }
}
