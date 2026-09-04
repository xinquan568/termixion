// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-246 (grill M6): the TypeScript half of the config-schema contract, read from THE core
// fixture (`crates/termixion-core/tests/fixtures/config-schema-golden.json`, rendered from
// `config::SCHEMA` and pinned by `config_schema_golden.rs`). One file, two readers — trmx-239
// removed the app-side copies because a copy that "must not drift" already had.
//
// What this pins: the registry key set, each key's kind and default, the integer ranges and the
// enum spellings (in order). A setting added in Rust fails here until the store's typed entries
// exist; a default or a range changed on one side fails until the other follows.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SETTING_DEFAULTS,
  SETTING_ENUM_VALUES,
  SETTING_FREE_STRING_KEYS,
  SETTING_KEYS,
  SETTING_RANGES,
  type SettingKey,
} from "./settingsStore";

interface GoldenSetting {
  registryKey: string;
  table: string;
  key: string;
  kind: "bool" | "int" | "str" | "enum";
  default: boolean | number | string;
  min?: number;
  max?: number;
  values?: string[];
}

const golden = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../crates/termixion-core/tests/fixtures/config-schema-golden.json",
    ),
    "utf8",
  ),
) as { schema: number; settings: GoldenSetting[] };

const byKind = (kind: GoldenSetting["kind"]) => golden.settings.filter((s) => s.kind === kind);

describe("config-schema golden (shared with the Rust suite, trmx-246)", () => {
  it("is schema version 1 with the registry's key set, both ways", () => {
    expect(golden.schema).toBe(1);
    expect(golden.settings.map((s) => s.registryKey).sort()).toEqual([...SETTING_KEYS].sort());
  });

  it("agrees on every key's kind and static default", () => {
    for (const s of golden.settings) {
      const key = s.registryKey as SettingKey;
      const def = SETTING_DEFAULTS[key];
      const expectedType = s.kind === "bool" ? "boolean" : s.kind === "int" ? "number" : "string";
      expect(typeof def, key).toBe(expectedType);
      // appearance.theme's REAL first-run value is derived from the OS appearance (defaultFor);
      // SETTING_DEFAULTS holds the static placeholder, which is what core's default is too.
      expect(def, key).toEqual(s.default);
    }
  });

  it("agrees on the integer ranges", () => {
    const ints = byKind("int");
    expect(ints.map((s) => s.registryKey).sort()).toEqual(Object.keys(SETTING_RANGES).sort());
    for (const s of ints) {
      expect(SETTING_RANGES[s.registryKey as keyof typeof SETTING_RANGES], s.registryKey).toEqual({
        min: s.min,
        max: s.max,
      });
    }
  });

  it("agrees on the enum spellings, in order", () => {
    const enums = byKind("enum");
    expect(enums.map((s) => s.registryKey).sort()).toEqual(Object.keys(SETTING_ENUM_VALUES).sort());
    for (const s of enums) {
      expect(
        [...(SETTING_ENUM_VALUES[s.registryKey as SettingKey] ?? [])],
        s.registryKey,
      ).toEqual(s.values);
    }
  });

  it("knows every free string (appearance.theme has its own validated branch)", () => {
    const strings = byKind("str")
      .map((s) => s.registryKey)
      .filter((k) => k !== "appearance.theme");
    expect(strings.sort()).toEqual([...SETTING_FREE_STRING_KEYS].sort());
  });
});
