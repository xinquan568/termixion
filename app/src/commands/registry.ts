// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-94 (FR-9.1): the command registry — every user-facing action as a named, stable-id internal
// command (Kitty-style). Commands are PURE descriptors over an injected `CommandContext` (the app's
// dispatch surface), so they are unit-testable with a fake ctx and no DOM. The ids are load-bearing
// PUBLIC surface: they are the `[keys]` config keys' targets AND the FR-9.4 control-channel protocol,
// so they must stay STABLE (a rename is a breaking change — pinned by a test).

/** The app's dispatch surface, injected into every command's `run`/`when`. App maps these onto its
 * existing request* funcs + seams (trmx-74/84/86/90/93). Read-only accessors gate `when` + params. */
export interface CommandContext {
  // tabs (trmx-74)
  newTab(): void;
  /** trmx-144: close commands forward the dispatch `origin` so App's confirm gate can tell a user
   * gesture (may prompt) from a remote control-channel request (never prompts). */
  closeActiveTab(origin?: "user" | "remote"): void;
  nextTab(): void;
  prevTab(): void;
  selectTab(index: number): void;
  renameActiveTab(): void;
  newTabWithScript(): void; // trmx-93
  // panes (trmx-84/86/90)
  splitRight(): void;
  splitBelow(): void;
  splitRightWithScript(): void; // trmx-93
  splitBelowWithScript(): void; // trmx-93
  closePane(origin?: "user" | "remote"): void;
  focusPane(dir: "left" | "right" | "up" | "down"): void;
  nextPane(): void;
  prevPane(): void;
  setBadge(): void;
  growPane(dir: "left" | "right" | "up" | "down"): void; // trmx-94 (FR-3.3)
  movePane(dir: "left" | "right" | "up" | "down"): void; // trmx-100 (FR-3.4) — re-dock the focused pane
  // terminal (trmx-94)
  clearScrollback(): void;
  // search (trmx-98, FR-1.5) — open/close the focused pane's find bar; next/prev route to its controller
  openSearch(): void;
  searchNext(): void;
  searchPrev(): void;
  closeSearch(): void;
  // app / window (trmx-94 — routed through dispatch, not the Rust menu shortcuts)
  openSettings(): void;
  checkForUpdates(): void;
  closeWindow(origin?: "user" | "remote"): void;
  openCommandPalette(): void;
  // parameterized targets
  selectTheme(themeId: string): void; // trmx-89
  runScript(sourceLine: string): void; // trmx-93 (arg is the entry's sourceLine)
  // read-only accessors for `when` guards
  tabCount(): number;
  paneCount(): number;
  /** trmx-144: the origin of the CURRENT dispatch — injected per-dispatch by the dispatcher (never
   * implemented by App's ctx). "user" = user gesture (menu/keymap/palette), "remote" = control
   * channel (ctl). "auto" closes (e.g. shell exit) never pass through dispatch, so they never see
   * an origin. Lets close commands skip the busy-close confirm for remote requests. */
  readonly origin?: "user" | "remote";
}

/** A command descriptor. `param` marks a two-level palette command (a second fuzzy page of themes /
 * scripts); its `run` receives the chosen entry's id/sourceLine as `arg`. */
export interface Command {
  id: string;
  title: string;
  category: string;
  run: (ctx: CommandContext, arg?: string) => void;
  when?: (ctx: CommandContext) => boolean;
  param?: "theme" | "script";
}

const DIRS = ["left", "right", "up", "down"] as const;

/** Build the frozen command list. A function (not a const) so tests get a fresh array. */
export function buildCommands(): Command[] {
  const commands: Command[] = [
    // --- tabs ---
    { id: "tab.new", title: "New Tab", category: "Tabs", run: (c) => c.newTab() },
    { id: "tab.close", title: "Close Tab", category: "Tabs", run: (c) => c.closeActiveTab(c.origin), when: (c) => c.tabCount() > 0 },
    { id: "tab.next", title: "Next Tab", category: "Tabs", run: (c) => c.nextTab(), when: (c) => c.tabCount() > 1 },
    { id: "tab.prev", title: "Previous Tab", category: "Tabs", run: (c) => c.prevTab(), when: (c) => c.tabCount() > 1 },
    { id: "tab.rename", title: "Rename Tab…", category: "Tabs", run: (c) => c.renameActiveTab(), when: (c) => c.tabCount() > 0 },
    { id: "tab.new-with-script", title: "New Tab with Script…", category: "Tabs", run: (c) => c.newTabWithScript() },
    // tab.select-1..9 (⌘1..⌘9; index is N-1; the reducer maps 9→last)
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `tab.select-${i + 1}`,
      title: `Select Tab ${i + 1}`,
      category: "Tabs",
      run: (c: CommandContext) => c.selectTab(i),
      // ⌘9 (index 8) selects the LAST tab for any nonzero count (iTerm2 behavior, the reducer maps
      // index 8 → last); ⌘1..⌘8 need that many tabs (review finding 5).
      when: (c: CommandContext) => (i === 8 ? c.tabCount() > 0 : c.tabCount() > i),
    })),
    // --- panes ---
    { id: "pane.split-right", title: "Split Right", category: "Panes", run: (c) => c.splitRight() },
    { id: "pane.split-below", title: "Split Below", category: "Panes", run: (c) => c.splitBelow() },
    { id: "pane.split-right-with-script", title: "Split Right with Script…", category: "Panes", run: (c) => c.splitRightWithScript() },
    { id: "pane.split-below-with-script", title: "Split Below with Script…", category: "Panes", run: (c) => c.splitBelowWithScript() },
    { id: "pane.close", title: "Close Pane", category: "Panes", run: (c) => c.closePane(c.origin), when: (c) => c.paneCount() > 0 },
    { id: "pane.next", title: "Next Pane", category: "Panes", run: (c) => c.nextPane(), when: (c) => c.paneCount() > 1 },
    { id: "pane.prev", title: "Previous Pane", category: "Panes", run: (c) => c.prevPane(), when: (c) => c.paneCount() > 1 },
    { id: "pane.set-badge", title: "Set Badge…", category: "Panes", run: (c) => c.setBadge(), when: (c) => c.paneCount() > 0 },
    ...DIRS.map((dir) => ({
      id: `pane.focus-${dir}`,
      title: `Focus Pane ${dir[0].toUpperCase()}${dir.slice(1)}`,
      category: "Panes",
      run: (c: CommandContext) => c.focusPane(dir),
      when: (c: CommandContext) => c.paneCount() > 1,
    })),
    ...DIRS.map((dir) => ({
      id: `pane.grow-${dir}`,
      title: `Grow Pane ${dir[0].toUpperCase()}${dir.slice(1)}`,
      category: "Panes",
      run: (c: CommandContext) => c.growPane(dir),
      when: (c: CommandContext) => c.paneCount() > 1,
    })),
    // trmx-100 (FR-3.4): re-dock the focused pane onto its neighbor's far edge in that direction (a flip).
    ...DIRS.map((dir) => ({
      id: `pane.move-${dir}`,
      title: `Move Pane ${dir[0].toUpperCase()}${dir.slice(1)}`,
      category: "Panes",
      run: (c: CommandContext) => c.movePane(dir),
      when: (c: CommandContext) => c.paneCount() > 1,
    })),
    // --- terminal ---
    { id: "terminal.clear-scrollback", title: "Clear Scrollback", category: "Terminal", run: (c) => c.clearScrollback() },
    // trmx-98 (FR-1.5): in-pane search. open (⌘F) / next (⌘G) / prev (⇧⌘G) / close (Esc via palette/×).
    { id: "search.open", title: "Find", category: "Search", run: (c) => c.openSearch() },
    { id: "search.next", title: "Find Next", category: "Search", run: (c) => c.searchNext() },
    { id: "search.prev", title: "Find Previous", category: "Search", run: (c) => c.searchPrev() },
    { id: "search.close", title: "Close Find", category: "Search", run: (c) => c.closeSearch() },
    // --- theme / script (parameterized: a second palette page) ---
    { id: "theme.select", title: "Change Theme…", category: "Appearance", param: "theme", run: (c, arg) => arg && c.selectTheme(arg) },
    { id: "script.run", title: "Run Script…", category: "Scripts", param: "script", run: (c, arg) => arg && c.runScript(arg) },
    // --- app / window ---
    { id: "app.command-palette", title: "Command Palette…", category: "App", run: (c) => c.openCommandPalette() },
    { id: "app.settings", title: "Settings…", category: "App", run: (c) => c.openSettings() },
    { id: "app.check-updates", title: "Check for Updates…", category: "App", run: (c) => c.checkForUpdates() },
    { id: "window.close", title: "Close Window", category: "App", run: (c) => c.closeWindow(c.origin) },
  ];
  return commands;
}

/** The stable command-id set (frozen; the FR-9.4 protocol + `[keys]` config surface). */
export const COMMAND_IDS: readonly string[] = buildCommands().map((c) => c.id);
