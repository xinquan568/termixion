// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-195: per-theme visibility of the title-bar text and the AI-session counters — the tier
// that would have caught the --tx-text-primary regression (an undefined token computes to
// inherited BLACK, invisible on dark themes, plausible-looking on light ones; layout-only e2e
// never noticed). For each built-in theme the main window boots via the trmx-81 D1 query seam
// (appearance.theme joined the allowlist in this same change; the boot order guarantees the
// seeded theme paints: hydrateSettings seeds → applyStartupTheme reads it) and every text
// surface must compute to the theme's OWN primary-text token — the EXPECTED value imported from
// the theme catalog (pure token modules), serialized through an in-page literal-hex probe so
// both sides go through the same computed-color serializer. A booted-theme background sanity
// kills the vacuous pass where an unset var would leave everything default. User themes are
// file-backed (unreachable here); they inherit visibility by construction — same role token.
import { test, expect, type Page } from "@playwright/test";
import { themes } from "../src/theme/themes";

const THEME_IDS = [
  "catppuccin-latte", "nord", "dracula", "gruvbox", "solarized",
  "catppuccin-mocha", "tokyo-night", "night",
] as const;

/** Serialize a literal CSS color through the browser's computed-style serializer. */
function serializeColor(page: Page, literal: string): Promise<string> {
  return page.evaluate((value) => {
    const el = document.createElement("span");
    el.style.color = value;
    document.body.appendChild(el);
    const computed = getComputedStyle(el).color;
    el.remove();
    return computed;
  }, literal);
}

for (const id of THEME_IDS) {
  const tokens = themes[id];
  const expectedText = tokens.color.text.primary;
  const expectedBarBg = tokens.color.bg.secondary; // the --tx-bg-sunken source token

  test(`theme ${id}: title + counters render the theme's primary text color`, async ({ page }) => {
    await page.goto(`/?setting.appearance.theme=${id}&e2e.aiCounter=claude:2/3,codex:0/2`);

    const text = await serializeColor(page, expectedText);
    const barBg = await serializeColor(page, expectedBarBg);

    // Booted-theme sanity: the bar's background IS this theme's sunken token — proves the seam
    // actually booted `id` (and kills the vacuous pass where an unset var leaves defaults).
    const bar = page.locator(".title-bar");
    await expect(bar).toHaveCSS("background-color", barBg);

    // The title and BOTH counter segments (a named one and the visible All) carry the token.
    await expect(page.locator(".title-bar__title")).toHaveCSS("color", text);
    await expect(page.locator('.ai-counter [data-bucket="claude"]')).toHaveCSS("color", text);
    const all = page.locator(".ai-counter__segment--all");
    await expect(all).toBeVisible(); // multi-bucket fixture → All renders
    await expect(all).toHaveCSS("color", text);

    // Tooltip rows inherit the corrected color too.
    await page.getByTestId("ai-counter").hover();
    const row = page.locator(".ai-counter__tooltip-row").first();
    await expect(row).toBeVisible();
    await expect(row).toHaveCSS("color", text);
  });

  test(`theme ${id}: the all-idle dim keeps the color and reduces opacity`, async ({ page }) => {
    await page.goto(`/?setting.appearance.theme=${id}&e2e.aiCounter=claude:0/2`);
    const text = await serializeColor(page, expectedText);
    const counter = page.getByTestId("ai-counter");
    await expect(counter).toHaveClass(/ai-counter--idle/);
    await expect(counter).toHaveCSS("color", text); // dim is opacity, never a color change
    const opacity = await counter.evaluate((el) => Number(getComputedStyle(el).opacity));
    expect(opacity).toBeLessThan(1);
  });
}
