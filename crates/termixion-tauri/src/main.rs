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
use std::time::Duration;

use tauri::ipc::Channel;
use tauri::{Manager, State, WindowEvent};
use termixion_core::{PtySize, Session, SessionSpec};
use termixion_platform::MacosPtyFactory;

mod menu;
mod window_manager;

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
    smoke: State<'_, SmokeDir>,
) -> Result<(), String> {
    let factory = MacosPtyFactory;
    // Production opens the user's login shell; the `--smoke` run opens a deterministic rc-free shell
    // (`zsh -f`) so the automated sentinel sequence isn't garbled by the user's prompt / line editor —
    // the transport (channel, pty_write, streaming) is still the production path.
    let spec = if smoke.0.is_some() {
        let mut s = SessionSpec::shell("/bin/zsh");
        s.args.push("-f".into());
        s
    } else {
        SessionSpec::login_shell()
    };
    let mut session =
        Session::spawn(1, &factory, &spec, PtySize::new(rows, cols)).map_err(|e| e.to_string())?;

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

/// The end-to-end `--smoke` target dir, exposed to the webview so it drives the production path (C-3).
struct SmokeDir(Option<String>);

/// Whether/how the packaged smoke runs. `MissingDir` (smoke requested but no `DIR`) must FAIL the gate,
/// not silently launch the app — otherwise the packaged `--smoke` would hang CI instead of exiting 1.
enum SmokeMode {
    Off,
    MissingDir,
    On(String),
}

/// Resolve smoke mode: `--smoke` arg OR truthy `TERMIXION_SMOKE` enables it; the sentinel dir is the
/// `DIR` env var (the pre-created `mktemp -d` holding `SMOKE_OK`). Pure, for testing.
fn smoke_mode<I: IntoIterator<Item = String>>(
    args: I,
    smoke_env: Option<String>,
    dir_env: Option<String>,
) -> SmokeMode {
    let enabled = args.into_iter().any(|a| a == "--smoke")
        || smoke_env.is_some_and(|v| v == "1" || v == "true");
    if !enabled {
        return SmokeMode::Off;
    }
    match dir_env.filter(|d| !d.is_empty()) {
        Some(dir) => SmokeMode::On(dir),
        None => SmokeMode::MissingDir,
    }
}

/// The webview asks whether to run the end-to-end smoke, and against which dir (`None` = normal launch).
#[tauri::command]
fn smoke_config(smoke: State<'_, SmokeDir>) -> Option<String> {
    smoke.0.clone()
}

/// The webview reports the smoke result; exit the process `0`/`1` so the packaged `--smoke` is a gate.
#[tauri::command]
fn smoke_done(success: bool, reason: String) {
    if success {
        println!("termixion-smoke: OK — {reason}");
        std::process::exit(0);
    }
    eprintln!("termixion-smoke: FAIL — {reason}");
    std::process::exit(1);
}

/// Dispose the active session (no zombie) — used on window close.
fn dispose_session(state: &PtyState) {
    if let Ok(mut slot) = state.slot.lock()
        && let Some(mut active) = slot.take()
    {
        let _ = active.session.kill();
    }
}

fn main() -> ExitCode {
    let smoke = match smoke_mode(
        std::env::args(),
        std::env::var("TERMIXION_SMOKE").ok(),
        std::env::var("DIR").ok(),
    ) {
        SmokeMode::Off => None,
        SmokeMode::On(dir) => Some(dir),
        SmokeMode::MissingDir => {
            eprintln!("termixion-smoke: FAIL — smoke requested but DIR is missing/empty");
            return ExitCode::FAILURE;
        }
    };
    if smoke.is_some() {
        // Watchdog: fail the smoke (exit 1) rather than hang if the webview never reports back.
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(30));
            eprintln!(
                "termixion-smoke: FAIL — timed out waiting for the webview sentinel sequence"
            );
            std::process::exit(1);
        });
    }

    let result = tauri::Builder::default()
        // trmx-48: auto-update (updater + relaunch) and opening external links from the About page.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(PtyState::default())
        .manage(SmokeDir(smoke))
        // trmx-48/trmx-51: install the app menu; "About Termixion" / "Settings…" open the
        // standalone Settings window (About lands on the About page).
        .setup(|app| {
            let menu = menu::build_menu(app.handle())?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if let Some(menu::MenuAction::ShowSettings { section }) =
                menu::menu_action(event.id().0.as_str())
                && let Err(err) = window_manager::show_settings_window(app, section)
            {
                // No unwrap/expect: report and carry on rather than panic (a broken menu item
                // must not take the terminal down).
                eprintln!("termixion: failed to open the settings window: {err}");
            }
        })
        .invoke_handler(tauri::generate_handler![
            core_version,
            open_pty,
            pty_write,
            pty_resize,
            smoke_config,
            smoke_done
        ])
        .on_window_event(|window, event| {
            // trmx-51: only the MAIN window owns the PTY — closing the settings window must leave
            // the terminal session alone. Closing main disposes the PTY and takes the settings
            // window with it, so the app exits exactly as it did when main was the only window.
            if let WindowEvent::CloseRequested { .. } = event {
                if !window_manager::disposes_pty_for(window.label()) {
                    return;
                }
                if let Some(state) = window.try_state::<PtyState>() {
                    dispose_session(&state);
                }
                if let Some(settings) = window
                    .app_handle()
                    .get_webview_window(window_manager::SETTINGS_WINDOW_LABEL)
                {
                    let _ = settings.close();
                }
            }
        })
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

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn mode(args_v: &[&str], smoke_env: Option<&str>, dir_env: Option<&str>) -> SmokeMode {
        smoke_mode(
            args(args_v),
            smoke_env.map(str::to_string),
            dir_env.map(str::to_string),
        )
    }

    #[test]
    fn smoke_mode_resolves_off_on_and_missing_dir() {
        let on = "/tmp/termixion-smoke";

        // Enabled (arg or env) WITH DIR → On(dir).
        assert!(matches!(mode(&["app", "--smoke"], None, Some(on)), SmokeMode::On(d) if d == on));
        assert!(matches!(mode(&["app"], Some("1"), Some(on)), SmokeMode::On(d) if d == on));

        // Not enabled → Off, even with DIR set.
        assert!(matches!(mode(&["app"], None, Some(on)), SmokeMode::Off));

        // Enabled but DIR missing/empty → MissingDir (the gate fails fast, never launches normally).
        assert!(matches!(
            mode(&["app", "--smoke"], None, None),
            SmokeMode::MissingDir
        ));
        assert!(matches!(
            mode(&["app", "--smoke"], None, Some("")),
            SmokeMode::MissingDir
        ));
    }
}
