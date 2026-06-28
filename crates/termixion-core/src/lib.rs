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

pub mod fake;
pub mod pty;
pub mod session;

pub use pty::{PtyBackend, PtyError, PtyFactory, PtyReader, PtySize, SessionSpec};
pub use session::{Session, SessionId};

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
