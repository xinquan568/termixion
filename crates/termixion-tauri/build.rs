// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! Tauri build script — generates the app context from `tauri.conf.json`, capabilities, and icons,
//! and stages the shell-enhancement plugin tree that `enhancements_io` embeds.

use std::path::{Path, PathBuf};

/// trmx-240 (L14): stage `resources/shell-enhancements` into `OUT_DIR`, WITHOUT any compiled zsh
/// wordcode, and let `include_dir!` embed the staged copy instead of the source tree.
///
/// Filtering at materialization is not enough, and the reason is a compile-time/run-time split that
/// is easy to miss: `include_dir!` bakes the bytes into the binary when the crate is COMPILED, so a
/// runtime filter can stop wordcode reaching a version directory while ~1 MB of it still ships
/// inside the executable. This matters because the real-PTY tests point p10k at the source tree
/// directly, so `cargo test` leaves freshly-compiled `.zwc` there — and CI's macOS job runs the
/// tests BEFORE the packaged build. Staging is the only place that can make "not shipped" true.
fn stage_enhancements() -> PathBuf {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../resources/shell-enhancements");
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("shell-enhancements");
    // Rebuild when the vendored tree changes (including a plugin appearing or disappearing).
    println!("cargo:rerun-if-changed={}", src.display());
    let _ = std::fs::remove_dir_all(&out);
    copy_filtered(&src, &out);
    out
}

fn copy_filtered(src: &Path, dst: &Path) {
    std::fs::create_dir_all(dst).unwrap_or_else(|e| panic!("mkdir {}: {e}", dst.display()));
    let entries =
        std::fs::read_dir(src).unwrap_or_else(|e| panic!("read_dir {}: {e}", src.display()));
    for entry in entries.flatten() {
        let from = entry.path();
        let name = entry.file_name();
        if from.is_dir() {
            println!("cargo:rerun-if-changed={}", from.display());
            copy_filtered(&from, &dst.join(name));
        } else if from.extension().is_some_and(|ext| ext == "zwc") {
            // The whole point: compiled wordcode never enters the binary.
            continue;
        } else {
            std::fs::copy(&from, dst.join(name))
                .unwrap_or_else(|e| panic!("copy {}: {e}", from.display()));
        }
    }
}

fn main() {
    let staged = stage_enhancements();
    // Consumed by `enhancements_io`'s include_dir! — see its PLUGINS static.
    println!(
        "cargo:rustc-env=TERMIXION_ENHANCEMENTS_DIR={}",
        staged.display()
    );
    tauri_build::build();
}
