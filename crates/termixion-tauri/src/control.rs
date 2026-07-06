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
use std::os::unix::fs::PermissionsExt;
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
}

impl Default for ControlState {
    fn default() -> Self {
        Self {
            listener: Mutex::new(None),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(AtomicU64::new(1)),
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// The default socket path: `<xdg|~/.config>/termixion/control.sock`. Pure (env-free).
pub fn socket_path_from(xdg_config_home: Option<&str>, home: &str) -> PathBuf {
    let base = match xdg_config_home.filter(|d| !d.is_empty()) {
        Some(xdg) => PathBuf::from(xdg),
        None => Path::new(home).join(".config"),
    };
    base.join("termixion").join("control.sock")
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

/// Ensure `dir` is a private (`0700`, not group-/world-writable) directory, creating it if absent. Refuses
/// to downgrade the posture: an existing group-/world-accessible dir is an error (falls back to the default).
fn ensure_private_dir(dir: &Path) -> Result<(), String> {
    match std::fs::metadata(dir) {
        Ok(md) => {
            if !md.is_dir() {
                return Err(format!("{} is not a directory", dir.display()));
            }
            let mode = md.permissions().mode() & 0o777;
            if mode & 0o077 != 0 {
                return Err(format!(
                    "{} is group/world-accessible (mode {mode:o}); refusing to place a control socket there",
                    dir.display()
                ));
            }
            Ok(())
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
    if path.exists() {
        if UnixStream::connect(path).is_ok() {
            return Err(format!(
                "{} is a live control socket (another instance?); not clobbering",
                path.display()
            ));
        }
        let _ = std::fs::remove_file(path); // stale — reclaim
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
    let mut guard = lock(&state.listener);
    match (desired.enabled, guard.is_some()) {
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
                    std::thread::spawn(move || handle_connection(stream, app, pending, next_id));
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
) {
    let _ = stream.set_read_timeout(Some(READ_IDLE_TIMEOUT));
    let mut writer = match stream.try_clone() {
        Ok(w) => w,
        Err(_) => return,
    };
    let reader = BufReader::new(stream);
    for line in reader.lines() {
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
    fn socket_path_prefers_xdg_then_home_default() {
        assert_eq!(
            socket_path_from(Some("/x/cfg"), "/home/u"),
            PathBuf::from("/x/cfg/termixion/control.sock")
        );
        assert_eq!(
            socket_path_from(None, "/home/u"),
            PathBuf::from("/home/u/.config/termixion/control.sock")
        );
        assert_eq!(
            socket_path_from(Some(""), "/home/u"),
            PathBuf::from("/home/u/.config/termixion/control.sock")
        );
    }

    #[test]
    fn ensure_private_dir_creates_0700_and_rejects_world_writable() {
        let dir = tmp_dir("priv");
        std::fs::remove_dir_all(&dir).ok();
        ensure_private_dir(&dir).expect("create");
        let mode = std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
        // widen it → rejected
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(ensure_private_dir(&dir).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn create_socket_sets_0600_and_0700_and_reclaims_stale_but_not_live() {
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
        // Drop the live listener → the file is now stale → reclaimable.
        drop(listener);
        let _relisten = create_socket(&path).expect("reclaim stale");
        std::fs::remove_dir_all(&dir).ok();
    }
}
