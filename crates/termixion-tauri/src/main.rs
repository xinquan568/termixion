// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! Termixion — the thin Tauri 2 desktop shell: one window (configured in `tauri.conf.json`) plus the
//! default macOS app menu. B-3 is the runnable scaffold with a placeholder command that exercises the
//! frontend↔backend channel; B-5 / C wire the live PTY (the `termixion-platform` factory) across the
//! channel into the xterm.js surface.

use std::process::ExitCode;

/// Placeholder command exercising the frontend↔backend channel: reports the core version.
#[tauri::command]
fn core_version() -> String {
    termixion_platform::CORE_VERSION.to_string()
}

fn main() -> ExitCode {
    let result = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![core_version])
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
}
