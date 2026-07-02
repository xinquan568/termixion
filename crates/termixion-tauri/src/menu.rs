// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-48/trmx-51: the application menu. It carries the standard macOS app / Edit / Window
//! submenus plus two custom items — **About Termixion** and **Settings… (⌘,)**. Since trmx-51 both
//! open the standalone Settings window (About lands on the About page) via
//! `window_manager::show_settings_window` — there is no in-app overlay any more. The menu
//! construction is runtime glue (exercised by `cargo tauri dev` / the packaged app); the pure
//! id→action mapping is unit-tested.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

/// What a chosen menu item should do. Pure so it is unit-testable without a running app; the
/// runtime handler in `main.rs` performs the action.
#[derive(Debug, PartialEq, Eq)]
pub enum MenuAction {
    /// Open (or focus) the singleton Settings window, optionally landing on a section.
    ShowSettings { section: Option<&'static str> },
}

/// Map a chosen menu item id to its action: "About Termixion" opens Settings on the About page;
/// "Settings…" opens it on its default (first) page.
pub fn menu_action(id: &str) -> Option<MenuAction> {
    match id {
        "about" => Some(MenuAction::ShowSettings {
            section: Some("about"),
        }),
        "settings" => Some(MenuAction::ShowSettings { section: None }),
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
    fn about_opens_settings_on_the_about_page() {
        assert_eq!(
            menu_action("about"),
            Some(MenuAction::ShowSettings {
                section: Some("about")
            })
        );
    }

    #[test]
    fn settings_opens_the_settings_window_default_page() {
        assert_eq!(
            menu_action("settings"),
            Some(MenuAction::ShowSettings { section: None })
        );
    }

    #[test]
    fn other_items_map_to_no_action() {
        assert_eq!(menu_action("quit"), None);
        assert_eq!(menu_action(""), None);
        assert_eq!(menu_action("copy"), None);
    }
}
