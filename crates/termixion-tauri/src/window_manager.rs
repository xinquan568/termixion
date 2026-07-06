// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-51: create-or-focus the **singleton Settings window** (vmark's `window_manager` pattern).
//! The menu's About/Settings items land here instead of emitting an overlay event: if the window
//! labeled `settings` exists it is unminimized/shown/focused (and told to navigate); otherwise it
//! is built at `index.html?window=settings[&section=…]`, which the frontend's `resolveSurface`
//! routes to the settings surface. The pure pieces (URL building, the PTY-disposal label
//! predicate) are unit-tested; the window creation itself is thin runtime glue like `build_menu`,
//! exercised by `cargo tauri dev` and the packaged smoke.

use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// The label of the singleton settings window.
pub const SETTINGS_WINDOW_LABEL: &str = "settings";
/// The label Tauri gives the first configured window (tauri.conf.json declares no explicit label).
pub const MAIN_WINDOW_LABEL: &str = "main";
/// Emitted (broadcast) so an already-open settings window switches page, e.g. to "about".
pub const SETTINGS_NAVIGATE_EVENT: &str = "settings:navigate";

// vmark's settings-window geometry: 760×540, floor 600×400.
const SETTINGS_WIDTH: f64 = 760.0;
const SETTINGS_HEIGHT: f64 = 540.0;
const SETTINGS_MIN_WIDTH: f64 = 600.0;
const SETTINGS_MIN_HEIGHT: f64 = 400.0;

/// The webview URL for the settings surface. Pure so the routing contract with the frontend's
/// `resolveSurface` stays unit-tested from both sides.
pub fn settings_url(section: Option<&str>) -> String {
    match section {
        Some(s) => format!("index.html?window=settings&section={s}"),
        None => "index.html?window=settings".to_string(),
    }
}

/// Only the main window owns the PTY session; closing the settings window must never dispose it.
pub fn disposes_pty_for(label: &str) -> bool {
    label == MAIN_WINDOW_LABEL
}

/// macOS Tauri window chrome only: `title_bar_style`/`hidden_title` are macOS-gated builder APIs
/// (the traffic lights float over the webview, which renders its own centered "Settings" title and
/// `data-tauri-drag-region` strips). Nothing domain-level lives behind this cfg — the R1/R2 seam
/// (termixion-core/-platform) is untouched.
#[cfg(target_os = "macos")]
fn apply_macos_titlebar<'a, R: Runtime>(
    builder: WebviewWindowBuilder<'a, R, AppHandle<R>>,
) -> WebviewWindowBuilder<'a, R, AppHandle<R>> {
    builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
}

#[cfg(not(target_os = "macos"))]
fn apply_macos_titlebar<'a, R: Runtime>(
    builder: WebviewWindowBuilder<'a, R, AppHandle<R>>,
) -> WebviewWindowBuilder<'a, R, AppHandle<R>> {
    builder
}

/// trmx-94 (FR-9): open the settings window from the FRONTEND — the command palette's `app.settings`
/// (no section) and `app.check-updates` (`section = "about"`, where the update controls live). Same
/// effect as the menu's ShowSettings path, reached through the command dispatch spine.
#[tauri::command]
pub fn open_settings_window(app: AppHandle, section: Option<String>) -> Result<(), String> {
    show_settings_window(&app, section.as_deref()).map_err(|error| error.to_string())
}

/// Create or focus the singleton settings window; with `section`, land on (or navigate an already
/// open window to) that page.
pub fn show_settings_window<R: Runtime>(
    app: &AppHandle<R>,
    section: Option<&str>,
) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW_LABEL) {
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
        let _ = window.show();
        let _ = window.set_focus();
        if let Some(s) = section {
            // Broadcast (vmark does the same): only the settings window listens for it.
            let _ = app.emit(SETTINGS_NAVIGATE_EVENT, s);
        }
        return Ok(());
    }

    let builder = WebviewWindowBuilder::new(
        app,
        SETTINGS_WINDOW_LABEL,
        WebviewUrl::App(settings_url(section).into()),
    )
    .title("Settings")
    .inner_size(SETTINGS_WIDTH, SETTINGS_HEIGHT)
    .min_inner_size(SETTINGS_MIN_WIDTH, SETTINGS_MIN_HEIGHT)
    .resizable(true)
    // Built hidden, then centered and shown, to avoid a position flash (vmark's recipe).
    .visible(false)
    .focused(true);
    let window = apply_macos_titlebar(builder).build()?;
    let _ = window.center();
    let _ = window.show();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_url_routes_the_frontend_surface() {
        assert_eq!(settings_url(None), "index.html?window=settings");
        assert_eq!(
            settings_url(Some("about")),
            "index.html?window=settings&section=about"
        );
    }

    #[test]
    fn only_the_main_window_disposes_the_pty() {
        assert!(disposes_pty_for("main"));
        assert!(!disposes_pty_for("settings"));
        assert!(!disposes_pty_for(""));
        assert!(!disposes_pty_for("mainsettings"));
    }

    #[test]
    fn the_singleton_label_is_stable() {
        // The capability file and the close-with-main wiring reference this label literally.
        assert_eq!(SETTINGS_WINDOW_LABEL, "settings");
        assert_eq!(MAIN_WINDOW_LABEL, "main");
    }

    #[test]
    fn the_settings_window_capability_grants_start_dragging() {
        // trmx-54: the Overlay-titlebar settings window has no native titlebar, so dragging only
        // works when the webview's `data-tauri-drag-region` chrome may invoke `start_dragging` —
        // a permission that is NOT part of core:window:default and must stay explicitly granted.
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("capabilities/default.json parses as JSON");
        let strings = |key: &str| -> Vec<String> {
            capability[key]
                .as_array()
                .unwrap_or_else(|| panic!("capability declares `{key}`"))
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        };
        assert!(
            strings("windows").contains(&SETTINGS_WINDOW_LABEL.to_owned()),
            "the capability must target the settings window"
        );
        assert!(
            strings("permissions").contains(&"core:window:allow-start-dragging".to_owned()),
            "the settings window drag regions need core:window:allow-start-dragging"
        );
    }
}
