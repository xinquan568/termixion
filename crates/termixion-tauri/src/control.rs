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
//!
//! trmx-235 hardening. The edge is BOUNDED and SELF-HEALING: at most [`MAX_WORKERS`] connection workers
//! (a slot is reserved BEFORE spawning; the rest get `too-many-connections`), at most [`MAX_LINE_BYTES`]
//! per request line (`line-too-long`), strict UTF-8 on the way in (`invalid-utf8` — never dispatched), a
//! fatal accept error marks the listener `dead` so the next config apply restarts it, and both thread
//! spawns go through `std::thread::Builder` (a refused thread is an error line, never an abort). The
//! socket edge is driven through injectable seams (`accept` / `spawn` / `process`, [`ApplyDeps`]) so all
//! of that is unit-tested headless — no webview, no `AppHandle`.

use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::{Value as JsonValue, json};
use tauri::{AppHandle, Emitter, State};
use termixion_platform::{ControlSocket, SocketLock};

use crate::control_io::{
    PROTOCOL_VERSION, Request, Response, parse_ctl_argv, parse_request, serialize_response,
};
use termixion_core::config::{RemoteControlConfig, default_control_socket_path};

/// How long the socket edge waits for the webview to answer ONE bridged request. trmx-235: 8 s (the old
/// 2 s was routinely exceeded by a throttled/occluded webview). A `timeout` reply means the command's fate
/// is UNKNOWN — it may have run, may run late, or may never be handled (docs/remote-control.md).
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
/// The `ctl` client's read deadline — STRICTLY longer than the server's, so the client always outlives the
/// server's own `timeout` reply instead of printing "no response" first (pinned by a test).
pub const CTL_READ_TIMEOUT: Duration = Duration::from_secs(10);
const READ_IDLE_TIMEOUT: Duration = Duration::from_secs(5);
const ACCEPT_POLL: Duration = Duration::from_millis(50);
/// At most this many connection workers at once (trmx-235). The acceptor reserves a slot BEFORE it spawns
/// (a burst can never overshoot) and answers the excess with `too-many-connections` without spawning.
pub const MAX_WORKERS: usize = 16;
/// One request line may be at most this many bytes (trmx-235). Longer → `line-too-long`, connection closed.
/// The bound is PER LINE (a long-lived client sending many small requests is never cut off) and it is
/// what guarantees a newline-free stream is observed — the stop flag is checked at least this often.
pub const MAX_LINE_BYTES: usize = 64 * 1024;
const CLIENT_ERROR_WRITE_TIMEOUT: Duration = Duration::from_secs(1);

type Pending = Arc<Mutex<HashMap<u64, Sender<JsonValue>>>>;

/// The per-line request handler the socket edge drives — the seam that keeps the edge testable without a
/// webview. Production bridges to the webview ([`process_line`]); tests inject an echo.
pub type Process = Arc<dyn Fn(u64, &str) -> Response + Send + Sync>;

/// The worker-slot counter (trmx-235). A slot is RESERVED by the acceptor before it spawns — never after,
/// so a burst of accepts cannot overshoot — and released by the [`Permit`]'s drop: inside the worker when
/// it finishes, or in the acceptor when the spawn fails (the job, and the permit it owns, drop with the
/// `Err`).
pub struct Slots {
    active: AtomicUsize,
    max: usize,
}

impl Slots {
    pub fn new(max: usize) -> Arc<Self> {
        Arc::new(Self {
            active: AtomicUsize::new(0),
            max,
        })
    }

    /// Atomically reserve one slot; `None` when all are taken.
    pub fn try_acquire(self: &Arc<Self>) -> Option<Permit> {
        self.active
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                if n < self.max { Some(n + 1) } else { None }
            })
            .ok()?;
        Some(Permit {
            slots: Arc::clone(self),
        })
    }

    #[cfg(test)]
    pub fn active(&self) -> usize {
        self.active.load(Ordering::SeqCst)
    }
}

/// An RAII worker slot; dropping it releases the slot.
pub struct Permit {
    slots: Arc<Slots>,
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.slots.active.fetch_sub(1, Ordering::SeqCst);
    }
}

/// A live listener: its socket path, a stop flag the acceptor polls, the `dead` flag the acceptor sets on a
/// fatal accept error (so the next apply restarts it — trmx-235), and the acceptor thread handle.
struct ListenerHandle {
    path: PathBuf,
    stop: Arc<AtomicBool>,
    dead: Arc<AtomicBool>,
    thread: JoinHandle<()>,
    /// The liveness lock for `path` (trmx-278). Held for exactly as long as this listener is
    /// served: `teardown` drops the handle, which releases it for the next instance.
    _lock: SocketLock,
}

/// The managed control-channel state (registered via `.manage(...)`).
pub struct ControlState {
    listener: Mutex<Option<ListenerHandle>>,
    pending: Pending,
    next_id: Arc<AtomicU64>,
    slots: Arc<Slots>,
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
            slots: Slots::new(MAX_WORKERS),
            deterministic,
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Where the effective socket path came from (trmx-235): the XDG default gets its private `control/`
/// subdir created-or-tightened for it; a user OVERRIDE must already point into a private dir you own —
/// it is never created or chmod-ed for you (docs/config.md, docs/remote-control.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocketPathOrigin {
    Default,
    Override,
}

/// Resolve the effective socket path: the `socket_path` override if set, else the XDG default (the pure
/// path arithmetic lives in core so the template can be pinned against it — trmx-235 M11).
fn resolve_socket_path(cfg: &RemoteControlConfig) -> (PathBuf, SocketPathOrigin) {
    if !cfg.socket_path.is_empty() {
        return (PathBuf::from(&cfg.socket_path), SocketPathOrigin::Override);
    }
    let xdg = std::env::var("XDG_CONFIG_HOME").ok();
    let home = std::env::var("HOME").unwrap_or_default();
    (
        default_control_socket_path(xdg.as_deref(), &home),
        SocketPathOrigin::Default,
    )
}

/// trmx-239 (M12): create + bind the control socket. The PLATFORM mechanics — the effective-uid
/// check, the two directory guarantees, and the `0600` bind — now live behind the R1 seam in
/// `termixion_platform::socket`; this function keeps the CONTROL-DOMAIN decision, which is the only
/// part that belongs in the shell: which directory policy a socket path earns based on where it
/// came from. A default path may be created and tightened for the user; a user-supplied override
/// must already be a private 0700 directory, because tightening a path under `$HOME` on someone's
/// behalf is not ours to do (trmx-235 L12). AppHandle-free so it is unit-testable.
fn create_socket(path: &Path, origin: SocketPathOrigin) -> Result<ControlSocket, String> {
    if origin == SocketPathOrigin::Override && !path.is_absolute() {
        return Err(format!(
            "socket_path '{}' must be an absolute path",
            path.display()
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| "socket path has no parent".to_string())?;
    match origin {
        SocketPathOrigin::Default => termixion_platform::ensure_private_dir(parent)?,
        SocketPathOrigin::Override => termixion_platform::require_private_dir(parent)?,
    }
    termixion_platform::create_socket_at(path)
}

/// What the acceptor does with an `accept` error (trmx-235). Pure — pinned by tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcceptAction {
    /// Non-blocking listener, nothing pending: sleep the poll interval.
    Poll,
    /// A transient failure: sleep the poll interval, then retry (never a hot loop).
    RetryAfterDelay,
    /// Unrecoverable (e.g. EMFILE): report, mark the listener `dead`, stop accepting.
    Fatal,
}

pub fn accept_error_action(kind: io::ErrorKind) -> AcceptAction {
    match kind {
        io::ErrorKind::WouldBlock => AcceptAction::Poll,
        io::ErrorKind::Interrupted | io::ErrorKind::ConnectionAborted => {
            AcceptAction::RetryAfterDelay
        }
        _ => AcceptAction::Fatal,
    }
}

/// The lifecycle decision `apply_with` takes (trmx-235). Pure — pinned by tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reconcile {
    Start,
    Stop,
    /// Enabled, a handle exists, but its acceptor died: tear down and re-create.
    Restart,
    Noop,
}

pub fn reconcile(want_enabled: bool, has_handle: bool, dead: bool) -> Reconcile {
    match (want_enabled, has_handle, dead) {
        (true, false, _) => Reconcile::Start,
        (false, true, _) => Reconcile::Stop,
        (true, true, true) => Reconcile::Restart,
        _ => Reconcile::Noop,
    }
}

/// Bind the socket (production: [`create_socket`]).
pub type CreateSocket = Box<dyn Fn(&Path, SocketPathOrigin) -> Result<ControlSocket, String>>;
/// Spawn the acceptor thread over `(listener, stop, dead)` (production: `Builder::spawn` of
/// [`run_acceptor`] with the real accept / worker-spawn / webview-bridge closures).
pub type SpawnAcceptor =
    Box<dyn Fn(UnixListener, Arc<AtomicBool>, Arc<AtomicBool>) -> io::Result<JoinHandle<()>>>;

/// The impure edges `apply_with` drives — injected so the lifecycle is testable headless (trmx-235).
pub struct ApplyDeps {
    pub create_socket: CreateSocket,
    pub spawn_acceptor: SpawnAcceptor,
}

fn teardown(handle: ListenerHandle) {
    // Flip the SHARED stop flag first: the acceptor stops accepting AND every in-flight per-connection
    // worker stops processing further requests (review finding 1; observed between lines — trmx-235).
    handle.stop.store(true, Ordering::SeqCst);
    let _ = handle.thread.join();
    let _ = std::fs::remove_file(&handle.path);
}

/// Apply the desired remote-control state idempotently through injected edges. Returns the decision taken
/// (for tests). `Restart` = the previous acceptor died (`dead`): join it, unlink, and bind afresh.
pub fn apply_with(
    desired: &RemoteControlConfig,
    state: &ControlState,
    deps: &ApplyDeps,
) -> Reconcile {
    // A --smoke/--perf launch NEVER opens the socket, no matter which apply path calls in (review finding
    // 2): the deterministic-off policy lives here, not only at the initial-load call site.
    let want_enabled = desired.enabled && !state.deterministic;
    let mut guard = lock(&state.listener);
    let dead = guard
        .as_ref()
        .map(|h| h.dead.load(Ordering::SeqCst))
        .unwrap_or(false);
    let action = reconcile(want_enabled, guard.is_some(), dead);
    if matches!(action, Reconcile::Stop | Reconcile::Restart)
        && let Some(handle) = guard.take()
    {
        teardown(handle);
        log::info!(
            "termixion: remote control {}.",
            if action == Reconcile::Stop {
                "stopped"
            } else {
                "restarting (acceptor had died)"
            }
        );
    }
    if matches!(action, Reconcile::Start | Reconcile::Restart) {
        let (path, origin) = resolve_socket_path(desired);
        match (deps.create_socket)(&path, origin) {
            Ok(socket) => {
                let (listener, lock) = socket.into_parts();
                let stop = Arc::new(AtomicBool::new(false));
                let dead = Arc::new(AtomicBool::new(false));
                match (deps.spawn_acceptor)(listener, stop.clone(), dead.clone()) {
                    Ok(thread) => {
                        *guard = Some(ListenerHandle {
                            path,
                            stop,
                            dead,
                            thread,
                            _lock: lock,
                        });
                        log::info!("termixion: remote control listening (opt-in).");
                    }
                    Err(e) => {
                        // No acceptor → nobody owns the bound socket: unlink it, stay stopped (no abort).
                        let _ = std::fs::remove_file(&path);
                        log::error!(
                            "termixion: remote control not started — could not spawn the acceptor thread: {e}"
                        );
                    }
                }
            }
            Err(e) => log::error!("termixion: remote control not started — {e}"),
        }
    }
    action
}

/// Apply the desired remote-control state idempotently. Called from initial load, config write/reset, and
/// the file watcher — enable a not-listening socket, disable a listening one, restart a dead one, no-op
/// otherwise.
pub fn apply_remote_control(app: &AppHandle, desired: &RemoteControlConfig, state: &ControlState) {
    let deps = production_deps(app, state);
    apply_with(desired, state, &deps);
}

fn production_deps(app: &AppHandle, state: &ControlState) -> ApplyDeps {
    let app = app.clone();
    let pending = state.pending.clone();
    let next_id = state.next_id.clone();
    let slots = state.slots.clone();
    ApplyDeps {
        create_socket: Box::new(create_socket),
        spawn_acceptor: Box::new(move |listener, stop, dead| {
            let process: Process = {
                let app = app.clone();
                let pending = pending.clone();
                Arc::new(move |id, line| process_line(&app, &pending, id, line))
            };
            let next_id = next_id.clone();
            let slots = slots.clone();
            std::thread::Builder::new()
                .name("termixion-control-accept".into())
                .spawn(move || {
                    run_acceptor(
                        move || listener.accept().map(|(stream, _)| stream),
                        spawn_worker_thread,
                        process,
                        next_id,
                        slots,
                        stop,
                        dead,
                        std::thread::sleep,
                    )
                })
        }),
    }
}

/// Production worker spawn: a named OS thread via `Builder` — a refused thread is an `Err` (never a panic,
/// which would abort the release binary).
fn spawn_worker_thread(job: Box<dyn FnOnce() + Send>) -> io::Result<()> {
    std::thread::Builder::new()
        .name("termixion-control-conn".into())
        .spawn(job)
        .map(|_| ())
}

/// Tear down any live listener (on window close).
pub fn shutdown(state: &ControlState) {
    let mut guard = lock(&state.listener);
    if let Some(handle) = guard.take() {
        teardown(handle);
    }
}

/// The acceptor loop (trmx-235: headless — every edge is a parameter). ACCEPTS ONLY (non-blocking + stop
/// poll), reserves a worker slot BEFORE spawning, and answers the excess without a thread. A transient
/// accept error retries after the poll delay; a fatal one sets `dead` and returns.
#[allow(clippy::too_many_arguments)]
pub fn run_acceptor<A, S, Z>(
    mut accept: A,
    spawn: S,
    process: Process,
    next_id: Arc<AtomicU64>,
    slots: Arc<Slots>,
    stop: Arc<AtomicBool>,
    dead: Arc<AtomicBool>,
    sleep: Z,
) where
    A: FnMut() -> io::Result<UnixStream>,
    S: Fn(Box<dyn FnOnce() + Send>) -> io::Result<()>,
    Z: Fn(Duration),
{
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        match accept() {
            Ok(stream) => {
                let Some(permit) = slots.try_acquire() else {
                    write_client_error(&stream, "too-many-connections");
                    continue;
                };
                // A dup'd fd so the acceptor can still answer the client if the spawn fails (the stream
                // itself moves into the job).
                let notify = stream.try_clone().ok();
                let process = process.clone();
                let next_id = next_id.clone();
                let stop = stop.clone();
                let job: Box<dyn FnOnce() + Send> =
                    Box::new(move || handle_connection(stream, &process, &next_id, permit, &stop));
                if let Err(e) = spawn(job) {
                    // The job — and the permit it owns — dropped with the Err: the slot is free again.
                    log::error!(
                        "termixion: remote control could not spawn a connection worker: {e}"
                    );
                    if let Some(n) = notify {
                        write_client_error(&n, "spawn-failed");
                    }
                }
            }
            Err(e) => match accept_error_action(e.kind()) {
                AcceptAction::Poll => sleep(ACCEPT_POLL),
                AcceptAction::RetryAfterDelay => {
                    log::warn!("termixion: remote control accept error (transient, retrying): {e}");
                    sleep(ACCEPT_POLL);
                }
                AcceptAction::Fatal => {
                    log::error!(
                        "termixion: remote control acceptor stopped: {e} — the next config apply restarts it (toggle remote_control.enabled)"
                    );
                    dead.store(true, Ordering::SeqCst);
                    break;
                }
            },
        }
    }
}

fn write_line(w: &mut UnixStream, r: &Response) -> io::Result<()> {
    w.write_all(serialize_response(r).as_bytes())?;
    w.flush()
}

/// Best-effort one-line error to a client the edge will not serve (bounded write, then the stream drops).
fn write_client_error(stream: &UnixStream, error: &str) {
    let _ = stream.set_write_timeout(Some(CLIENT_ERROR_WRITE_TIMEOUT));
    if let Ok(mut w) = stream.try_clone() {
        let _ = write_line(&mut w, &Response::err(0, error));
    }
}

/// One connection's request loop (trmx-235: headless). Holds its worker `Permit` for its whole life. Reads
/// ONE bounded line at a time (`MAX_LINE_BYTES`), decodes it STRICTLY as UTF-8 (a malformed line is
/// answered `invalid-utf8` and never reaches `process`), checks the stop flag before every read, and
/// answers each request on the same stream.
pub fn handle_connection(
    stream: UnixStream,
    process: &Process,
    next_id: &AtomicU64,
    _permit: Permit,
    stop: &AtomicBool,
) {
    let _ = stream.set_read_timeout(Some(READ_IDLE_TIMEOUT));
    let mut writer = match stream.try_clone() {
        Ok(w) => w,
        Err(_) => return,
    };
    let mut reader = BufReader::new(stream);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        // Stop processing an in-flight connection the moment remote control is disabled (review finding 1).
        if stop.load(Ordering::SeqCst) {
            break;
        }
        buf.clear();
        // A fresh `Take` per line: the bound is per line, and a newline-free stream hits it (and this loop's
        // stop check) at least every MAX_LINE_BYTES — it can no longer sit inside `lines()` forever.
        match (&mut reader)
            .take(MAX_LINE_BYTES as u64 + 1)
            .read_until(b'\n', &mut buf)
        {
            Ok(0) => break, // EOF
            Ok(_) => {}
            Err(_) => break, // idle timeout / read error → close
        }
        let complete = buf.last() == Some(&b'\n');
        if !complete && buf.len() > MAX_LINE_BYTES {
            let _ = write_line(&mut writer, &Response::err(0, "line-too-long"));
            break;
        }
        while matches!(buf.last(), Some(b'\n' | b'\r')) {
            buf.pop();
        }
        let line = match std::str::from_utf8(&buf) {
            Ok(s) => s,
            Err(_) => {
                let _ = write_line(&mut writer, &Response::err(0, "invalid-utf8"));
                break;
            }
        };
        if line.trim().is_empty() {
            if !complete {
                break;
            }
            continue;
        }
        let id = next_id.fetch_add(1, Ordering::SeqCst);
        let response = process(id, line);
        if write_line(&mut writer, &response).is_err() {
            break;
        }
        if !complete {
            break; // the peer closed after an unterminated final line
        }
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
// NEVER across emit or recv_timeout. A timed-out request removes its own pending sender — after that the
// command's fate is unknown (it may still run); a late reply is logged by `control_response`.
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

/// Deliver the webview's reply to the request's waiter. `false` when nobody is waiting any more — the
/// request already timed out (trmx-235: a late reply is diagnosable, not silent).
pub fn resolve_pending(pending: &Pending, id: u64, payload: JsonValue) -> bool {
    match lock(pending).remove(&id) {
        Some(tx) => tx.send(payload).is_ok(),
        None => false,
    }
}

/// The webview reports a request's result; pop the pending sender. A late id (already answered as
/// `timeout`) is logged — the command may have run after the client was told it timed out.
#[tauri::command]
pub fn control_response(id: u64, payload: JsonValue, state: State<'_, ControlState>) {
    if !resolve_pending(&state.pending, id, payload) {
        log::warn!(
            "termixion: late control response for request {id} (already answered as timeout; the command may have run)"
        );
    }
}

/// Decode one response line for the human at the terminal: lossy UTF-8 (a title such as `vim — 日本語`
/// survives; a malformed byte becomes U+FFFD rather than mojibake), trailing `\r?\n` trimmed (trmx-235 M9).
pub fn decode_response_line(bytes: &[u8]) -> String {
    let mut s = String::from_utf8_lossy(bytes).into_owned();
    while s.ends_with('\n') || s.ends_with('\r') {
        s.pop();
    }
    s
}

/// `termixion ctl <…>`: connect to the socket, send one request, print the response line, exit 0/1 on
/// `ok`. Non-GUI — never builds the tauri app.
// stdio-contract: `termixion ctl` is a CLI — the JSON reply goes to stdout (scripts parse it), client
// errors to stderr; it forks before the Tauri builder, so no logger exists here by construction.
#[allow(clippy::print_stdout, clippy::print_stderr)]
pub fn run_ctl<I: IntoIterator<Item = String>>(args: I) -> std::process::ExitCode {
    let req = match parse_ctl_argv(args) {
        Ok(r) => r,
        Err(e) => {
            // stdio-contract: ctl client error → stderr (the CLI contract; no logger exists in the ctl fork)
            eprintln!("termixion ctl: {e}");
            return std::process::ExitCode::FAILURE;
        }
    };
    let path = match req.socket {
        Some(s) => PathBuf::from(s),
        None => {
            let xdg = std::env::var("XDG_CONFIG_HOME").ok();
            let home = std::env::var("HOME").unwrap_or_default();
            default_control_socket_path(xdg.as_deref(), &home)
        }
    };
    let mut stream = match UnixStream::connect(&path) {
        Ok(s) => s,
        Err(e) => {
            // stdio-contract: ctl client error → stderr
            eprintln!(
                "termixion ctl: cannot connect to {} ({e}). Is remote control enabled?",
                path.display()
            );
            return std::process::ExitCode::FAILURE;
        }
    };
    // Strictly longer than the server's REQUEST_TIMEOUT: the server's own `timeout` reply always arrives.
    let _ = stream.set_read_timeout(Some(CTL_READ_TIMEOUT));
    if stream
        .write_all(format!("{}\n", req.request_line).as_bytes())
        .is_err()
    {
        // stdio-contract: ctl client error → stderr
        eprintln!("termixion ctl: failed to write the request");
        return std::process::ExitCode::FAILURE;
    }
    let _ = stream.flush();
    let mut raw: Vec<u8> = Vec::new();
    let mut reader = BufReader::new(stream);
    let _ = reader.read_until(b'\n', &mut raw); // one response line (a read error → whatever arrived)
    let buf = decode_response_line(&raw);
    if buf.is_empty() {
        // stdio-contract: ctl client error → stderr
        eprintln!("termixion ctl: no response");
        return std::process::ExitCode::FAILURE;
    }
    // stdio-contract: ctl prints the JSON reply on stdout — parsed by scripts (docs/remote-control.md)
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
    use std::collections::VecDeque;
    // trmx-239 (M12): the uid/mode PRIMITIVES moved to termixion-platform (and their direct tests
    // with them); these remain because the ORCHESTRATION tests below still set and read modes.
    use std::os::unix::fs::PermissionsExt;

    fn tmp_dir(tag: &str) -> PathBuf {
        // Short names: macOS caps a unix-socket path at 104 bytes.
        std::env::temp_dir().join(format!("trmx235-{tag}-{}", std::process::id()))
    }

    fn mode_of(p: &Path) -> u32 {
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    /// An echo handler: answers `{ok:true, result:{echo:<line>}}` and counts calls.
    fn echo_process(calls: Arc<AtomicUsize>) -> Process {
        Arc::new(move |id, line| {
            calls.fetch_add(1, Ordering::SeqCst);
            Response::ok(id, Some(json!({ "echo": line })))
        })
    }

    /// ONE buffered reader per client for its whole life (a fresh BufReader per read would swallow a
    /// second response that arrived together with the first).
    fn client_reader(stream: UnixStream, timeout: Duration) -> BufReader<UnixStream> {
        let _ = stream.set_read_timeout(Some(timeout));
        BufReader::new(stream)
    }

    fn read_line(reader: &mut BufReader<UnixStream>) -> String {
        let mut raw = Vec::new();
        let _ = reader.read_until(b'\n', &mut raw);
        decode_response_line(&raw)
    }

    fn permit() -> Permit {
        Slots::new(MAX_WORKERS).try_acquire().unwrap()
    }

    // ---------- pure pieces (T1) ----------

    #[test]
    fn decode_response_line_is_utf8_and_trims_the_terminator() {
        let title = r#"{"id":1,"ok":true,"result":{"title":"vim — 日本語"}}"#;
        assert_eq!(decode_response_line(format!("{title}\n").as_bytes()), title);
        assert_eq!(
            decode_response_line(format!("{title}\r\n").as_bytes()),
            title
        );
        assert_eq!(decode_response_line(title.as_bytes()), title);
        // Malformed bytes degrade to U+FFFD, never to Latin-1 mojibake.
        let bad = decode_response_line(&[b'"', 0xE2, 0x80, b'"', b'\n']);
        assert!(bad.contains('\u{FFFD}'));
        assert!(!bad.contains('\u{00E2}'));
    }

    #[test]
    fn accept_errors_are_classified() {
        assert_eq!(
            accept_error_action(io::ErrorKind::WouldBlock),
            AcceptAction::Poll
        );
        assert_eq!(
            accept_error_action(io::ErrorKind::Interrupted),
            AcceptAction::RetryAfterDelay
        );
        assert_eq!(
            accept_error_action(io::ErrorKind::ConnectionAborted),
            AcceptAction::RetryAfterDelay
        );
        assert_eq!(
            accept_error_action(io::ErrorKind::Other),
            AcceptAction::Fatal
        );
        assert_eq!(
            accept_error_action(io::ErrorKind::OutOfMemory),
            AcceptAction::Fatal
        );
    }

    #[test]
    fn slots_reserve_atomically_and_release_on_drop() {
        let slots = Slots::new(2);
        let a = slots.try_acquire().expect("first");
        let b = slots.try_acquire().expect("second");
        assert!(slots.try_acquire().is_none(), "third must be refused");
        assert_eq!(slots.active(), 2);
        drop(a);
        assert_eq!(slots.active(), 1);
        assert!(slots.try_acquire().is_some(), "a released slot is reusable");
        drop(b);
    }

    #[test]
    fn resolve_pending_reports_a_late_reply() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = mpsc::channel();
        lock(&pending).insert(7, tx);
        assert!(resolve_pending(&pending, 7, json!({"ok": true})));
        assert!(rx.try_recv().is_ok());
        assert!(
            !resolve_pending(&pending, 7, json!({"ok": true})),
            "already answered"
        );
        assert!(!resolve_pending(&pending, 99, json!({})), "never pending");
    }

    #[test]
    fn reconcile_covers_all_four_outcomes() {
        assert_eq!(reconcile(true, false, false), Reconcile::Start);
        assert_eq!(reconcile(false, true, false), Reconcile::Stop);
        assert_eq!(reconcile(false, true, true), Reconcile::Stop);
        assert_eq!(reconcile(true, true, true), Reconcile::Restart);
        assert_eq!(reconcile(true, true, false), Reconcile::Noop);
        assert_eq!(reconcile(false, false, false), Reconcile::Noop);
    }

    #[test]
    fn ctl_read_deadline_outlives_the_server_timeout() {
        assert!(CTL_READ_TIMEOUT > REQUEST_TIMEOUT);
    }

    /// trmx-236 (L2): the private `lock()` helper RECOVERS the stored value from a poisoned mutex (a
    /// peer panicked while holding it) — the pending-sender map must stay usable. Deliberately different
    /// from the poller / credit-cell / Services-queue degrade policies, which are not changed.
    #[test]
    fn lock_recovers_a_poisoned_mutex() {
        let shared = Arc::new(Mutex::new(41u32));
        let poisoner = Arc::clone(&shared);
        let result = std::thread::spawn(move || {
            let mut g = poisoner.lock().unwrap();
            *g += 1;
            panic!("poison while holding the lock");
        })
        .join();
        assert!(result.is_err(), "the thread must have panicked");
        assert!(shared.lock().is_err(), "the mutex is poisoned");
        assert_eq!(
            *lock(&shared),
            42,
            "lock() recovers the value written before the panic"
        );
    }

    #[test]
    fn control_state_records_the_deterministic_flag() {
        assert!(!ControlState::default().deterministic);
        assert!(ControlState::new(true).deterministic);
    }

    // ---------- socket-path policy (T5/T6) ----------
    // trmx-239 (M12): the two `ensure_private_dir_default` unit tests moved to
    // `termixion-platform/src/socket.rs` with the function itself. What remains here exercises the
    // shell's ORCHESTRATION — which directory policy each SocketPathOrigin earns — through
    // `create_socket`, which is the part that stayed.

    #[test]
    fn override_parent_must_be_exactly_0700_and_is_never_chmoded() {
        let base = tmp_dir("ovr");
        std::fs::remove_dir_all(&base).ok();
        std::fs::create_dir_all(&base).unwrap();
        for mode in [0o755u32, 0o750, 0o300, 0o600, 0o770] {
            let dir = base.join(format!("m{mode:o}"));
            std::fs::create_dir(&dir).unwrap();
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(mode)).unwrap();
            let err = create_socket(&dir.join("c.sock"), SocketPathOrigin::Override)
                .err()
                .unwrap_or_else(|| panic!("mode {mode:o} must be refused"));
            assert!(err.contains("0700"), "{err}");
            assert_eq!(mode_of(&dir), mode, "mode {mode:o} must NOT be chmod-ed");
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let good = base.join("good");
        std::fs::create_dir(&good).unwrap();
        std::fs::set_permissions(&good, std::fs::Permissions::from_mode(0o700)).unwrap();
        let l = create_socket(&good.join("c.sock"), SocketPathOrigin::Override).expect("0700 ok");
        drop(l);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn override_parent_must_exist_be_real_and_the_path_absolute() {
        let base = tmp_dir("ovr2");
        std::fs::remove_dir_all(&base).ok();
        std::fs::create_dir_all(&base).unwrap();
        // missing parent → refused AND not created
        let missing = base.join("nope");
        assert!(create_socket(&missing.join("c.sock"), SocketPathOrigin::Override).is_err());
        assert!(!missing.exists(), "an override parent is never created");
        // symlinked parent → refused
        let real = base.join("real");
        std::fs::create_dir(&real).unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o700)).unwrap();
        let link = base.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(create_socket(&link.join("c.sock"), SocketPathOrigin::Override).is_err());
        // relative path → refused (docs/config.md: an absolute path)
        let err = create_socket(Path::new("rel/c.sock"), SocketPathOrigin::Override).unwrap_err();
        assert!(err.contains("absolute"), "{err}");
        assert!(!Path::new("rel").exists());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn create_socket_sets_perms_reclaims_stale_socket_but_not_a_live_one_or_a_regular_file() {
        let dir = tmp_dir("sock");
        std::fs::remove_dir_all(&dir).ok();
        let path = dir.join("control.sock");
        let listener = create_socket(&path, SocketPathOrigin::Default).expect("bind");
        assert_eq!(mode_of(&path), 0o600);
        assert_eq!(mode_of(&dir), 0o700);
        // A LIVE listener must NOT be clobbered.
        assert!(create_socket(&path, SocketPathOrigin::Default).is_err());
        // Drop the live listener → the file is now a STALE socket → reclaimable.
        drop(listener);
        let relisten =
            create_socket(&path, SocketPathOrigin::Default).expect("reclaim stale socket");
        drop(relisten);
        // A NON-socket at the path (a regular file) is REFUSED, never deleted (finding 4).
        std::fs::remove_file(&path).ok();
        std::fs::write(&path, b"not a socket").unwrap();
        assert!(create_socket(&path, SocketPathOrigin::Default).is_err());
        assert!(path.exists(), "the regular file must NOT have been deleted");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ---------- connection loop (T4) ----------

    #[test]
    fn connection_answers_each_line_and_closes_on_eof() {
        let (mut client, server) = UnixStream::pair().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let process = echo_process(calls.clone());
        let next_id = Arc::new(AtomicU64::new(1));
        let stop = Arc::new(AtomicBool::new(false));
        let worker = std::thread::spawn({
            let process = process.clone();
            move || handle_connection(server, &process, &next_id, permit(), &stop)
        });
        client
            .write_all(b"{\"cmd\":\"a\"}\n{\"cmd\":\"b\"}\n")
            .unwrap();
        let mut r = client_reader(client, Duration::from_secs(5));
        let first = read_line(&mut r);
        assert!(
            first.contains("\"id\":1") && first.contains("{\\\"cmd\\\":\\\"a\\\"}"),
            "{first}"
        );
        let second = read_line(&mut r);
        assert!(second.contains("\"id\":2"), "{second}");
        drop(r);
        worker.join().unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn connection_refuses_an_oversized_newline_free_line_without_dispatching() {
        let (mut client, server) = UnixStream::pair().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let process = echo_process(calls.clone());
        let next_id = Arc::new(AtomicU64::new(1));
        let stop = Arc::new(AtomicBool::new(false));
        let worker = std::thread::spawn({
            let process = process.clone();
            move || handle_connection(server, &process, &next_id, permit(), &stop)
        });
        let blob = vec![b'x'; MAX_LINE_BYTES + 1];
        client.write_all(&blob).unwrap(); // no newline, ever
        let mut r = client_reader(client, Duration::from_secs(5));
        let reply = read_line(&mut r);
        assert!(reply.contains("line-too-long"), "{reply}");
        // and the connection is closed: the next read is EOF
        let mut rest = Vec::new();
        assert_eq!(r.read_to_end(&mut rest).unwrap_or(0), 0);
        worker.join().unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 0, "never dispatched");
    }

    #[test]
    fn connection_rejects_invalid_utf8_without_dispatching() {
        let (mut client, server) = UnixStream::pair().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let process = echo_process(calls.clone());
        let next_id = Arc::new(AtomicU64::new(1));
        let stop = Arc::new(AtomicBool::new(false));
        let worker = std::thread::spawn({
            let process = process.clone();
            move || handle_connection(server, &process, &next_id, permit(), &stop)
        });
        client
            .write_all(b"{\"cmd\":\"send-text\",\"args\":{\"text\":\"\xFF\xFE\"}}\n")
            .unwrap();
        let mut r = client_reader(client, Duration::from_secs(5));
        let reply = read_line(&mut r);
        assert!(reply.contains("invalid-utf8"), "{reply}");
        drop(r);
        worker.join().unwrap();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "a malformed line never reaches process"
        );
    }

    #[test]
    fn connection_observes_the_stop_flag_between_lines() {
        let (mut client, server) = UnixStream::pair().unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let calls = Arc::new(AtomicUsize::new(0));
        // The handler flips `stop` while answering the FIRST request (deterministic: no sleep race).
        let process: Process = {
            let stop = stop.clone();
            let calls = calls.clone();
            Arc::new(move |id, _line| {
                calls.fetch_add(1, Ordering::SeqCst);
                stop.store(true, Ordering::SeqCst);
                Response::ok(id, None)
            })
        };
        let next_id = Arc::new(AtomicU64::new(1));
        let worker = std::thread::spawn({
            let process = process.clone();
            let stop = stop.clone();
            move || handle_connection(server, &process, &next_id, permit(), &stop)
        });
        client
            .write_all(b"{\"cmd\":\"one\"}\n{\"cmd\":\"two\"}\n")
            .unwrap();
        let mut r = client_reader(client, Duration::from_secs(5));
        let first = read_line(&mut r);
        assert!(first.contains("\"ok\":true"), "{first}");
        let mut rest = Vec::new();
        assert_eq!(
            r.read_to_end(&mut rest).unwrap_or(0),
            0,
            "closed after stop"
        );
        worker.join().unwrap();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "the second line was not processed"
        );
    }

    // ---------- acceptor + lifecycle (T3) ----------

    fn scripted_accept(
        script: Vec<io::Result<UnixStream>>,
    ) -> impl FnMut() -> io::Result<UnixStream> {
        let mut q: VecDeque<io::Result<UnixStream>> = script.into();
        move || {
            q.pop_front()
                .unwrap_or_else(|| Err(io::Error::other("script exhausted")))
        }
    }

    #[test]
    fn acceptor_retries_transient_errors_after_a_delay_and_dies_on_a_fatal_one() {
        let sleeps = Arc::new(AtomicUsize::new(0));
        let dead = Arc::new(AtomicBool::new(false));
        let script = vec![
            Err(io::Error::new(io::ErrorKind::Interrupted, "eintr")),
            Err(io::Error::new(io::ErrorKind::ConnectionAborted, "aborted")),
            Err(io::Error::other("emfile")),
        ];
        run_acceptor(
            scripted_accept(script),
            |_job| Ok(()),
            echo_process(Arc::new(AtomicUsize::new(0))),
            Arc::new(AtomicU64::new(1)),
            Slots::new(MAX_WORKERS),
            Arc::new(AtomicBool::new(false)),
            dead.clone(),
            {
                let sleeps = sleeps.clone();
                move |_d| {
                    sleeps.fetch_add(1, Ordering::SeqCst);
                }
            },
        );
        assert_eq!(
            sleeps.load(Ordering::SeqCst),
            2,
            "one delayed retry per transient error"
        );
        assert!(
            dead.load(Ordering::SeqCst),
            "a fatal error marks the listener dead"
        );
    }

    #[test]
    fn acceptor_answers_spawn_failed_and_releases_the_slot() {
        let (client, server) = UnixStream::pair().unwrap();
        let slots = Slots::new(MAX_WORKERS);
        let dead = Arc::new(AtomicBool::new(false));
        let script = vec![Ok(server), Err(io::Error::other("end"))];
        run_acceptor(
            scripted_accept(script),
            |_job| Err(io::Error::new(io::ErrorKind::WouldBlock, "no threads")),
            echo_process(Arc::new(AtomicUsize::new(0))),
            Arc::new(AtomicU64::new(1)),
            slots.clone(),
            Arc::new(AtomicBool::new(false)),
            dead,
            |_d| {},
        );
        let reply = read_line(&mut client_reader(client, Duration::from_secs(5)));
        assert!(reply.contains("spawn-failed"), "{reply}");
        assert_eq!(
            slots.active(),
            0,
            "the reserved slot is released when the spawn fails"
        );
    }

    #[test]
    fn acceptor_admits_at_most_max_workers_under_a_burst_and_reuses_released_slots() {
        let n = MAX_WORKERS + 4;
        let mut clients = Vec::new();
        let mut script = Vec::new();
        for _ in 0..n {
            let (c, s) = UnixStream::pair().unwrap();
            clients.push(c);
            script.push(Ok(s));
        }
        script.push(Err(io::Error::other("end")));
        let slots = Slots::new(MAX_WORKERS);
        // A spawn that PARKS the jobs (never runs them) so every admitted permit stays reserved.
        type Parked = Arc<Mutex<Vec<Box<dyn FnOnce() + Send>>>>;
        let parked: Parked = Arc::new(Mutex::new(Vec::new()));
        run_acceptor(
            scripted_accept(script),
            {
                let parked = parked.clone();
                move |job| {
                    lock(&parked).push(job);
                    Ok(())
                }
            },
            echo_process(Arc::new(AtomicUsize::new(0))),
            Arc::new(AtomicU64::new(1)),
            slots.clone(),
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
            |_d| {},
        );
        assert_eq!(slots.active(), MAX_WORKERS, "exactly MAX_WORKERS admitted");
        assert_eq!(lock(&parked).len(), MAX_WORKERS);
        let mut rejected = 0;
        for c in clients.iter_mut() {
            let _ = c.set_read_timeout(Some(Duration::from_millis(200)));
            let mut raw = Vec::new();
            let mut reader = BufReader::new(&*c);
            if reader.read_until(b'\n', &mut raw).unwrap_or(0) > 0
                && decode_response_line(&raw).contains("too-many-connections")
            {
                rejected += 1;
            }
        }
        assert_eq!(rejected, 4, "the excess clients get an explicit error");
        // Releasing one parked job (its permit drops) frees exactly one slot.
        let job = lock(&parked).pop().unwrap();
        drop(job);
        assert_eq!(slots.active(), MAX_WORKERS - 1);
        assert!(slots.try_acquire().is_some());
    }

    fn override_cfg(dir: &Path) -> RemoteControlConfig {
        RemoteControlConfig {
            enabled: true,
            socket_path: dir.join("c.sock").display().to_string(),
        }
    }

    fn private_dir(tag: &str) -> PathBuf {
        let dir = tmp_dir(tag);
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        dir
    }

    #[test]
    fn apply_with_leaves_no_listener_and_unlinks_when_the_acceptor_cannot_spawn() {
        let dir = private_dir("nospawn");
        let state = ControlState::default();
        let deps = ApplyDeps {
            create_socket: Box::new(create_socket),
            spawn_acceptor: Box::new(|_l, _stop, _dead| {
                Err(io::Error::new(io::ErrorKind::WouldBlock, "no threads"))
            }),
        };
        assert_eq!(
            apply_with(&override_cfg(&dir), &state, &deps),
            Reconcile::Start
        );
        assert!(lock(&state.listener).is_none(), "no acceptor → no handle");
        assert!(
            !dir.join("c.sock").exists(),
            "the orphaned socket is unlinked"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_fatal_accept_marks_the_installed_handle_dead_and_the_next_apply_restarts_it() {
        let dir = private_dir("restart");
        let path = dir.join("c.sock");
        let state = ControlState::default();
        // Production create_socket + production run_acceptor. The FIRST acceptor runs over a scripted accept
        // that dies at once (fatal); every later one is the real accept loop, so the restarted socket is live.
        let spawns = Arc::new(AtomicUsize::new(0));
        let deps = ApplyDeps {
            create_socket: Box::new(create_socket),
            spawn_acceptor: Box::new({
                let spawns = spawns.clone();
                move |listener, stop, dead| {
                    let n = spawns.fetch_add(1, Ordering::SeqCst);
                    std::thread::Builder::new().spawn(move || {
                        if n == 0 {
                            let _keep = listener; // the bound socket stays alive with this acceptor
                            run_acceptor(
                                scripted_accept(vec![Err(io::Error::other("emfile"))]),
                                |_job| Ok(()),
                                echo_process(Arc::new(AtomicUsize::new(0))),
                                Arc::new(AtomicU64::new(1)),
                                Slots::new(MAX_WORKERS),
                                stop,
                                dead,
                                |_d| {},
                            )
                        } else {
                            run_acceptor(
                                move || listener.accept().map(|(s, _)| s),
                                spawn_worker_thread,
                                echo_process(Arc::new(AtomicUsize::new(0))),
                                Arc::new(AtomicU64::new(1)),
                                Slots::new(MAX_WORKERS),
                                stop,
                                dead,
                                std::thread::sleep,
                            )
                        }
                    })
                }
            }),
        };
        let cfg = override_cfg(&dir);
        assert_eq!(apply_with(&cfg, &state, &deps), Reconcile::Start);
        // The acceptor thread exits after the fatal accept and marks THE INSTALLED handle's flag.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let dead = lock(&state.listener)
                .as_ref()
                .map(|h| h.dead.load(Ordering::SeqCst))
                .unwrap_or(false);
            if dead {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "acceptor never reported dead"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            apply_with(&cfg, &state, &deps),
            Reconcile::Restart,
            "the same enabled config must RESTART a dead listener"
        );
        assert_eq!(
            spawns.load(Ordering::SeqCst),
            2,
            "a second acceptor was spawned"
        );
        let guard = lock(&state.listener);
        let handle = guard.as_ref().expect("a fresh handle is installed");
        assert!(
            !handle.dead.load(Ordering::SeqCst),
            "the fresh handle starts alive"
        );
        assert!(path.exists(), "the socket is bound again at the same path");
        assert!(
            UnixStream::connect(&path).is_ok(),
            "a client can connect to the restarted socket"
        );
        drop(guard);
        shutdown(&state);
        assert!(!path.exists(), "shutdown unlinks");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn apply_with_stops_a_listener_when_disabled() {
        let dir = private_dir("stop");
        let path = dir.join("c.sock");
        let state = ControlState::default();
        let deps = ApplyDeps {
            create_socket: Box::new(create_socket),
            spawn_acceptor: Box::new(|listener, stop, dead| {
                std::thread::Builder::new().spawn(move || {
                    run_acceptor(
                        move || listener.accept().map(|(s, _)| s),
                        spawn_worker_thread,
                        echo_process(Arc::new(AtomicUsize::new(0))),
                        Arc::new(AtomicU64::new(1)),
                        Slots::new(MAX_WORKERS),
                        stop,
                        dead,
                        std::thread::sleep,
                    )
                })
            }),
        };
        let cfg = override_cfg(&dir);
        assert_eq!(apply_with(&cfg, &state, &deps), Reconcile::Start);
        assert!(path.exists());
        assert_eq!(
            apply_with(&cfg, &state, &deps),
            Reconcile::Noop,
            "already listening"
        );
        let off = RemoteControlConfig {
            enabled: false,
            ..cfg.clone()
        };
        assert_eq!(apply_with(&off, &state, &deps), Reconcile::Stop);
        assert!(!path.exists(), "stopped → unlinked");
        assert!(lock(&state.listener).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn deterministic_launch_never_opens_the_socket() {
        let dir = private_dir("det");
        let state = ControlState::new(true);
        let deps = ApplyDeps {
            create_socket: Box::new(
                |_p: &Path, _o: SocketPathOrigin| -> Result<ControlSocket, String> {
                    panic!("must not bind")
                },
            ),
            spawn_acceptor: Box::new(
                |_l: UnixListener,
                 _s: Arc<AtomicBool>,
                 _d: Arc<AtomicBool>|
                 -> io::Result<JoinHandle<()>> { panic!("must not spawn") },
            ),
        };
        assert_eq!(
            apply_with(&override_cfg(&dir), &state, &deps),
            Reconcile::Noop
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
