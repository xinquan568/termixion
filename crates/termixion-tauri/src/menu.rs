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
}

/// Map a chosen menu item id to its action: "About Termixion" opens Settings on the About page;
/// "Settings…" opens it on its default (first) page; the Shell/Window tab items broadcast their
/// tab verb; "Close Window" closes the main window (trmx-74).
pub fn menu_action(id: &str) -> Option<MenuAction> {
    match id {
        "about" => Some(MenuAction::ShowSettings {
            section: Some("about"),
        }),
        // trmx-94 (FR-9): Settings routes through the frontend dispatch spine (app.settings), not the
        // Rust ShowSettings shortcut — so palette + menu share one path. (About stays ShowSettings: it
        // is not a command, just a shortcut to the About page.)
        "settings" => Some(MenuAction::EmitTabsAction("app-settings")),
        "shell-new-tab" => Some(MenuAction::EmitTabsAction("new")),
        // trmx-93 (FR-5): open the script picker to create the surface running the chosen script.
        "shell-new-tab-with-script" => Some(MenuAction::EmitTabsAction("new-with-script")),
        "shell-split-right-with-script" => {
            Some(MenuAction::EmitTabsAction("split-right-with-script"))
        }
        "shell-split-below-with-script" => {
            Some(MenuAction::EmitTabsAction("split-below-with-script"))
        }
        "shell-close-tab" => Some(MenuAction::EmitTabsAction("close")),
        // trmx-75: Rename Tab… — the frontend opens the inline rename input on the active tab.
        "shell-rename-tab" => Some(MenuAction::EmitTabsAction("rename")),
        // trmx-90: Set Badge… — the frontend opens the badge editor on the focused pane.
        "shell-set-badge" => Some(MenuAction::EmitTabsAction("set-badge")),
        // trmx-84 (FR-3.2): split the focused pane — right (⌘D) or below (⇧⌘D).
        "shell-split-right" => Some(MenuAction::EmitTabsAction("split-right")),
        "shell-split-below" => Some(MenuAction::EmitTabsAction("split-below")),
        // trmx-94 (FR-9): Close Window routes through dispatch (window.close) — the frontend's
        // closeWindow seam closes the main window, same as the last-tab-close path.
        "shell-close-window" => Some(MenuAction::EmitTabsAction("window-close")),
        // trmx-144: Quit rides the SAME gated window-close flow — a predefined quit item would
        // app.exit() directly and bypass the CloseRequested confirm-before-quit gate.
        "shell-quit" => Some(MenuAction::EmitTabsAction("window-close")),
        "window-next-tab" => Some(MenuAction::EmitTabsAction("next")),
        "window-prev-tab" => Some(MenuAction::EmitTabsAction("prev")),
        // trmx-86 (FR-3.5): keyboard pane navigation — directional (⌥⌘-arrows) + cyclic (⌘] / ⌘[).
        "window-pane-left" => Some(MenuAction::EmitTabsAction("pane-left")),
        "window-pane-right" => Some(MenuAction::EmitTabsAction("pane-right")),
        "window-pane-up" => Some(MenuAction::EmitTabsAction("pane-up")),
        "window-pane-down" => Some(MenuAction::EmitTabsAction("pane-down")),
        "window-pane-next" => Some(MenuAction::EmitTabsAction("pane-next")),
        "window-pane-prev" => Some(MenuAction::EmitTabsAction("pane-prev")),
        // trmx-94 (FR-9): the command palette (⇧⌘P) + clear scrollback. Verbs route through the
        // frontend dispatch spine like every other command-backed item.
        "shell-command-palette" => Some(MenuAction::EmitTabsAction("palette")),
        "shell-clear-scrollback" => Some(MenuAction::EmitTabsAction("clear-scrollback")),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// trmx-94 (FR-9.3): native accelerators are built from the EFFECTIVE keymap (defaults ⊕ `[keys]`),
// so a user rebind/unbind of a chord actually changes/removes the native menu accelerator (a static
// one would still fire a chord the user unbound). Pure helpers, unit-tested.
// ---------------------------------------------------------------------------

use std::collections::BTreeMap;

/// The command-backed menu items whose accelerator is user-configurable: `(menu_id, command_id,
/// default_chord)`. The default chords mirror the frontend `FULL_DEFAULT_KEYS`.
const MENU_COMMAND_CHORDS: &[(&str, &str, &str)] = &[
    ("shell-new-tab", "tab.new", "cmd+t"),
    // trmx-94: ⌘W closes the FOCUSED PANE (pane precedence); tab.close (whole tab) is palette-only.
    ("shell-close-tab", "pane.close", "cmd+w"),
    ("shell-close-window", "window.close", "cmd+shift+w"),
    (
        "shell-new-tab-with-script",
        "tab.new-with-script",
        "cmd+shift+t",
    ),
    ("shell-set-badge", "pane.set-badge", "cmd+shift+b"),
    ("shell-split-right", "pane.split-right", "cmd+d"),
    ("shell-split-below", "pane.split-below", "cmd+shift+d"),
    (
        "shell-command-palette",
        "app.command-palette",
        "cmd+shift+p",
    ),
    ("settings", "app.settings", "cmd+,"),
    ("window-next-tab", "tab.next", "cmd+shift+]"),
    ("window-prev-tab", "tab.prev", "cmd+shift+["),
];

/// Convert a chord string ("cmd+shift+p") to a Tauri accelerator ("Shift+CmdOrCtrl+P"): `cmd`→
/// `CmdOrCtrl`, `shift`→`Shift`, `alt`→`Alt`, `ctrl`→`Control`; a single-letter key is upper-cased.
fn to_tauri_accel(chord: &str) -> String {
    let mut mods: Vec<&str> = Vec::new();
    let mut key = String::new();
    for part in chord.split('+') {
        match part {
            "cmd" | "meta" => mods.push("CmdOrCtrl"),
            "shift" => mods.push("Shift"),
            "alt" | "option" => mods.push("Alt"),
            "ctrl" | "control" => mods.push("Control"),
            other => {
                key = if other.chars().count() == 1 {
                    other.to_uppercase()
                } else {
                    // Named keys map to Tauri's spellings (Left/Right/Up/Down/Enter/…): capitalize.
                    let mut chars = other.chars();
                    match chars.next() {
                        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                        None => String::new(),
                    }
                };
            }
        }
    }
    mods.push(&key);
    mods.join("+")
}

/// Whether a chord may back a NATIVE accelerator — mirrors the frontend `keychord.validateBinding`
/// so a hostile `[keys]` file can't steal ⌘C/⌘V or a terminal key via the menu: it must carry `cmd`
/// (or `ctrl+shift`), must not be the ⌘C/⌘V clipboard chords, and must have exactly one valid key.
fn chord_is_bindable(chord: &str) -> bool {
    let (mut cmd, mut ctrl, mut alt, mut shift) = (false, false, false, false);
    let mut key: Option<String> = None;
    for part in chord.split('+') {
        match part {
            "cmd" | "meta" => cmd = true,
            "ctrl" | "control" => ctrl = true,
            "alt" | "option" | "opt" => alt = true,
            "shift" => shift = true,
            other if !other.is_empty() => {
                if key.is_some() {
                    return false; // two keys
                }
                key = Some(other.to_lowercase());
            }
            _ => return false, // empty part
        }
    }
    let Some(key) = key else { return false }; // no key
    // Must carry cmd (or ctrl+shift) — non-cmd terminal chords are not bindable.
    if !(cmd || (ctrl && shift)) {
        return false;
    }
    // ⌘C / ⌘V (cmd-only) are reserved for copy/paste.
    if cmd && !ctrl && !alt && !shift && (key == "c" || key == "v") {
        return false;
    }
    true
}

/// The effective accelerator for a menu item, given its command + default chord and the user `[keys]`
/// map. A REBIND (a valid user chord maps to the command) wins; otherwise the default stands UNLESS it
/// was unbound (`"none"`) or reassigned to another command (then the item loses its accelerator).
fn effective_accelerator(
    command_id: &str,
    default_chord: &str,
    keys: &BTreeMap<String, String>,
) -> Option<String> {
    // A user rebind — the first (deterministic BTreeMap order) VALID chord mapped to this command. An
    // invalid/hostile chord (⌘C/⌘V, non-cmd, malformed) is skipped so it never becomes an accelerator.
    for (chord, cmd) in keys {
        if cmd == command_id && chord_is_bindable(chord) {
            return Some(to_tauri_accel(chord));
        }
    }
    match keys.get(default_chord).map(String::as_str) {
        Some("none") => None,                       // explicitly unbound
        Some(other) if other != command_id => None, // the default chord now belongs to another command
        _ => Some(to_tauri_accel(default_chord)),   // the default stands
    }
}

/// The accelerator for a command-backed menu item id under the current `[keys]` map (None if the id
/// is not command-backed or the chord was unbound).
fn accel_for(menu_id: &str, keys: &BTreeMap<String, String>) -> Option<String> {
    MENU_COMMAND_CHORDS
        .iter()
        .find(|(id, _, _)| *id == menu_id)
        .and_then(|(_, command_id, default_chord)| {
            effective_accelerator(command_id, default_chord, keys)
        })
}

/// Build the full application menu. The app submenu leads with the custom About/Settings items;
/// Shell carries the trmx-74 tab lifecycle (new/close tab, close window); Edit and Window carry
/// the predefined items a terminal window expects (copy/paste, minimize) plus the trmx-74 tab
/// cycling — but NOT the predefined close item, whose ⌘W accelerator belongs to Close Tab now.
pub fn build_menu<R: Runtime>(handle: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    // trmx-94: native accelerators come from the EFFECTIVE keymap (defaults ⊕ user [keys]).
    let keys = crate::config_io::keys_read();
    let about = MenuItem::with_id(handle, "about", "About Termixion", true, None::<&str>)?;
    let settings = MenuItem::with_id(
        handle,
        "settings",
        "Settings…",
        true,
        accel_for("settings", &keys).as_deref(),
    )?;

    // trmx-144: a CUSTOM quit item, not PredefinedMenuItem::quit — the predefined one calls
    // app.exit() and would bypass the CloseRequested confirm-before-quit gate; this one rides the
    // gated window-close flow (see menu_action) so ⌘Q gets the same confirmation as ⇧⌘W.
    let quit = MenuItem::with_id(
        handle,
        "shell-quit",
        "Quit Termixion",
        true,
        Some("CmdOrCtrl+Q"),
    )?;
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
            &quit,
        ],
    )?;

    // trmx-74: the tab lifecycle, Terminal.app-style — ⌘T/⌘W act on tabs, ⇧⌘W on the window.
    let new_tab = MenuItem::with_id(
        handle,
        "shell-new-tab",
        "New Tab",
        true,
        accel_for("shell-new-tab", &keys).as_deref(),
    )?;
    // trmx-93 (FR-5): open the script picker, then run the chosen script in a fresh tab (⇧⌘T).
    let new_tab_with_script = MenuItem::with_id(
        handle,
        "shell-new-tab-with-script",
        "New Tab with Script…",
        true,
        accel_for("shell-new-tab-with-script", &keys).as_deref(),
    )?;
    let close_tab = MenuItem::with_id(
        handle,
        "shell-close-tab",
        "Close Tab",
        true,
        accel_for("shell-close-tab", &keys).as_deref(),
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
        accel_for("shell-set-badge", &keys).as_deref(),
    )?;
    // trmx-84 (FR-3.2): split the focused pane. ⌘D adds a pane to the right, ⇧⌘D below. The
    // frontend pane manager owns the layout tree; the menu only announces the split intent.
    let split_right = MenuItem::with_id(
        handle,
        "shell-split-right",
        "Split Right",
        true,
        accel_for("shell-split-right", &keys).as_deref(),
    )?;
    let split_below = MenuItem::with_id(
        handle,
        "shell-split-below",
        "Split Below",
        true,
        accel_for("shell-split-below", &keys).as_deref(),
    )?;
    // trmx-93 (FR-5): split, then run the chosen script in the new pane. Un-accelerated for now —
    // the FR-9 command palette (#94) is the fast path; these stay discoverable menu items.
    let split_right_with_script = MenuItem::with_id(
        handle,
        "shell-split-right-with-script",
        "Split Right with Script…",
        true,
        None::<&str>,
    )?;
    let split_below_with_script = MenuItem::with_id(
        handle,
        "shell-split-below-with-script",
        "Split Below with Script…",
        true,
        None::<&str>,
    )?;
    let close_window = MenuItem::with_id(
        handle,
        "shell-close-window",
        "Close Window",
        true,
        accel_for("shell-close-window", &keys).as_deref(),
    )?;
    // trmx-94 (FR-9.2): the command palette (⇧⌘P, keymap-driven) + Clear Scrollback (palette/menu-only).
    let command_palette = MenuItem::with_id(
        handle,
        "shell-command-palette",
        "Command Palette…",
        true,
        accel_for("shell-command-palette", &keys).as_deref(),
    )?;
    let clear_scrollback = MenuItem::with_id(
        handle,
        "shell-clear-scrollback",
        "Clear Scrollback",
        true,
        None::<&str>,
    )?;
    let shell_menu = Submenu::with_items(
        handle,
        "Shell",
        true,
        &[
            &new_tab,
            &new_tab_with_script,
            &close_tab,
            &rename_tab,
            &set_badge,
            &PredefinedMenuItem::separator(handle)?,
            &command_palette,
            &clear_scrollback,
            &PredefinedMenuItem::separator(handle)?,
            &split_right,
            &split_below,
            &split_right_with_script,
            &split_below_with_script,
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
        accel_for("window-prev-tab", &keys).as_deref(),
    )?;
    let next_tab = MenuItem::with_id(
        handle,
        "window-next-tab",
        "Show Next Tab",
        true,
        accel_for("window-next-tab", &keys).as_deref(),
    )?;
    // trmx-86 (FR-3.5): keyboard pane navigation. Directional focus with ⌥⌘-arrows, cyclic with ⌘] / ⌘[
    // (shift-free, so distinct from the ⇧⌘[ / ⇧⌘] tab cycling above). The frontend pane manager owns
    // focus; these items only announce the intent verb.
    let pane_left = MenuItem::with_id(
        handle,
        "window-pane-left",
        "Select Pane Left",
        true,
        None::<&str>,
    )?;
    let pane_right = MenuItem::with_id(
        handle,
        "window-pane-right",
        "Select Pane Right",
        true,
        None::<&str>,
    )?;
    let pane_up = MenuItem::with_id(
        handle,
        "window-pane-up",
        "Select Pane Above",
        true,
        None::<&str>,
    )?;
    let pane_down = MenuItem::with_id(
        handle,
        "window-pane-down",
        "Select Pane Below",
        true,
        None::<&str>,
    )?;
    let pane_next = MenuItem::with_id(
        handle,
        "window-pane-next",
        "Select Next Pane",
        true,
        None::<&str>,
    )?;
    let pane_prev = MenuItem::with_id(
        handle,
        "window-pane-prev",
        "Select Previous Pane",
        true,
        None::<&str>,
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
    fn quit_routes_through_the_gated_window_close() {
        // trmx-144: Quit is a CUSTOM item mapped to the same window-close flow the ⇧⌘W item uses —
        // the predefined quit item would app.exit() directly and bypass the CloseRequested
        // confirm-before-quit gate.
        assert_eq!(
            menu_action("shell-quit"),
            Some(MenuAction::EmitTabsAction("window-close"))
        );
    }

    #[test]
    fn settings_routes_through_dispatch() {
        // trmx-94 (FR-9): Settings routes through the command spine (app.settings), not ShowSettings.
        assert_eq!(
            menu_action("settings"),
            Some(MenuAction::EmitTabsAction("app-settings"))
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
    fn shell_script_items_broadcast_their_script_verbs() {
        // trmx-93 (FR-5): the "with Script…" items announce their intent; the frontend opens the
        // script picker and runs the chosen script in a new tab / split pane.
        assert_eq!(
            menu_action("shell-new-tab-with-script"),
            Some(MenuAction::EmitTabsAction("new-with-script"))
        );
        assert_eq!(
            menu_action("shell-split-right-with-script"),
            Some(MenuAction::EmitTabsAction("split-right-with-script"))
        );
        assert_eq!(
            menu_action("shell-split-below-with-script"),
            Some(MenuAction::EmitTabsAction("split-below-with-script"))
        );
    }

    #[test]
    fn shell_command_items_broadcast_their_verbs() {
        // trmx-94 (FR-9): the command palette + clear scrollback announce their intent; the frontend
        // routes them through the dispatch spine.
        assert_eq!(
            menu_action("shell-command-palette"),
            Some(MenuAction::EmitTabsAction("palette"))
        );
        assert_eq!(
            menu_action("shell-clear-scrollback"),
            Some(MenuAction::EmitTabsAction("clear-scrollback"))
        );
    }

    #[test]
    fn to_tauri_accel_converts_chords() {
        assert_eq!(to_tauri_accel("cmd+t"), "CmdOrCtrl+T");
        assert_eq!(to_tauri_accel("cmd+shift+p"), "CmdOrCtrl+Shift+P");
        assert_eq!(to_tauri_accel("cmd+alt+left"), "CmdOrCtrl+Alt+Left");
    }

    #[test]
    fn effective_accelerator_honors_rebind_and_none_unbind() {
        use std::collections::BTreeMap;
        // No overrides → the default stands.
        let empty = BTreeMap::new();
        assert_eq!(
            effective_accelerator("pane.split-right", "cmd+d", &empty),
            Some("CmdOrCtrl+D".to_string())
        );
        // A "none" unbind → the item loses its accelerator (a static one would still fire ⌘D).
        let mut unbound = BTreeMap::new();
        unbound.insert("cmd+d".to_string(), "none".to_string());
        assert_eq!(
            effective_accelerator("pane.split-right", "cmd+d", &unbound),
            None
        );
        // A rebind → the new chord becomes the accelerator.
        let mut rebound = BTreeMap::new();
        rebound.insert(
            "cmd+shift+enter".to_string(),
            "pane.split-right".to_string(),
        );
        assert_eq!(
            effective_accelerator("pane.split-right", "cmd+d", &rebound),
            Some("CmdOrCtrl+Shift+Enter".to_string())
        );
        // The default chord reassigned to ANOTHER command → this item loses its accelerator.
        let mut reassigned = BTreeMap::new();
        reassigned.insert("cmd+d".to_string(), "tab.new".to_string());
        assert_eq!(
            effective_accelerator("pane.split-right", "cmd+d", &reassigned),
            None
        );
        // A HOSTILE rebind to ⌘C is refused — it must NOT become a native accelerator (else the menu
        // would steal clipboard input). The default stands. (finding 2)
        let mut hostile = BTreeMap::new();
        hostile.insert("cmd+c".to_string(), "pane.split-right".to_string());
        assert_eq!(
            effective_accelerator("pane.split-right", "cmd+d", &hostile),
            Some("CmdOrCtrl+D".to_string())
        );
        assert!(
            !chord_is_bindable("cmd+c") && !chord_is_bindable("cmd+v") && !chord_is_bindable("a")
        );
        assert!(chord_is_bindable("cmd+shift+enter") && chord_is_bindable("cmd+d"));
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
    fn close_window_routes_through_dispatch() {
        // trmx-94 (FR-9): Close Window (⇧⌘W) emits the window-close verb → dispatch(window.close).
        assert_eq!(
            menu_action("shell-close-window"),
            Some(MenuAction::EmitTabsAction("window-close"))
        );
        // Settings routes through dispatch too (About stays a ShowSettings shortcut).
        assert_eq!(
            menu_action("settings"),
            Some(MenuAction::EmitTabsAction("app-settings"))
        );
        assert_eq!(
            menu_action("about"),
            Some(MenuAction::ShowSettings {
                section: Some("about")
            })
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
