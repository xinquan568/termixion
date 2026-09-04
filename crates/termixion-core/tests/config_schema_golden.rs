// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-246 (grill M6): the config-schema golden. `schema_json()` renders `config::SCHEMA`; the
//! committed `tests/fixtures/config-schema-golden.json` must equal it byte for byte, and
//! `app/src/store/settingsSchemaGolden.test.ts` reads THE SAME file (never a copy — trmx-239's
//! lesson: a copy that "must not drift" already had) to pin the TypeScript store's defaults,
//! kinds, ranges and enum spellings to core's table.
//!
//! Regenerate after a schema change:
//!   cargo test -p termixion-core --test config_schema_golden -- --ignored write_config_schema_golden

use termixion_core::config::schema_json;

const GOLDEN: &str = include_str!("fixtures/config-schema-golden.json");

fn render(value: &serde_json::Value) -> String {
    let mut text = serde_json::to_string_pretty(value).expect("the schema renders as JSON");
    text.push('\n');
    text
}

#[test]
fn golden_matches_schema() {
    let expected: serde_json::Value = serde_json::from_str(GOLDEN).expect("the golden JSON parses");
    assert_eq!(
        schema_json(),
        expected,
        "config::SCHEMA drifted from tests/fixtures/config-schema-golden.json — regenerate with \
         `cargo test -p termixion-core --test config_schema_golden -- --ignored write_config_schema_golden`"
    );
    // The text too, so a hand edit or a formatting change shows up as well.
    assert_eq!(
        GOLDEN,
        render(&schema_json()),
        "the golden file is not the canonical rendering"
    );
}

#[test]
#[ignore = "rewrites tests/fixtures/config-schema-golden.json; run on purpose after a schema change"]
fn write_config_schema_golden() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/config-schema-golden.json"
    );
    std::fs::write(path, render(&schema_json())).expect("write the golden");
}
