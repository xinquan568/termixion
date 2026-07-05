// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-89 (FR-6): the ThemeSpec <-> `tokens.ts` wire-shape CONTRACT test. Parsing the golden theme
//! TOML and serializing the resulting `ThemeSpec` must equal the committed golden JSON (camelCase),
//! pinning the exact shape `app/src/theme/tokens.ts` consumes. Sub-task C reuses these fixtures to
//! assert the TS `ThemeTokens` type and this Rust `ThemeSpec` stay in lock-step.

use termixion_core::parse_theme;

#[test]
fn golden_theme_toml_serializes_to_golden_json() {
    let toml_text = include_str!("fixtures/theme-golden.toml");
    let json_text = include_str!("fixtures/theme-golden.json");

    let (spec, warnings) = parse_theme(toml_text);
    assert_eq!(
        warnings,
        Vec::new(),
        "the golden theme must parse with zero warnings"
    );
    let spec = spec.expect("the golden theme must be a valid ThemeSpec");

    let actual = serde_json::to_value(&spec).expect("ThemeSpec serializes to JSON");
    let expected: serde_json::Value =
        serde_json::from_str(json_text).expect("the golden JSON parses");

    assert_eq!(
        actual, expected,
        "the ThemeSpec JSON shape drifted from tests/fixtures/theme-golden.json"
    );
}
