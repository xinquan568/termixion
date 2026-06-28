// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! Termixion — the thin Tauri 2 desktop shell. It owns the single terminal session and streams it to
//! the xterm.js webview over a Tauri IPC `Channel` (ADR-0001): a dedicated thread forwards PTY output
//! to the frontend while `pty_write` / `pty_resize` drive keystrokes and size back. The session domain
//! logic lives in `termixion-core`; this file is runtime glue (validated by the C-3 packaged `--smoke`
//! and `cargo tauri dev`, not headless unit tests).

use std::process::ExitCode;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::State;
use tauri::ipc::Channel;
use termixion_core::{PtySize, Session, SessionSpec};
use termixion_platform::MacosPtyFactory;

/// The single active terminal session (one window / one tab for v0.0.1). Command handlers `write`/
/// `resize` the session while the reader thread streams its output concurrently. `generation` tags
/// each `open_pty` so a stale reader thread only reaps the session **it** opened, never a replacement.
#[derive(Default)]
struct PtyState {
    generation: AtomicU64,
    slot: Arc<Mutex<Option<ActiveSession>>>,
}

/// A live session tagged with the generation that opened it.
struct ActiveSession {
    generation: u64,
    session: Session,
}

/// Placeholder command exercising the frontend↔backend channel: reports the core version.
#[tauri::command]
fn core_version() -> String {
    termixion_platform::CORE_VERSION.to_string()
}

/// Open the terminal session and stream its output to the webview over `channel` (ADR-0001). Spawns
/// the login shell at the given size, moves the blocking reader onto a dedicated thread that forwards
/// bytes to the channel, and stores the session so `pty_write`/`pty_resize` can drive it.
#[tauri::command]
fn open_pty(
    channel: Channel<Vec<u8>>,
    rows: u16,
    cols: u16,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let factory = MacosPtyFactory;
    let mut session = Session::spawn(
        1,
        &factory,
        &SessionSpec::login_shell(),
        PtySize::new(rows, cols),
    )
    .map_err(|e| e.to_string())?;

    let mut reader = session
        .take_reader()
        .ok_or_else(|| "pty backend exposes no readable stream".to_string())?;

    // Tag this open, then store the session BEFORE streaming so `pty_write` targets it immediately.
    // Replacing a prior session drops it here (kill + reap via Drop).
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut slot = state
            .slot
            .lock()
            .map_err(|_| "pty state poisoned".to_string())?;
        *slot = Some(ActiveSession {
            generation,
            session,
        });
    }

    // Output → webview on its own thread: reads block here while keystrokes are written concurrently.
    let slot = Arc::clone(&state.slot);
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break, // EOF (shell exited) or read error → stop streaming
                Ok(n) => {
                    if channel.send(buf[..n].to_vec()).is_err() {
                        break; // the webview/channel is gone
                    }
                }
            }
        }
        // Shell exited / stream ended: reap + clear OUR session — but only if it is still the current
        // one, so a replacement opened in the meantime (e.g. a re-open) is left untouched.
        if let Ok(mut slot) = slot.lock()
            && slot.as_ref().is_some_and(|a| a.generation == generation)
            && let Some(mut active) = slot.take()
        {
            let _ = active.session.kill();
        }
    });

    Ok(())
}

/// Send keystrokes (raw bytes from xterm `onData`) to the PTY.
#[tauri::command]
fn pty_write(data: Vec<u8>, state: State<'_, PtyState>) -> Result<(), String> {
    let mut slot = state
        .slot
        .lock()
        .map_err(|_| "pty state poisoned".to_string())?;
    let active = slot
        .as_mut()
        .ok_or_else(|| "no active pty session".to_string())?;
    active
        .session
        .write(&data)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Resize the PTY's character grid (from xterm `onResize`).
#[tauri::command]
fn pty_resize(rows: u16, cols: u16, state: State<'_, PtyState>) -> Result<(), String> {
    let mut slot = state
        .slot
        .lock()
        .map_err(|_| "pty state poisoned".to_string())?;
    let active = slot
        .as_mut()
        .ok_or_else(|| "no active pty session".to_string())?;
    active
        .session
        .resize(PtySize::new(rows, cols))
        .map_err(|e| e.to_string())
}

fn main() -> ExitCode {
    let result = tauri::Builder::default()
        .manage(PtyState::default())
        .invoke_handler(tauri::generate_handler![
            core_version,
            open_pty,
            pty_write,
            pty_resize
        ])
        .run(tauri::generate_context!());

    if let Err(err) = result {
        // No unwrap/expect: report and exit non-zero rather than panic.
        eprintln!("termixion: fatal error running the app: {err}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_version_reports_the_core_crate_version() {
        // The placeholder IPC command must report a non-empty version equal to the core crate's.
        let v = core_version();
        assert!(!v.is_empty(), "core version must not be empty");
        assert_eq!(v, termixion_platform::CORE_VERSION);
    }
}
