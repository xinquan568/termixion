// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// termixion-tauri — thin shell entry point (authority §6).
// A-1 skeleton only: prints the core version so the binary is runnable end-to-end.
// B-3 replaces this with a real Tauri 2 app (one window, one tab); C-2/C-3 add the
// PTY <-> webview channel and the `--smoke` mode.

fn main() {
    // A-1 placeholder. Real Tauri bootstrap arrives in B-3.
    println!("termixion {} (core {})", env!("CARGO_PKG_VERSION"), termixion_platform::CORE_VERSION);
}
