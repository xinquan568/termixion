// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-204: asset-presence guard — every bundled family in the catalog must have BOTH weight
// files committed under app/public/fonts/, and every family directory must carry its license.
// Catches the family-name/file drift failure mode (a missing face falls back silently at
// runtime; this test makes it loud at CI time). import.meta.glob keys are root-relative paths.
import { describe, expect, it } from "vitest";
import { BUNDLED_FONTS } from "./fontCatalog";

const WOFF2 = Object.keys(import.meta.glob("/public/fonts/*/*.woff2"));
const LICENSES = Object.keys(import.meta.glob("/public/fonts/*/LICENSE*"));

/** dir + file basenames per family id, matching the committed layout. */
const EXPECTED_FILES: Record<string, [string, string]> = {
  "sauce-code-pro": [
    "/public/fonts/sauce-code-pro/SauceCodeProNerdFontMono-Regular.woff2",
    "/public/fonts/sauce-code-pro/SauceCodeProNerdFontMono-Bold.woff2",
  ],
  "jetbrains-mono": [
    "/public/fonts/jetbrains-mono/JetBrainsMonoNerdFontMono-Regular.woff2",
    "/public/fonts/jetbrains-mono/JetBrainsMonoNerdFontMono-Bold.woff2",
  ],
  "meslo-lgs": [
    "/public/fonts/meslo-lgs/MesloLGS-NF-Regular.woff2",
    "/public/fonts/meslo-lgs/MesloLGS-NF-Bold.woff2",
  ],
  hack: [
    "/public/fonts/hack/HackNerdFontMono-Regular.woff2",
    "/public/fonts/hack/HackNerdFontMono-Bold.woff2",
  ],
  "fira-code": [
    "/public/fonts/fira-code/FiraCodeNerdFontMono-Regular.woff2",
    "/public/fonts/fira-code/FiraCodeNerdFontMono-Bold.woff2",
  ],
};

describe("bundled font assets (trmx-204)", () => {
  it("every catalog family has an expected-files entry (catalog and layout stay in sync)", () => {
    expect(Object.keys(EXPECTED_FILES).sort()).toEqual(BUNDLED_FONTS.map((f) => f.id).sort());
  });

  it("both weights of every family are committed", () => {
    for (const [regular, bold] of Object.values(EXPECTED_FILES)) {
      expect(WOFF2, `missing ${regular}`).toContain(regular);
      expect(WOFF2, `missing ${bold}`).toContain(bold);
    }
    expect(WOFF2).toHaveLength(10);
  });

  it("every family directory ships its license file", () => {
    for (const id of Object.keys(EXPECTED_FILES)) {
      expect(
        LICENSES.some((p) => p.startsWith(`/public/fonts/${id}/LICENSE`)),
        `missing license for ${id}`,
      ).toBe(true);
    }
  });
});
