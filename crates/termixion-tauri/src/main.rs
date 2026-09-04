// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
// trmx-236: stdout/stderr are for stdio CONTRACTS only (the `ctl` JSON reply, --version/--help, the
// pre-builder usage errors, the fatal's stderr branch) — everything else goes through `log::*` into the
// logging sink (`logging.rs`). The two functions that hold contracts carry an explicit allowance.
#![deny(clippy::print_stdout, clippy::print_stderr)]
#![cfg_attr(test, allow(clippy::print_stdout, clippy::print_stderr))]
//! Termixion — the thin Tauri 2 desktop shell. Since trmx-74 it drives the multi-session
//! [`SessionRegistry`] (one session per tab) and streams each session to the xterm.js webview over
//! its own Tauri IPC `Channel` (ADR-0001): a dedicated thread per session runs the core reader
//! pump while `pty_write` / `pty_resize` / `close_pty` route by session id. trmx-75 (FR-2.4) adds
//! the tab-title plumbing: a 1 Hz foreground-name poller (condvar-parked at zero sessions via
//! [`PollerGate`]) emitting change-only `session:title-hint` events, which the frontend folds into
//! its own per-tab title state (the core holds no title since trmx-243). The session domain logic lives in `termixion-core`; this file is runtime glue
//! (validated by the C-3 packaged `--smoke` and `cargo tauri dev`) — the pure pieces
//! (`program_title`, [`poll_tick`], the payload wire shapes, the gate's park/wake) are unit-tested.
//! trmx-80 (FR-13) adds the `config_io` module: the `termixion.toml` read/write/reset commands and
//! the debounced config-file watcher that live-applies external edits as `settings:changed`.

use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{Emitter, Manager, WindowEvent};

mod close_gate;
mod config_io;
mod control;
mod enhancements_io;
mod fs_watch;
mod ipc_error;
mod launch;
mod logging;
mod menu;
mod poller;
mod pty_io;
mod scripts_io;
mod services_io;
mod shell_integration_io;
mod shells_io;
mod themes_io;
mod window_manager;

use close_gate::{
    ASK, ASK_GRACE, CloseOrigin, ExitAction, Outcome, QUIT_AUTHORIZED, ask_and_apply,
    close_acknowledged, exit_action, exit_gate_input, quit_confirmed, teardown_once,
    webview_close_request,
};
use poller::run_title_poller;
use pty_io::{PtyState, close_pty, open_pty, pty_ack, pty_resize, pty_write};

use launch::{
    CliQuery, PERF_WATCHDOG_SECS, SMOKE_WATCHDOG_SECS, SpecialLaunch, cli_query, launch_modes,
    perf_config, perf_done, perf_mode, perf_scenario, smoke_config, smoke_done, smoke_mode, usage,
    version_line,
};

/// Placeholder command exercising the frontend↔backend channel: reports the core version.
#[tauri::command]
fn core_version() -> String {
    termixion_platform::CORE_VERSION.to_string()
}

// stdio-contract: --version / --help / usage and the pre-builder launch-mode errors print to the
// terminal BEFORE any logger can exist; the post-run fatal keeps a stderr branch for when the sink
// never installed (see the end of this function).
#[allow(clippy::print_stdout, clippy::print_stderr)]
fn main() -> ExitCode {
    // trmx-101 (FR-9.4): `termixion ctl <…>` is a non-GUI CLI — connect to the control socket, send one
    // request, print the response, exit. An EARLY fork, before the tauri app is ever built.
    if std::env::args().nth(1).as_deref() == Some("ctl") {
        return control::run_ctl(std::env::args());
    }
    // trmx-146: --version/--help (and unknown-`--flag` rejection) answered here, after the ctl
    // fork and before ANY Tauri machinery — a CLI probe must exit cleanly, never side-effect a
    // second GUI instance (no window, no PTY, no updater, no watchdog threads).
    match cli_query(std::env::args().skip(1)) {
        CliQuery::Version => {
            // stdio-contract: --version → stdout (CLI contract, before the Tauri builder)
            println!("{}", version_line());
            return ExitCode::SUCCESS;
        }
        CliQuery::Help => {
            // stdio-contract: --help → stdout (CLI contract)
            println!("{}", usage());
            return ExitCode::SUCCESS;
        }
        CliQuery::UnknownFlag(flag) => {
            // Debug-format the flag: argv is attacker-adjacent input, and a raw echo could write
            // control bytes (ANSI/OSC) into the caller's terminal — {flag:?} escapes them.
            // stdio-contract: unrecognized flag → usage on stderr (CLI contract)
            eprintln!("termixion: unrecognized flag {flag:?}\n\n{}", usage());
            return ExitCode::from(2);
        }
        CliQuery::None => {}
    }
    let resolved = launch_modes(
        smoke_mode(
            std::env::args(),
            std::env::var("TERMIXION_SMOKE").ok(),
            std::env::var("DIR").ok(),
        ),
        perf_mode(
            std::env::args(),
            std::env::var("TERMIXION_PERF").ok(),
            std::env::var("TERMIXION_PERF_OUT").ok(),
        ),
    );
    let (smoke, perf) = match resolved {
        Ok(modes) => modes,
        Err(msg) => {
            // stdio-contract: launch-mode usage error before the builder (no logger yet)
            eprintln!("{msg}");
            return ExitCode::FAILURE;
        }
    };
    // trmx-101: a deterministic launch never opens the control socket (captured before smoke/perf move).
    let deterministic = smoke.is_some() || perf.is_some();
    if smoke.is_some() {
        // Watchdog: fail the smoke (exit 1) rather than hang if the webview never reports back. Generous
        // enough (trmx-102) that a slow headless webkit2gtk boot (software GL, no compositor, cold AppImage
        // extract on Linux CI) is not mistaken for a hang — the happy path exits in <5 s regardless.
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(SMOKE_WATCHDOG_SECS));
            log::error!(
                "termixion-smoke: FAIL — timed out waiting for the webview sentinel sequence"
            );
            std::process::exit(1);
        });
    }
    if perf.is_some() {
        // trmx-78: same discipline, sized to the harness's schedule (see PERF_WATCHDOG_SECS).
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(PERF_WATCHDOG_SECS));
            log::error!("termixion-perf: FAIL — timed out waiting for the webview perf driver");
            std::process::exit(1);
        });
    }

    let result = tauri::Builder::default()
        // trmx-48: auto-update (updater + relaunch) and opening external links from the About page.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        // trmx-145: the native pasteboard write — every frontend copy path (⌘C guard, auto-copy-on-
        // select, OSC 52) writes through this plugin's IPC, never the WKWebView pasteboard APIs
        // (whose writes reach other apps UTF-8-bytes-decoded-as-MacRoman: "—" pasted as "‚Äî").
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(PtyState::default())
        // trmx-224: directories from a Finder "New Termixion Tab Here" service invocation,
        // awaiting frontend pickup (services_io module docs describe the delivery contract).
        .manage(services_io::PendingOpenPaths::default())
        .manage(SpecialLaunch {
            smoke,
            perf,
            // trmx-103: pure read of args/env — harmless when perf is None (perf_config returns None).
            perf_scenario: perf_scenario(
                std::env::args(),
                std::env::var("TERMIXION_PERF_SCENARIO").ok(),
            ),
        })
        // trmx-80 (FR-13): the config backbone's state — the file-watch diff base + the
        // self-echo latch for our own writes.
        .manage(config_io::ConfigState::default())
        .manage(enhancements_io::EnhancementsState::default())
        // trmx-101 (FR-9.4): the opt-in external control channel's socket-listener state. A --smoke/--perf
        // launch is deterministic → the control socket NEVER opens (baked into ControlState, so EVERY
        // apply path — initial load, config write/reset, the watcher — is forced off).
        .manage(control::ControlState::new(deterministic))
        // trmx-48/trmx-51: install the app menu; "About Termixion" / "Settings…" open the
        // standalone Settings window (About lands on the About page). trmx-74 adds the Shell
        // submenu + Window tab-cycling items; trmx-75 adds Rename Tab… and spawns the
        // foreground-title poller (parked on its condvar gate until the first session opens).
        .setup(|app| {
            // trmx-236: the logging sink FIRST — from a caught path with a stdout-only fallback, so an
            // unwritable ~/Library/Logs never aborts the launch (logging.rs).
            let installed = logging::install(app.handle());
            if installed.sinks.is_empty() {
                // stdio-contract: the sink itself could not start — stderr is the only channel left
                // (this closure runs inside `main`, whose allowance covers it).
                eprintln!(
                    "termixion: logging unavailable ({}); continuing without a log sink",
                    installed.file_disabled_reason.as_deref().unwrap_or("unknown")
                );
            }
            // trmx-246 (grill L5): the ONE initial config read, from the Rust side — before the
            // menu (its accelerators need the `[keys]` map) and before any command can run. The
            // cache used to wait for the webview's first config_read; the JS boot order was the
            // only thing making a spawn see the configured shell.
            let config = config_io::hydrate(app.handle());
            let menu = menu::build_menu(app.handle(), &config.keys)?;
            app.set_menu(menu)?;
            let state = app.state::<PtyState>();
            let registry = Arc::clone(&state.registry);
            let gate = Arc::clone(&state.poller_gate);
            let poller_app = app.handle().clone();
            std::thread::spawn(move || run_title_poller(poller_app, registry, gate));
            // trmx-80 (FR-13): watch the config file's parent directory for external edits
            // (editors save via rename-replace) and live-apply them as `settings:changed`.
            let config_app = app.handle().clone();
            std::thread::spawn(move || config_io::run_config_watcher(config_app));
            // trmx-89 (FR-6): watch the themes directory for `*.toml` edits and signal the
            // frontend to re-read the user theme catalog via `themes:changed`.
            let themes_app = app.handle().clone();
            std::thread::spawn(move || themes_io::run_themes_watcher(themes_app));
            // trmx-93 (FR-5): watch the scripts directory TREE (recursive) for edits and signal the
            // frontend to re-read the script catalog via `scripts:changed`.
            let scripts_app = app.handle().clone();
            std::thread::spawn(move || scripts_io::run_scripts_watcher(scripts_app));
            // trmx-224: register the macOS Services provider ("New Termixion Tab Here").
            // setup() runs on the main thread inside applicationDidFinishLaunching — Apple's
            // recommended registration window. The callback enqueues BEFORE nudging (the
            // services_io contract), and Apple warns requests may arrive immediately after
            // registration, which the queue + frontend boot/registration drains absorb.
            #[cfg(target_os = "macos")]
            {
                let services_app = app.handle().clone();
                let registered = termixion_platform::services::register_open_paths_provider(
                    move |dirs| {
                        let paths: Vec<String> = dirs
                            .iter()
                            .map(|p| p.to_string_lossy().into_owned())
                            .collect();
                        services_io::enqueue(&services_app.state(), paths);
                        services_io::nudge(&services_app);
                    },
                );
                if !registered {
                    log::warn!("[termixion] services provider not registered (duplicate or off-main-thread)");
                }
            }
            // trmx-101 (FR-9.4): apply the remote-control state from the config at startup. A --smoke/--perf
            // launch NEVER opens the socket (the deterministic launches force it disabled).
            let special = app.state::<SpecialLaunch>();
            let deterministic = special.smoke.is_some() || special.perf.is_some();
            if !deterministic {
                control::apply_remote_control(
                    &app.handle().clone(),
                    &config.remote_control,
                    &app.state::<control::ControlState>(),
                );
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            // No unwrap/expect anywhere here: report and carry on rather than panic (a broken
            // menu item must not take the terminal down).
            match menu::menu_action(event.id().0.as_str()) {
                Some(menu::MenuAction::ShowSettings { section }) => {
                    if let Err(err) = window_manager::show_settings_window(app, section) {
                        log::error!("termixion: failed to open the settings window: {err}");
                    }
                }
                // trmx-74/94: the frontend owns tab/pane/window/settings state, so the menu broadcasts
                // the intent as a `tabs:action` event; App routes it through the command dispatch spine
                // (incl. window-close → window.close and app-settings → app.settings, trmx-94 finding 7).
                Some(menu::MenuAction::EmitTabsAction(action)) => {
                    // trmx-268: the close verbs go through the gate — ⌘Q's only effect used to be
                    // this emit, so a hung webview meant no native close, no CloseRequested, and no
                    // gate ever ran. Every other verb keeps its plain-string payload untouched.
                    if action == "window-close" {
                        let outcome = {
                            ask_and_apply(
                                &ASK,
                                CloseOrigin::Menu,
                                true,
                                QUIT_AUTHORIZED.load(std::sync::atomic::Ordering::SeqCst),
                                Instant::now(),
                                ASK_GRACE,
                                |event, generation| {
                                    app.emit(
                                        event,
                                        serde_json::json!({
                                            "action": "window-close",
                                            "gen": generation
                                        }),
                                    )
                                    .map_err(|e| e.to_string())
                                },
                            )
                        };
                        if outcome == Outcome::TeardownAndProceed {
                            QUIT_AUTHORIZED.store(true, std::sync::atomic::Ordering::SeqCst);
                            teardown_once(app);
                            app.exit(0);
                        }
                    } else if let Err(err) = app.emit("tabs:action", action) {
                        log::error!("termixion: failed to emit tabs:action ({action}): {err}");
                    }
                }
                None => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            core_version,
            services_io::take_pending_open_paths,
            open_pty,
            pty_write,
            pty_ack,
            pty_resize,
            close_pty,
            smoke_config,
            smoke_done,
            perf_config,
            perf_done,
            config_io::config_read,
            shells_io::shells_list,
            shells_io::effective_shell,
            config_io::config_write,
            config_io::config_reset_all,
            config_io::config_open_file,
            config_io::keys_read,
            window_manager::open_settings_window,
            themes_io::themes_read,
            themes_io::themes_write,
            themes_io::themes_open_dir,
            scripts_io::scripts_list,
            scripts_io::scripts_open_dir,
            shell_integration_io::shell_integration_reveal,
            control::control_response,
            logging::log_message,
            logging::log_dir,
            logging::log_open_dir,
            enhancements_io::enhancements_status,
            quit_confirmed,
            webview_close_request,
            close_acknowledged
        ])
        .on_window_event(|window, event| {
            // trmx-51: only the MAIN window owns the PTY sessions — closing the settings window
            // must leave the terminal alone. trmx-144: an UNCONFIRMED main-window close is vetoed
            // and bounced to the webview (which owns the busy state, the `terminal.confirmClose`
            // setting, and the dialog); once the webview calls `quit_confirmed` the re-driven
            // close lands here authorized. Closing main then kills every live session (trmx-74:
            // `registry.kill_all()`, no zombies) and takes the settings window with it, so the
            // app exits exactly as it did when main was the only window.
            if let WindowEvent::CloseRequested { api, .. } = event {
                // trmx-268: one gate for every origin. Deliver FIRST and veto only on success —
                // vetoing before the emit would strand the process whenever delivery fails.
                let outcome = {
                    ask_and_apply(
                        &ASK,
                        CloseOrigin::WindowClose,
                        window_manager::disposes_pty_for(window.label()),
                        QUIT_AUTHORIZED.load(std::sync::atomic::Ordering::SeqCst),
                        Instant::now(),
                        ASK_GRACE,
                        |event, generation| {
                            window
                                .emit_to(window.label(), event, generation)
                                .map_err(|e| e.to_string())
                        },
                    )
                };
                match outcome {
                    Outcome::Ignore => {}
                    Outcome::Vetoed => api.prevent_close(),
                    Outcome::TeardownAndProceed => {
                        // trmx-267: one shared implementation, so an exit/restart that never reaches
                        // this handler reaps the same way. The close is then ALLOWED through.
                        teardown_once(window.app_handle());
                    }
                }
            }
        })
        // trmx-267: `.build(ctx).map(|app| app.run(cb))` rather than `.run(ctx)` — `Builder::run` is
        // literally `self.build(context)?.run(|_, _| {})`, so this is the same call with a real
        // callback, and `map` preserves the `Result<()>` that `main`'s ExitCode contract binds (no `?`).
        // Without a RunEvent handler there is NO teardown on an exit or an updater restart: the
        // shells the user had open are orphaned, reparented and never reaped (trmx-267).
        .build(tauri::generate_context!())
        .map(|app| {
            app.run(|app_handle, event| match event {
                // The updater path: the frontend's `relaunch()` reaches `request_restart()`, which
                // always requests an exit with RESTART_EXIT_CODE. Reap, then let it proceed —
                // `api.prevent_exit()` is a documented no-op for this code, so vetoing would be
                // misleading rather than merely useless. Any other code is left to the window close
                // gate; trmx-268 owns user-quit consent and must see it first.
                tauri::RunEvent::ExitRequested { code, api, .. } => match exit_action(code) {
                    ExitAction::TeardownAndProceed => teardown_once(app_handle),
                    // trmx-268 fills the arm trmx-267 deliberately left empty. `code: None` is
                    // emitted AFTER the last window was removed, so there is nobody to ask and a
                    // veto would strand a windowless process: `exit_gate_input` maps it to a
                    // non-owner, which rule 1 answers `Ignore`.
                    ExitAction::LeaveToCloseGate => {
                        let alive = app_handle
                            .get_webview_window(window_manager::MAIN_WINDOW_LABEL)
                            .is_some();
                        if let Some(is_pty_owner) = exit_gate_input(code, alive) {
                            let outcome = {
                                ask_and_apply(
                                    &ASK,
                                    CloseOrigin::AppExit,
                                    is_pty_owner,
                                    QUIT_AUTHORIZED.load(std::sync::atomic::Ordering::SeqCst),
                                    Instant::now(),
                                    ASK_GRACE,
                                    |event, generation| {
                                        app_handle
                                            .emit_to(
                                                window_manager::MAIN_WINDOW_LABEL,
                                                event,
                                                generation,
                                            )
                                            .map_err(|e| e.to_string())
                                    },
                                )
                            };
                            match outcome {
                                Outcome::Ignore => {}
                                Outcome::Vetoed => api.prevent_exit(),
                                Outcome::TeardownAndProceed => teardown_once(app_handle),
                            }
                        }
                    }
                },
                // Last-resort net. Unconditional by design: the latch makes it a no-op whenever a
                // close path already ran, and a PREVENTED exit never reaches `Exit` at all. Tauri
                // dispatches this before it re-execs on a restart, so the reap still happens.
                tauri::RunEvent::Exit => teardown_once(app_handle),
                _ => {}
            })
        });

    if let Err(err) = result {
        // No unwrap/expect: report and exit non-zero rather than panic. trmx-236: ONCE — through the
        // logger when one installed (stdout + file), else to stderr (the sink is the likely culprit,
        // hence the hint). `log::max_level()` stays `Off` until a logger attaches.
        if log::max_level() == log::LevelFilter::Off {
            // stdio-contract: no logger installed — stderr is the only channel left.
            eprintln!(
                "termixion: fatal error running the app: {err}\n  (if the log sink failed to open ~/Library/Logs, set {}=1 to launch without the log file)",
                logging::NO_FILE_ENV
            );
        } else {
            log::error!("termixion: fatal error running the app: {err}");
        }
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
