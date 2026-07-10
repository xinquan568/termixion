# Changelog

The user-facing changes to Termixion are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com), and the project adheres to
[Semantic Versioning](https://semver.org). Auto-generated from Conventional Commits by git-cliff;
internal changes (build / CI / tests / refactors / docs) live in the git history and the linked issues.

## [0.1.0] - 2026-07-10

### Added
- Confirm before closing a busy pane/tab or quitting (trmx-144) (#147)
- Handle --version/--help before the GUI launches (trmx-146) (#152)
- ITerm2-style tab bar — centered content, ⌘1–⌘9 prefixes (trmx-151) (#155)
- Light the indicator only while a program executes user work (trmx-159) (#161)
- Clone iTerm2's indeterminate progress bar for the activity line (trmx-160) (#162)
- Refine tab bar toward iTerm2 — 28px thickness, top close, trailing ⌘N hint, centered title (trmx-163) (#164)
- Move theme Duplicate to a right-click context menu (trmx-171) (#172)

### Fixed
- Route clipboard writes through the native pasteboard (trmx-145) (#150)
- Open the config file backend-side, surface failures (trmx-148) (#153)
- Match iTerm2's badge exactly — red, fit-to-box, Helvetica bold (trmx-149) (#154)
- Default badge color pink #ff8da1, not red (trmx-149) (#156)
- Give login shells a UTF-8 locale when the environment has none (trmx-145) (#157)
- Render the per-pane badge text at 50% opacity (trmx-149) (#158)
- Reserve a top gutter for the close × and centre the title on the vertical-label rail (trmx-165) (#167)
- Pin a manual tab rename at tab scope so it survives pane focus/splits (trmx-166) (#168)
- Size the vertical-label tab height to the horizontal tab length so rotated titles are readable (trmx-169) (#170)
- Apply --tx-* vars in the main window so the tab bar recolors on theme switch (trmx-173) (#174)
- Segment the active pane border to the focused pane's span (trmx-175) (#176)

## [0.0.9] - 2026-07-07

### Added
- Grapheme-cluster Unicode correctness + conformance group (trmx-97) (#128)
- In-pane find bar (⌘F) with scrollback search + ⌘G nav & case/regex (trmx-98) (#129)
- Accurate activity indicator via OSC 133 shell integration (trmx-99) (#130)
- Drag to re-dock panes with five-zone drop targets + keyboard move (trmx-100) (#131)
- Opt-in external control channel over a unix socket (trmx-101) (#132)
- Linux build — unix PTY backend, Linux CI gate, AppImage/.deb release (trmx-102) (#133)

## [0.0.8] - 2026-07-06

### Added
- Nested script folder, startup script & run-with-script picker (trmx-93) (#124)
- Command registry, ⇧⌘P palette & user keybindings in [keys] (trmx-94) (#125)
- Auto-copy selection to the clipboard, iTerm2-style (trmx-95) (#126)

## [0.0.7] - 2026-07-05

### Added
- User theme files with tolerant validation, hot reload, duplicate-a-builtin (trmx-89) (#120)
- Per-pane badges via ⇧⌘B and OSC 1337 SetBadgeFormat (trmx-90) (#121)
- Basic activity indicator — green line while a command runs (trmx-91) (#122)

## [0.0.6] - 2026-07-05

### Added
- Split panes over a pure layout tree (trmx-84) (#115)
- Drag-resize pane dividers (trmx-85) (#116)
- Keyboard pane navigation (trmx-86) (#117)
- Kitty multi-pane look — divider chrome, focus, dim (trmx-87) (#118)

## [0.0.5] - 2026-07-04

### Added
- Schema-validated TOML settings backbone — file-backed store, live hand-edit apply, scrollback/font options (trmx-80) (#111)
- Configurable tab-bar position — top/bottom/left/right, live from Settings or termixion.toml (trmx-81) (#112)
- Side-bar tab label orientation — horizontal/vertical for left/right rails (trmx-82) (#113)

## [0.0.4] - 2026-07-03

### Added
- Finalize + lock the single-pane visual baseline (trmx-77) (#108)
- NFR-1 performance pass — --perf harness + budgets (trmx-78) (#109)

## [0.0.3] - 2026-07-03

### Added
- Multiple tabs with per-tab PTY sessions, keyboard nav, drag reorder (trmx-74) (#105)
- Live tab titles — manual rename > OSC 0/2 > foreground process (trmx-75) (#106)

## [0.0.2] - 2026-07-03

### Added
- VT-correct LF + OSC 0/2, 7, 8, 52 integrations (trmx-64) (#68)
- Explicit 10k scrollback cap + smooth discrete scrolling (trmx-65) (#69)
- Owned cmd-C/cmd-V clipboard with bracketed-paste sanitization (trmx-66) (#70)
- Resize/reflow hardening — coalesced winsize, actual-grid open, core size guard (trmx-67) (#71)

## [0.0.1] - 2026-07-02

### Added
- Scaffold A-1 repo skeleton (crates, app shell, configs)
- [A-4] install .claude rules + git hooks (guardrails) (#6)
- [B-1] termixion-core PTY/session seam + in-memory fake (#8)
- [B-2] termixion-platform macOS PTY backend via portable-pty (#9)
- [B-3] termixion-tauri real Tauri 2 shell (one window, app menu) (#10)
- Mount xterm.js with a WebGL→DOM fallback strategy (B-4) (#14)
- Wire Tauri ↔ React — core_version handshake + PTY channel seam (B-5) (#15)
- PTY session lifecycle through the trait + login shell (C-1) (#16)
- Stream PTY <-> webview + keystrokes over the Tauri channel (C-2) (#19)
- Single-window dispose + packaged --smoke end-to-end gate (C-3) (#20)
- Set the Termixion app icon (trmx-33) (#34)
- Fill the window, chrome-free and responsive (trmx-35) (#36)
- Kitty-style scrollbar shown only while scrolled back (trmx-41) (#42)
- Match iTerm2's default display style (trmx-44) (#45)
- Use the macOS system default font (SF Mono) as the terminal default (trmx-46) (#47)
- Automatic updates via a Settings → About page (trmx-48) (#50)
- Settings as a standalone window with vmark-parity About and Terminal pages (trmx-51) (#52)
- Default Cursor Blink to off (trmx-55) (#59)
- App-wide six vmark themes via Settings → Appearance (trmx-53) (#60)

### Fixed
- Rename bundle identifier to dev.termixion.terminal (#24)
- Always set TERM=xterm-256color for the login shell (trmx-37) (#38)
- Show scrollbar on user wheel/viewport scroll (trmx-41) (#43)
- Grant start_dragging so the Settings window can be dragged (trmx-54) (#58)

