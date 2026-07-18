// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-190: the AI-session counter's CSS/layout tier against a real browser. The dev server has
// no Tauri runtime — session:activity never fires and sessions never attach — so this spec drives
// the counter through the `?e2e.aiCounter=` fixture seam (the trmx-81 D1 / trmx-188 titleBarSlot
// precedent: a STATIC per-page-load spec like `claude:2/3,codex:0/2`; the packaged app never
// navigates with a query). What is honestly provable here: the segment render format + ordering,
// the wide-mode All suppression, the all-idle dimming, the hover tooltip, the trmx-188 slot-
// priority contract against REAL counter content, and the narrow-window collapse truth table.
// Live updates, the numerator invariant, and click-to-cycle need injected activity events — they
// are pinned headless in App.test.tsx (the jsdom tier), by design.
import { test, expect, type Page } from "@playwright/test";

const LONG_TITLE = "very-long-title ".repeat(16).trim();

async function renameTab1(page: Page, title: string) {
  const label = page.getByTestId("tab-1").locator(".tab-strip__title");
  await label.dblclick();
  const input = page.getByTestId("tab-rename-input");
  await expect(input).toBeVisible();
  await input.fill(title);
  await input.press("Enter");
  await expect(input).toHaveCount(0);
}

test.describe("AI-session counter (trmx-190)", () => {
  test("renders ordered segments with All last; dims only when every numerator is 0", async ({
    page,
  }) => {
    await page.goto("/?e2e.aiCounter=claude:2/3,codex:0/2,Other:1/1");
    const counter = page.getByTestId("ai-counter");
    await expect(counter).toBeVisible();
    const segments = counter.locator(".ai-counter__segment");
    await expect(segments).toHaveText(["claude: 2/3", "codex: 0/2", "Other: 1/1", "All: 3/6"]);
    // Multi-bucket → All is NOT redundant and visible in wide mode.
    const all = counter.locator(".ai-counter__segment--all");
    await expect(all).toBeVisible();
    // Some numerators are non-zero → not dimmed.
    await expect(counter).not.toHaveClass(/ai-counter--idle/);

    await page.goto("/?e2e.aiCounter=claude:0/2,codex:0/1");
    const idle = page.getByTestId("ai-counter");
    await expect(idle).toHaveClass(/ai-counter--idle/);
    const opacity = await idle.evaluate((el) => Number(getComputedStyle(el).opacity));
    expect(opacity).toBeLessThan(1);
  });

  test("suppresses All as redundant with a single bucket (wide mode)", async ({ page }) => {
    await page.goto("/?e2e.aiCounter=claude:1/2");
    const counter = page.getByTestId("ai-counter");
    await expect(counter.locator('[data-bucket="claude"]')).toBeVisible();
    const all = counter.locator(".ai-counter__segment--all");
    await expect(all).toHaveClass(/ai-counter__segment--redundant/);
    await expect(all).toBeHidden(); // wide CSS hides the redundant All
  });

  test("hover shows the per-session tooltip", async ({ page }) => {
    await page.goto("/?e2e.aiCounter=claude:1/2");
    const counter = page.getByTestId("ai-counter");
    const tooltip = page.getByTestId("ai-counter-tooltip");
    await expect(tooltip).toBeHidden();
    await counter.hover();
    await expect(tooltip).toBeVisible();
    // The fixture synthesizes one session per counted total with predictable titles.
    await expect(tooltip).toContainText("claude");
    await expect(tooltip).toContainText("fixture-claude-1");
    // Tooltip must not push the page into horizontal scroll (trmx-188 invariant).
    const overflows = await page
      .locator("main.app")
      .evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(overflows).toBe(false);
  });

  test("a long title yields to the populated counter — the trmx-188 slot contract with real content", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.goto("/?e2e.aiCounter=claude:2/3,codex:0/2");
    await renameTab1(page, LONG_TITLE);

    const title = page.locator(".title-bar__title");
    const engaged = await title.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(engaged).toBe(true); // truncation engaged, not a shrunk counter

    const counter = page.getByTestId("ai-counter");
    const counterBox = (await counter.boundingBox())!;
    const titleBox = (await title.boundingBox())!;
    expect(counterBox.width).toBeGreaterThan(0);
    expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(counterBox.x + 0.5);
    expect(counterBox.x + counterBox.width).toBeLessThanOrEqual(900 + 1);

    const overflows = await page
      .locator("main.app")
      .evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(overflows).toBe(false);
  });

  test("narrow window collapses to the All segment only (multi-bucket)", async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 500 });
    await page.goto("/?e2e.aiCounter=claude:2/3,codex:0/2");
    const counter = page.getByTestId("ai-counter");
    await expect(counter.locator(".ai-counter__segment--all")).toBeVisible();
    await expect(counter.locator('[data-bucket="claude"]')).toBeHidden();
    await expect(counter.locator('[data-bucket="codex"]')).toBeHidden();
    const overflows = await page
      .locator("main.app")
      .evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(overflows).toBe(false);
  });

  test("narrow + SINGLE bucket still shows All — the collapse overrides redundant suppression", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 600, height: 500 });
    await page.goto("/?e2e.aiCounter=claude:1/2");
    const counter = page.getByTestId("ai-counter");
    const all = counter.locator(".ai-counter__segment--all");
    await expect(all).toBeVisible(); // narrow overrides the wide-mode --redundant hiding
    await expect(counter.locator('[data-bucket="claude"]')).toBeHidden();
    const overflows = await page
      .locator("main.app")
      .evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(overflows).toBe(false);
  });

  test("no fixture and no AI sessions → the counter renders nothing", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("ai-counter")).toHaveCount(0);
  });
});
