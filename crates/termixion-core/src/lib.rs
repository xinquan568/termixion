// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! `termixion-core` — the platform-agnostic core (authority §6).
//!
//! Defines the PTY/session **seam** ([`PtyBackend`], [`PtyFactory`]) that `termixion-platform`
//! implements (macOS via portable-pty in B-2), the single-session domain model ([`Session`]), and
//! an in-memory [`fake`] backend so the whole core is testable headless on Linux CI.
//!
//! Invariants enforced by `scripts/check-core-seam.sh` (D-1): no platform crates, no
//! `cfg(target_os | …)` / bare `cfg(unix)` / `cfg(windows)`, and no `std::os::` in this crate.

pub mod config;
pub mod fake;
pub mod pty;
pub mod pump;
pub mod registry;
pub mod session;
pub mod theme;

pub use config::{
    CheckFrequency, Config, ConfigWarning, CursorStyle, DEFAULT_TEMPLATE, LabelOrientation,
    RegistryValue, TabBarPosition, TabsConfig, diff_configs, parse_config, parse_registry_pairs,
    toml_path_for,
};
pub use pty::{PtyBackend, PtyError, PtyFactory, PtyReader, PtySize, SessionSpec};
pub use pump::pump;
pub use registry::SessionRegistry;
pub use session::{Session, SessionId};
pub use theme::{
    AccentSpec, AnsiSpec, BgSpec, ColorSpec, PaneSpec, ScrollbarSpec, SemanticSpec, TerminalSpec,
    TextSpec, ThemeSpec, ThemeWarning, parse_theme, user_theme_id,
};

/// Crate version, surfaced for the shell/CLI to report.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_set() {
        assert!(!VERSION.is_empty());
    }
}
