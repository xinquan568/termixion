// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! Termixion — the thin Tauri 2 desktop shell: one window (configured in `tauri.conf.json`) plus the
//! default macOS app menu. B-3 is the runnable scaffold with a placeholder command that exercises the
//! frontend↔backend channel; B-5 / C wire the live PTY (the `termixion-platform` factory) across the
//! channel into the xterm.js surface.

use std::process::ExitCode;

use tauri::ipc::Channel;

/// Placeholder command exercising the frontend↔backend channel: reports the core version.
#[tauri::command]
fn core_version() -> String {
    termixion_platform::CORE_VERSION.to_string()
}

/// The single readiness frame B-5 sends over the PTY channel so the frontend can prove the round-trip.
/// C-2 replaces this with live PTY output bytes.
fn pty_ready_frame() -> Vec<u8> {
    b"channel-ready".to_vec()
}

/// PTY-bytes channel seam (B-5). The frontend opens a [`Channel`] and the backend streams bytes into
/// it; for now it sends one readiness frame. C-2 streams the live PTY (the `termixion-platform`
/// factory) output here instead.
#[tauri::command]
fn open_pty_channel(channel: Channel<Vec<u8>>) -> Result<(), String> {
    channel.send(pty_ready_frame()).map_err(|e| e.to_string())
}

fn main() -> ExitCode {
    let result = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![core_version, open_pty_channel])
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
        // The placeholder IPC command must report a non-empty version equal to the core crate's,
        // so the frontend↔backend channel has a real, asserted contract to exercise.
        let v = core_version();
        assert!(!v.is_empty(), "core version must not be empty");
        assert_eq!(v, termixion_platform::CORE_VERSION);
    }

    #[test]
    fn pty_ready_frame_is_the_channel_ready_marker() {
        // The B-5 PTY channel emits this readiness frame; the frontend decodes it to "channel-ready"
        // (see app/src/ipc/backend.test.ts) — both sides assert the same contract.
        assert_eq!(pty_ready_frame(), b"channel-ready".to_vec());
    }
}
