// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! `termixion-platform` — platform traits + impls (the seam). macOS + Linux (trmx-102, FR-1.7).
//!
//! All platform code lives behind `cfg(unix)` / `cfg(target_os = …)` **here**, never in `termixion-core`.
//! B-2 added the PTY backend [`unix::UnixPtyFactory`] (implementing the core's `PtyBackend` via
//! portable-pty — portable across macOS + Linux) and a clipboard stub; trmx-75 added
//! [`foreground::foreground_process`] (the tab-title hint resolver, `ps`-based so it works on any unix),
//! and trmx-91 [`foreground::is_busy`] (the FR-7a activity busy predicate). trmx-102 widened the OS gate
//! from `macos` to `unix` and renamed the backend `Macos*` → `Unix*` (the code was already 100%
//! portable-unix); the shell imports the neutral [`PlatformPtyFactory`] alias.

#[cfg(unix)]
pub mod foreground;
#[cfg(unix)]
pub mod unix;

#[cfg(unix)]
pub use foreground::{
    ForegroundProcess, foreground_args, foreground_process, foreground_stdin_is_tty, is_busy,
    is_interpreter, unwrap_interpreter_shim,
};
#[cfg(unix)]
pub use unix::{Clipboard, UnixClipboard, UnixPtyFactory};

/// The neutral PTY factory the tauri shell constructs. A `pub use` re-export (NOT a `type` alias), so the
/// unit-struct VALUE is in scope too — a bare alias would name the type without a value constructor.
#[cfg(unix)]
pub use unix::UnixPtyFactory as PlatformPtyFactory;

/// Re-export the core version so the shell can report a single number for now.
pub use termixion_core::VERSION as CORE_VERSION;
