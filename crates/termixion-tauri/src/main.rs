// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! Termixion — the thin Tauri 2 desktop shell. Since trmx-74 it drives the multi-session
//! [`SessionRegistry`] (one session per tab) and streams each session to the xterm.js webview over
//! its own Tauri IPC `Channel` (ADR-0001): a dedicated thread per session runs the core reader
//! pump while `pty_write` / `pty_resize` / `close_pty` route by session id. The session domain
//! logic lives in `termixion-core`; this file is runtime glue (validated by the C-3 packaged
//! `--smoke` and `cargo tauri dev`) — the pure pieces (`program_title`, the payload wire shapes)
//! are unit-tested.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::ipc::Channel;
use tauri::{Emitter, Manager, State, WindowEvent};
use termixion_core::{PtySize, SessionRegistry, SessionSpec};
use termixion_platform::MacosPtyFactory;

mod menu;
mod window_manager;

/// The live terminal sessions (trmx-74): one per tab, keyed by the registry's monotonic
/// **never-reused** ids. That id discipline replaces the old single-slot generation counter — a
/// stale reader thread reaping its own id after that session is gone is an idempotent no-op that
/// can never touch another session (documented in `termixion_core::registry`).
#[derive(Default)]
struct PtyState {
    registry: Arc<Mutex<SessionRegistry>>,
}

/// What `open_pty` returns to the webview: the id every later `pty_write`/`pty_resize`/`close_pty`
/// routes by, plus the initial tab title (trmx-74). camelCase so the frontend sees `sessionId`.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    session_id: u64,
    title: String,
}

/// Payload of the `pty:exited` event: the child of session `session_id` ended (shell exit, kill,
/// or read error), so the frontend drops exactly that tab (trmx-74).
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyExited {
    session_id: u64,
}

/// The initial tab title for a spawned program: the basename of its path, lossy UTF-8
/// (`/bin/zsh` → `zsh`), falling back to `"shell"` when there is no basename. Pure, unit-tested.
fn program_title(program: &OsStr) -> String {
    Path::new(program)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "shell".to_string())
}

/// Placeholder command exercising the frontend↔backend channel: reports the core version.
#[tauri::command]
fn core_version() -> String {
    termixion_platform::CORE_VERSION.to_string()
}

/// Open a terminal session and stream its output to the webview over `channel` (ADR-0001). Spawns
/// the login shell — at `cwd` when the frontend passes one (trmx-74: new tabs inherit the active
/// tab's directory) — via the registry, moves the blocking reader onto a dedicated thread running
/// the core pump, and returns the session id + initial title. When the stream ends the session is
/// reaped and `pty:exited` tells the frontend to drop exactly that tab.
#[tauri::command]
fn open_pty(
    app: tauri::AppHandle,
    channel: Channel<Vec<u8>>,
    rows: u16,
    cols: u16,
    cwd: Option<String>,
    state: State<'_, PtyState>,
    smoke: State<'_, SmokeDir>,
) -> Result<SessionInfo, String> {
    // Production opens the user's login shell; the `--smoke` run opens a deterministic rc-free
    // shell (`zsh -f`, ignoring any `cwd`) so the automated sentinel sequence isn't garbled by the
    // user's prompt / line editor — the transport (channel, pty_write, streaming) is still the
    // production path.
    let spec = if smoke.0.is_some() {
        let mut s = SessionSpec::shell("/bin/zsh");
        s.args.push("-f".into());
        s
    } else {
        let mut s = SessionSpec::login_shell();
        if let Some(dir) = cwd {
            s.cwd = Some(PathBuf::from(dir));
        }
        s
    };

    let (id, reader) = state
        .registry
        .lock()
        .map_err(|_| "pty state poisoned".to_string())?
        .spawn(&MacosPtyFactory, &spec, PtySize::new(rows, cols))
        .map_err(|e| e.to_string())?;

    // Output → webview on a dedicated thread (ADR-0001) via the core pump. On stream end the
    // session is reaped — `registry.close(id)` is idempotent and ids are never reused, so this
    // stale-safe reap can never touch a newer session — and `pty:exited` is emitted best-effort
    // (the webview may already be gone during shutdown).
    let registry = Arc::clone(&state.registry);
    std::thread::spawn(move || {
        termixion_core::pump(
            reader,
            |chunk| channel.send(chunk.to_vec()).is_ok(),
            move || {
                let _ = registry.lock().map(|mut r| r.close(id));
                let _ = app.emit("pty:exited", PtyExited { session_id: id });
            },
        );
    });

    Ok(SessionInfo {
        session_id: id,
        title: program_title(&spec.program),
    })
}

/// Send keystrokes (raw bytes from xterm `onData`) to the session's PTY.
#[tauri::command]
fn pty_write(session_id: u64, data: Vec<u8>, state: State<'_, PtyState>) -> Result<(), String> {
    state
        .registry
        .lock()
        .map_err(|_| "pty state poisoned".to_string())?
        .write(session_id, &data)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Resize the session's PTY character grid (from xterm `onResize`).
#[tauri::command]
fn pty_resize(
    session_id: u64,
    rows: u16,
    cols: u16,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    state
        .registry
        .lock()
        .map_err(|_| "pty state poisoned".to_string())?
        .resize(session_id, PtySize::new(rows, cols))
        .map_err(|e| e.to_string())
}

/// Close a session (tab closed by the user, trmx-74). Idempotent: closing an id that already
/// exited (e.g. the reader thread reaped it first) is `Ok(())`.
#[tauri::command]
fn close_pty(session_id: u64, state: State<'_, PtyState>) -> Result<(), String> {
    state
        .registry
        .lock()
        .map_err(|_| "pty state poisoned".to_string())?
        .close(session_id)
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
        // standalone Settings window (About lands on the About page). trmx-74 adds the Shell
        // submenu + Window tab-cycling items.
        .setup(|app| {
            let menu = menu::build_menu(app.handle())?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            // No unwrap/expect anywhere here: report and carry on rather than panic (a broken
            // menu item must not take the terminal down).
            match menu::menu_action(event.id().0.as_str()) {
                Some(menu::MenuAction::ShowSettings { section }) => {
                    if let Err(err) = window_manager::show_settings_window(app, section) {
                        eprintln!("termixion: failed to open the settings window: {err}");
                    }
                }
                // trmx-74: the frontend tab manager owns tab state, so the menu just broadcasts
                // the intent ("new"/"close"/"next"/"prev") as a `tabs:action` event.
                Some(menu::MenuAction::EmitTabsAction(action)) => {
                    if let Err(err) = app.emit("tabs:action", action) {
                        eprintln!("termixion: failed to emit tabs:action ({action}): {err}");
                    }
                }
                // trmx-74: ⌘W closes a tab now; Close Window (⇧⌘W) closes the main window, which
                // kills every session via the CloseRequested handler below.
                Some(menu::MenuAction::CloseMainWindow) => {
                    if let Some(window) = app.get_webview_window(window_manager::MAIN_WINDOW_LABEL)
                    {
                        let _ = window.close();
                    }
                }
                None => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            core_version,
            open_pty,
            pty_write,
            pty_resize,
            close_pty,
            smoke_config,
            smoke_done
        ])
        .on_window_event(|window, event| {
            // trmx-51: only the MAIN window owns the PTY sessions — closing the settings window
            // must leave the terminal alone. Closing main kills every live session (trmx-74:
            // `registry.kill_all()`, no zombies) and takes the settings window with it, so the
            // app exits exactly as it did when main was the only window.
            if let WindowEvent::CloseRequested { .. } = event {
                if !window_manager::disposes_pty_for(window.label()) {
                    return;
                }
                if let Some(state) = window.try_state::<PtyState>()
                    && let Ok(mut registry) = state.registry.lock()
                {
                    registry.kill_all();
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

    #[test]
    fn program_title_is_the_program_basename_with_a_shell_fallback() {
        // A path yields its basename; a plain name passes through unchanged.
        assert_eq!(program_title(OsStr::new("/bin/zsh")), "zsh");
        assert_eq!(program_title(OsStr::new("/opt/homebrew/bin/fish")), "fish");
        assert_eq!(program_title(OsStr::new("bash")), "bash");
        // No basename at all falls back to a generic tab title.
        assert_eq!(program_title(OsStr::new("")), "shell");
        assert_eq!(program_title(OsStr::new("/")), "shell");
    }

    #[test]
    fn session_payloads_serialize_camel_case_for_the_frontend() {
        // The frontend destructures `sessionId` from open_pty's return and the `pty:exited`
        // payload (trmx-74) — pin the wire shape.
        let info = serde_json::to_value(SessionInfo {
            session_id: 7,
            title: "zsh".to_string(),
        })
        .expect("SessionInfo serializes");
        assert_eq!(info, serde_json::json!({ "sessionId": 7, "title": "zsh" }));

        let exited =
            serde_json::to_value(PtyExited { session_id: 42 }).expect("PtyExited serializes");
        assert_eq!(exited, serde_json::json!({ "sessionId": 42 }));
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
