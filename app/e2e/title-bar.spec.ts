// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-188: the app-drawn title bar's LAYOUT contract against a real browser — the tier jsdom
// cannot see. The bar is the first child of main.app, above the app-body wrapper that carries the
// trmx-81 direction-flipping flex, so it must top the window for every tabs.barPosition. The left
// title truncates with a real ellipsis (computed styles + engaged overflow, not just arithmetic —
// a Step-5 review finding pinned the non-vacuous form); the right priority slot always wins, and
// that is proven against NON-EMPTY slot content seeded through the `?e2e.titleBarSlot=` query
// seam (the trmx-81 D1 boot-seam precedent: the packaged app never navigates with a query).
// Dragging / double-click zoom / real traffic lights / real fullscreen need a Tauri runtime —
// packaged-smoke tier, out of e2e reach.
import { test, expect, type Page } from "@playwright/test";

const POSITIONS = ["top", "bottom", "left", "right"] as const;

/** A title long past any viewport: truncation must engage at 900px wide. */
const LONG_TITLE = "very-long-title ".repeat(16).trim(); // ~255 chars, sanitizer caps at 256

/** Rename tab 1 via the trmx-75 double-click flow — pins the manual title the bar consumes. */
async function renameTab1(page: Page, title: string) {
  const label = page.getByTestId("tab-1").locator(".tab-strip__title");
  await label.dblclick();
  const input = page.getByTestId("tab-rename-input");
  await expect(input).toBeVisible();
  await input.fill(title);
  await input.press("Enter");
  await expect(input).toHaveCount(0);
}

test.describe("title bar (trmx-188)", () => {
  test("a pathologically long title ellipsizes and never covers the non-empty right slot", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.goto("/?e2e.titleBarSlot=COUNTERS-FIXTURE");
    await renameTab1(page, LONG_TITLE);

    const title = page.locator(".title-bar__title");
    await expect(title).toHaveText(LONG_TITLE);

    // The ellipsis contract as COMPUTED style — the truncation mechanism itself, not a proxy.
    await expect(title).toHaveCSS("text-overflow", "ellipsis");
    await expect(title).toHaveCSS("overflow-x", "hidden");
    await expect(title).toHaveCSS("white-space", "nowrap");
    // ...and actually ENGAGED: the content overflows its box.
    const engaged = await title.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(engaged).toBe(true);

    // The priority slot: real content, positive width, shrink-proof, fully on-viewport, and the
    // title's box ends before the slot's begins.
    const slot = page.locator(".title-bar__slot");
    await expect(slot).toHaveText("COUNTERS-FIXTURE");
    await expect(slot).toHaveCSS("flex-shrink", "0");
    const slotBox = (await slot.boundingBox())!;
    const titleBox = (await title.boundingBox())!;
    expect(slotBox.width).toBeGreaterThan(0);
    expect(slotBox.x + slotBox.width).toBeLessThanOrEqual(900 + 1);
    expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(slotBox.x + 0.5);

    // The bar never causes horizontal scrolling.
    const overflows = await page
      .locator("main.app")
      .evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(overflows).toBe(false);
  });

  for (const position of POSITIONS) {
    test(`tops the window with tabs.barPosition=${position}`, async ({ page }) => {
      await page.setViewportSize({ width: 900, height: 600 });
      await page.goto(`/?setting.tabs.barPosition=${position}`);

      const bar = page.locator(".title-bar");
      await expect(bar).toBeVisible();
      const barBox = (await bar.boundingBox())!;
      expect(barBox.y).toBeLessThanOrEqual(1);
      expect(barBox.width).toBeGreaterThanOrEqual(900 - 1);

      if (position === "top") {
        // The strip yields the top edge to the title bar and sits directly below it.
        const strip = (await page.getByTestId("tab-strip").boundingBox())!;
        expect(strip.y).toBeGreaterThanOrEqual(barBox.y + barBox.height - 1);
      }

      const overflows = await page
        .locator("main.app")
        .evaluate((el) => el.scrollWidth > el.clientWidth);
      expect(overflows).toBe(false);
    });
  }

  test("the slot stays empty without the e2e seam (production shape)", async ({ page }) => {
    await page.goto("/");
    const slot = page.locator(".title-bar__slot");
    await expect(slot).toBeAttached();
    await expect(slot).toHaveText("");
  });

  test("the bar is the 28px native-strip height so the default traffic lights center (trmx-199)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.goto("/");

    const bar = page.locator(".title-bar");
    await expect(bar).toBeVisible();
    // The 28px CONTENT box matches the native macOS title-bar strip AppKit vertically centers
    // its floating traffic lights in; the 1px border-bottom is the divider BELOW that strip
    // (content-box contract — computed style, not boundingBox, which would include the border).
    await expect(bar).toHaveCSS("height", "28px");
    // The left inset that clears the lights keeps its 78px clearance.
    await expect(page.locator(".title-bar__inset")).toHaveCSS("width", "78px");
  });
});
