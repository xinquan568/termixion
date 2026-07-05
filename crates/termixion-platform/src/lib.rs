// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! `termixion-platform` — platform traits + impls (the seam). macOS now; Linux later (v1.x).
//!
//! All platform code lives behind `cfg(target_os = …)` **here**, never in `termixion-core`. B-2 adds
//! the macOS [`macos::MacosPtyFactory`] (implementing the core's `PtyBackend` via portable-pty) and a
//! clipboard stub; trmx-75 adds [`foreground::foreground_process`] (the tab-title hint resolver),
//! and trmx-91 [`foreground::is_busy`] (the FR-7a activity-indicator busy predicate over it).

#[cfg(target_os = "macos")]
pub mod foreground;
#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "macos")]
pub use foreground::{ForegroundProcess, foreground_process, is_busy};
#[cfg(target_os = "macos")]
pub use macos::{Clipboard, MacosClipboard, MacosPtyFactory};

/// Re-export the core version so the shell can report a single number for now.
pub use termixion_core::VERSION as CORE_VERSION;
