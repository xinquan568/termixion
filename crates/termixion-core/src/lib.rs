// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// termixion-core — platform-agnostic core (authority §6).
// A-1 skeleton only. B-1 adds the `PtyBackend` session/PTY seam (a trait, declaration-only,
// no platform code) and the single-session domain model.
//
// Invariants enforced by scripts/check-core-seam.sh (D-1):
//   - no platform crates (tauri, portable-pty, cocoa, libc, nix, windows*) in this crate;
//   - no cfg(target_os|target_family|target_env|target_arch|target_vendor|target_pointer_width),
//     and no bare cfg(unix)/cfg(windows);
//   - no std::os:: usage in non-test code.

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
