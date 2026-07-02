// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-48: the application menu. It carries the standard macOS app / Edit / Window submenus plus two
//! custom items — **About Termixion** and **Settings… (⌘,)** — that both emit the `open-settings`
//! webview event so the frontend opens the Settings → About overlay. The menu construction is runtime
//! glue (exercised by `cargo tauri dev` / the packaged app); the pure id→event mapping is unit-tested.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

/// The webview event emitted when a settings-opening menu item is chosen (matches the frontend's
/// `useSettingsMenu` subscription).
pub const OPEN_SETTINGS_EVENT: &str = "open-settings";

/// Map a chosen menu item id to the webview signal it should emit. Pure so it is unit-testable without a
/// running app: both "About Termixion" and "Settings…" open the single Settings → About page.
pub fn menu_event_signal(id: &str) -> Option<&'static str> {
    match id {
        "about" | "settings" => Some(OPEN_SETTINGS_EVENT),
        _ => None,
    }
}

/// Build the full application menu. The app submenu leads with the custom About/Settings items; Edit and
/// Window carry the predefined items a terminal window expects (copy/paste, minimize, close).
pub fn build_menu<R: Runtime>(handle: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let about = MenuItem::with_id(handle, "about", "About Termixion", true, None::<&str>)?;
    let settings = MenuItem::with_id(handle, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;

    let app_menu = Submenu::with_items(
        handle,
        "Termixion",
        true,
        &[
            &about,
            &PredefinedMenuItem::separator(handle)?,
            &settings,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::hide(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::quit(handle, None)?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        handle,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::close_window(handle, None)?,
        ],
    )?;

    Menu::with_items(handle, &[&app_menu, &edit_menu, &window_menu])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn about_and_settings_open_the_settings_overlay() {
        assert_eq!(menu_event_signal("about"), Some(OPEN_SETTINGS_EVENT));
        assert_eq!(menu_event_signal("settings"), Some(OPEN_SETTINGS_EVENT));
    }

    #[test]
    fn other_items_emit_nothing() {
        assert_eq!(menu_event_signal("quit"), None);
        assert_eq!(menu_event_signal(""), None);
        assert_eq!(menu_event_signal("copy"), None);
    }
}
