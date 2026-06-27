// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// termixion-platform — platform traits + macOS implementations (authority §6, the P1-8 seam).
// A-1 skeleton only. B-2 implements the core's `PtyBackend` for macOS via portable-pty
// (behind cfg(target_os = "macos")) plus a clipboard impl. Linux impls are added at the
// Linux build (v1.x); the core stays platform-agnostic.

/// Re-export the core version so the shell can report a single number for now.
pub use termixion_core::VERSION as CORE_VERSION;
