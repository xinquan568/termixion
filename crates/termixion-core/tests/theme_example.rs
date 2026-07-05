// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-89: the documented example theme (`docs/examples/mytheme.toml`) must parse cleanly — a
//! minimal required-only file is a working theme with ZERO warnings. Pins the docs to the parser
//! so the two can never drift (a broken example fails this test, not the user).

use termixion_core::parse_theme;

#[test]
fn documented_example_theme_parses_with_zero_warnings() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../docs/examples/mytheme.toml"
    );
    let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let (spec, warnings) = parse_theme(&text);
    assert!(
        spec.is_some(),
        "docs/examples/mytheme.toml must be a VALID theme (all required fields present)"
    );
    assert_eq!(
        warnings,
        Vec::new(),
        "docs/examples/mytheme.toml must parse with NO warnings, got {warnings:?}"
    );
}
