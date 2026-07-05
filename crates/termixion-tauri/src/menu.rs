// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-48/trmx-51/trmx-74/trmx-75/trmx-84/trmx-90: the application menu. It carries the standard macOS app
//! / Edit / Window submenus plus the custom items — **About Termixion** and **Settings… (⌘,)**
//! (both open the standalone Settings window via `window_manager::show_settings_window`; About
//! lands on the About page) — and, since trmx-74, the tab surface: a **Shell** submenu (New Tab
//! ⌘T, Close Tab ⌘W, Rename Tab… since trmx-75, Set Badge… ⇧⌘B since trmx-90, Split Right ⌘D /
//! Split Below ⇧⌘D since trmx-84, Close Window ⇧⌘W) plus Window-menu tab cycling (Show
//! Previous/Next Tab ⇧⌘[ / ⇧⌘]). ⌘W now
//! belongs to Close Tab, so the Window submenu drops the predefined close item and closing the
//! window moves to ⇧⌘W. The menu construction is runtime glue (exercised by `cargo tauri dev` /
//! the packaged app); the pure id→action mapping is unit-tested.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Runtime};

/// What a chosen menu item should do. Pure so it is unit-testable without a running app; the
/// runtime handler in `main.rs` performs the action.
#[derive(Debug, PartialEq, Eq)]
pub enum MenuAction {
    /// Open (or focus) the singleton Settings window, optionally landing on a section.
    ShowSettings { section: Option<&'static str> },
    /// Broadcast the carried verb ("new" / "close" / "next" / "prev" / "rename" / "set-badge" /
    /// "split-right" / "split-below") as a `tabs:action` event — the frontend tab/pane manager owns
    /// the state, so the menu only announces intent (trmx-74; split verbs trmx-84; badge verb trmx-90).
    EmitTabsAction(&'static str),
    /// Close the main terminal window (⇧⌘W) — ⌘W closes a tab now, not the window (trmx-74).
    CloseMainWindow,
}

/// Map a chosen menu item id to its action: "About Termixion" opens Settings on the About page;
/// "Settings…" opens it on its default (first) page; the Shell/Window tab items broadcast their
/// tab verb; "Close Window" closes the main window (trmx-74).
pub fn menu_action(id: &str) -> Option<MenuAction> {
    match id {
        "about" => Some(MenuAction::ShowSettings {
            section: Some("about"),
        }),
        "settings" => Some(MenuAction::ShowSettings { section: None }),
        "shell-new-tab" => Some(MenuAction::EmitTabsAction("new")),
        "shell-close-tab" => Some(MenuAction::EmitTabsAction("close")),
        // trmx-75: Rename Tab… — the frontend opens the inline rename input on the active tab.
        "shell-rename-tab" => Some(MenuAction::EmitTabsAction("rename")),
        // trmx-90: Set Badge… — the frontend opens the badge editor on the focused pane.
        "shell-set-badge" => Some(MenuAction::EmitTabsAction("set-badge")),
        // trmx-84 (FR-3.2): split the focused pane — right (⌘D) or below (⇧⌘D).
        "shell-split-right" => Some(MenuAction::EmitTabsAction("split-right")),
        "shell-split-below" => Some(MenuAction::EmitTabsAction("split-below")),
        "shell-close-window" => Some(MenuAction::CloseMainWindow),
        "window-next-tab" => Some(MenuAction::EmitTabsAction("next")),
        "window-prev-tab" => Some(MenuAction::EmitTabsAction("prev")),
        // trmx-86 (FR-3.5): keyboard pane navigation — directional (⌥⌘-arrows) + cyclic (⌘] / ⌘[).
        "window-pane-left" => Some(MenuAction::EmitTabsAction("pane-left")),
        "window-pane-right" => Some(MenuAction::EmitTabsAction("pane-right")),
        "window-pane-up" => Some(MenuAction::EmitTabsAction("pane-up")),
        "window-pane-down" => Some(MenuAction::EmitTabsAction("pane-down")),
        "window-pane-next" => Some(MenuAction::EmitTabsAction("pane-next")),
        "window-pane-prev" => Some(MenuAction::EmitTabsAction("pane-prev")),
        _ => None,
    }
}

/// Build the full application menu. The app submenu leads with the custom About/Settings items;
/// Shell carries the trmx-74 tab lifecycle (new/close tab, close window); Edit and Window carry
/// the predefined items a terminal window expects (copy/paste, minimize) plus the trmx-74 tab
/// cycling — but NOT the predefined close item, whose ⌘W accelerator belongs to Close Tab now.
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

    // trmx-74: the tab lifecycle, Terminal.app-style — ⌘T/⌘W act on tabs, ⇧⌘W on the window.
    let new_tab = MenuItem::with_id(
        handle,
        "shell-new-tab",
        "New Tab",
        true,
        Some("CmdOrCtrl+T"),
    )?;
    let close_tab = MenuItem::with_id(
        handle,
        "shell-close-tab",
        "Close Tab",
        true,
        Some("CmdOrCtrl+W"),
    )?;
    // trmx-75: manual rename, directly below Close Tab. Deliberately NO accelerator — the fast
    // path is double-clicking the tab label; the menu item exists for discoverability and for
    // keyboard-only access via macOS menu navigation.
    let rename_tab = MenuItem::with_id(
        handle,
        "shell-rename-tab",
        "Rename Tab…",
        true,
        None::<&str>,
    )?;
    // trmx-90 (per-pane badges): edit the focused pane's badge — a per-surface label editor like
    // Rename Tab…, so it sits alongside it. ⇧⌘B opens the editor; the frontend owns the badge state.
    let set_badge = MenuItem::with_id(
        handle,
        "shell-set-badge",
        "Set Badge…",
        true,
        Some("Shift+CmdOrCtrl+B"),
    )?;
    // trmx-84 (FR-3.2): split the focused pane. ⌘D adds a pane to the right, ⇧⌘D below. The
    // frontend pane manager owns the layout tree; the menu only announces the split intent.
    let split_right = MenuItem::with_id(
        handle,
        "shell-split-right",
        "Split Right",
        true,
        Some("CmdOrCtrl+D"),
    )?;
    let split_below = MenuItem::with_id(
        handle,
        "shell-split-below",
        "Split Below",
        true,
        Some("Shift+CmdOrCtrl+D"),
    )?;
    let close_window = MenuItem::with_id(
        handle,
        "shell-close-window",
        "Close Window",
        true,
        Some("Shift+CmdOrCtrl+W"),
    )?;
    let shell_menu = Submenu::with_items(
        handle,
        "Shell",
        true,
        &[
            &new_tab,
            &close_tab,
            &rename_tab,
            &set_badge,
            &PredefinedMenuItem::separator(handle)?,
            &split_right,
            &split_below,
            &PredefinedMenuItem::separator(handle)?,
            &close_window,
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

    // trmx-74: tab cycling lives here (Terminal.app puts it in Window); the predefined close item
    // is gone — its ⌘W accelerator moved to Shell ▸ Close Tab.
    let prev_tab = MenuItem::with_id(
        handle,
        "window-prev-tab",
        "Show Previous Tab",
        true,
        Some("Shift+CmdOrCtrl+["),
    )?;
    let next_tab = MenuItem::with_id(
        handle,
        "window-next-tab",
        "Show Next Tab",
        true,
        Some("Shift+CmdOrCtrl+]"),
    )?;
    // trmx-86 (FR-3.5): keyboard pane navigation. Directional focus with ⌥⌘-arrows, cyclic with ⌘] / ⌘[
    // (shift-free, so distinct from the ⇧⌘[ / ⇧⌘] tab cycling above). The frontend pane manager owns
    // focus; these items only announce the intent verb.
    let pane_left = MenuItem::with_id(
        handle,
        "window-pane-left",
        "Select Pane Left",
        true,
        Some("Alt+CmdOrCtrl+Left"),
    )?;
    let pane_right = MenuItem::with_id(
        handle,
        "window-pane-right",
        "Select Pane Right",
        true,
        Some("Alt+CmdOrCtrl+Right"),
    )?;
    let pane_up = MenuItem::with_id(
        handle,
        "window-pane-up",
        "Select Pane Above",
        true,
        Some("Alt+CmdOrCtrl+Up"),
    )?;
    let pane_down = MenuItem::with_id(
        handle,
        "window-pane-down",
        "Select Pane Below",
        true,
        Some("Alt+CmdOrCtrl+Down"),
    )?;
    let pane_next = MenuItem::with_id(
        handle,
        "window-pane-next",
        "Select Next Pane",
        true,
        Some("CmdOrCtrl+]"),
    )?;
    let pane_prev = MenuItem::with_id(
        handle,
        "window-pane-prev",
        "Select Previous Pane",
        true,
        Some("CmdOrCtrl+["),
    )?;
    let window_menu = Submenu::with_items(
        handle,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &prev_tab,
            &next_tab,
            &PredefinedMenuItem::separator(handle)?,
            &pane_left,
            &pane_right,
            &pane_up,
            &pane_down,
            &pane_next,
            &pane_prev,
        ],
    )?;

    Menu::with_items(handle, &[&app_menu, &shell_menu, &edit_menu, &window_menu])
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
    fn shell_tab_items_broadcast_their_tab_verbs() {
        // trmx-74: New/Close Tab announce intent; the frontend tab manager acts on it.
        assert_eq!(
            menu_action("shell-new-tab"),
            Some(MenuAction::EmitTabsAction("new"))
        );
        assert_eq!(
            menu_action("shell-close-tab"),
            Some(MenuAction::EmitTabsAction("close"))
        );
        // trmx-75: Rename Tab… broadcasts "rename"; the frontend opens the inline rename input
        // on the active tab. Deliberately no accelerator — double-click is the fast path.
        assert_eq!(
            menu_action("shell-rename-tab"),
            Some(MenuAction::EmitTabsAction("rename"))
        );
        // trmx-90: Set Badge… (⇧⌘B) broadcasts "set-badge"; the frontend opens the badge editor
        // on the focused pane. Like Rename Tab…, it edits a per-surface label.
        assert_eq!(
            menu_action("shell-set-badge"),
            Some(MenuAction::EmitTabsAction("set-badge"))
        );
    }

    #[test]
    fn shell_split_items_broadcast_their_split_verbs() {
        // trmx-84 (FR-3.2): Split Right/Below announce the split; the frontend pane manager acts.
        assert_eq!(
            menu_action("shell-split-right"),
            Some(MenuAction::EmitTabsAction("split-right"))
        );
        assert_eq!(
            menu_action("shell-split-below"),
            Some(MenuAction::EmitTabsAction("split-below"))
        );
    }

    #[test]
    fn window_tab_cycling_items_broadcast_their_tab_verbs() {
        // trmx-74: ⇧⌘[ / ⇧⌘] cycle tabs via the same tabs:action broadcast.
        assert_eq!(
            menu_action("window-next-tab"),
            Some(MenuAction::EmitTabsAction("next"))
        );
        assert_eq!(
            menu_action("window-prev-tab"),
            Some(MenuAction::EmitTabsAction("prev"))
        );
    }

    #[test]
    fn window_pane_nav_items_broadcast_their_pane_verbs() {
        // trmx-86 (FR-3.5): Select Pane Left/Right/Above/Below + Next/Previous Pane announce the verb.
        for (id, verb) in [
            ("window-pane-left", "pane-left"),
            ("window-pane-right", "pane-right"),
            ("window-pane-up", "pane-up"),
            ("window-pane-down", "pane-down"),
            ("window-pane-next", "pane-next"),
            ("window-pane-prev", "pane-prev"),
        ] {
            assert_eq!(menu_action(id), Some(MenuAction::EmitTabsAction(verb)));
        }
    }

    #[test]
    fn close_window_closes_the_main_window_not_a_tab() {
        // trmx-74: ⌘W belongs to Close Tab; the window itself closes via ⇧⌘W.
        assert_eq!(
            menu_action("shell-close-window"),
            Some(MenuAction::CloseMainWindow)
        );
    }

    #[test]
    fn other_items_map_to_no_action() {
        assert_eq!(menu_action("quit"), None);
        assert_eq!(menu_action(""), None);
        assert_eq!(menu_action("copy"), None);
        // Near-misses of the trmx-74/trmx-75 ids stay unmapped too.
        assert_eq!(menu_action("shell-close"), None);
        assert_eq!(menu_action("window-tab"), None);
        assert_eq!(menu_action("new-tab"), None);
        assert_eq!(menu_action("shell-rename"), None);
        assert_eq!(menu_action("rename-tab"), None);
        // trmx-84 near-misses of the split ids stay unmapped.
        assert_eq!(menu_action("shell-split"), None);
        assert_eq!(menu_action("split-right"), None);
        assert_eq!(menu_action("shell-split-up"), None);
        // trmx-86 near-misses of the pane-nav ids stay unmapped.
        assert_eq!(menu_action("window-pane"), None);
        assert_eq!(menu_action("pane-left"), None);
        assert_eq!(menu_action("window-pane-forward"), None);
        // trmx-90 near-misses of the set-badge id stay unmapped.
        assert_eq!(menu_action("shell-badge"), None);
        assert_eq!(menu_action("set-badge"), None);
        assert_eq!(menu_action("shell-set"), None);
    }
}
