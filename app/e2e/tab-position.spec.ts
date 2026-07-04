// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-81 (FR-2.2): the tab-bar position matrix against the Vite dev-server webview. The dev
// server has no Tauri backend, so hydrateSettings' config_read rejects and the D1 query seam
// (`?setting.tabs.barPosition=<v>`, settingsStore.ts) seeds the position — the packaged app never
// reaches that path. Per position: the `app--bar-<p>` shell class + strip orientation + the bar's
// actual window edge, the core tab flows (open via `+`, activate by click, close via `×`), the
// axis-aware drag reorder (X on horizontal strips, Y on vertical rails), and the ⌘-digit keymap
// driven SYNTHETICALLY — real ⌘ chords are browser-owned and flaky in the dev server (see
// tabs.spec.ts), so KeyboardEvents are dispatched on `window`, where App's capture-phase keydown
// listener (tabKeymap.ts) reads exactly {key, metaKey, ctrlKey, altKey, shiftKey}.
//
// DELIBERATE SCOPE CUT — the ⇧⌘] / ⇧⌘[ cycle chords are NATIVE MENU accelerators (main.rs emits
// "next"/"prev" over the `tabs:action` event bus): the webview has no keydown listener for them,
// and without a Tauri runtime the bus subscription rejects, so no synthetic DOM event can drive
// them here. They are covered headless (App.test.tsx drives tabs:action) and by the packaged
// --smoke tier; this spec instead pins the keymap's extra-modifier veto (⇧⌘2 must pass through
// untouched — reserved chords keep their owners).
//
// Overflow (12 tabs on a small window) runs on bottom + left ONLY — one horizontal strip and one
// vertical rail cover both scroll axes without doubling the suite's wall time.
import { test, expect, type Page } from "@playwright/test";

type Position = "top" | "bottom" | "left" | "right";

const POSITIONS: readonly Position[] = ["top", "bottom", "left", "right"];
const ACTIVE = /tab-strip__tab--active/;

/** The trmx-81 D1 boot seam: seed tabs.barPosition before hydration falls back to defaults. */
function gotoWithPosition(page: Page, position: Position) {
  return page.goto(`/?setting.tabs.barPosition=${position}`);
}

/** Dispatch a ⌘-chord keydown on `window` — the target App's capture-phase keymap listens on. */
function dispatchMetaChord(page: Page, key: string, shiftKey = false) {
  return page.evaluate(
    ([key, shiftKey]) => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: key as string,
          metaKey: true,
          ctrlKey: false,
          altKey: false,
          shiftKey: shiftKey as boolean,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    [key, shiftKey] as const,
  );
}

for (const position of POSITIONS) {
  const vertical = position === "left" || position === "right";

  test.describe(`bar position: ${position}`, () => {
    test("boots with the shell class, the right strip orientation, and the bar on that edge", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 900, height: 600 });
      await gotoWithPosition(page, position);

      // The T3 contract: main.app carries app--bar-<position>; vertical rails carry the
      // tab-strip--vertical modifier, horizontal strips must not.
      await expect(page.locator("main.app")).toHaveClass(
        new RegExp(`(^| )app--bar-${position}( |$)`),
      );
      const strip = page.getByTestId("tab-strip");
      await expect(strip).toBeVisible();
      if (vertical) {
        await expect(strip).toHaveClass(/tab-strip--vertical/);
      } else {
        await expect(strip).not.toHaveClass(/tab-strip--vertical/);
      }

      // The flex-direction trick actually lands the bar on the requested window edge.
      const box = (await strip.boundingBox())!;
      expect(box).not.toBeNull();
      if (position === "top") expect(box.y).toBeLessThanOrEqual(1);
      if (position === "bottom") expect(box.y + box.height).toBeGreaterThanOrEqual(600 - 1);
      if (position === "left") expect(box.x).toBeLessThanOrEqual(1);
      if (position === "right") expect(box.x + box.width).toBeGreaterThanOrEqual(900 - 1);

      // Geometry contract: 180px-wide rails (content-box — the divider border sits outside)
      // with ≥34px-tall tabs; 34px-tall horizontal strips (+1px divider border).
      if (vertical) {
        expect(box.width).toBeGreaterThanOrEqual(180);
        expect(box.width).toBeLessThanOrEqual(182);
        const tab = (await page.getByTestId("tab-1").boundingBox())!;
        expect(tab.height).toBeGreaterThanOrEqual(34);
      } else {
        expect(box.height).toBeGreaterThanOrEqual(34);
        expect(box.height).toBeLessThanOrEqual(36);
      }
    });

    test("opens 2nd and 3rd tabs via +, activates by click, closes via the × affordance", async ({
      page,
    }) => {
      await gotoWithPosition(page, position);
      const tabs = page.locator(".tab-strip__tab");
      await expect(tabs).toHaveCount(1);
      await expect(page.getByTestId("tab-1")).toHaveClass(ACTIVE);

      // + opens the 2nd and 3rd tabs; each newborn becomes the active one.
      await page.getByTestId("tab-new").click();
      await expect(tabs).toHaveCount(2);
      await expect(page.getByTestId("tab-2")).toHaveClass(ACTIVE);
      await page.getByTestId("tab-new").click();
      await expect(tabs).toHaveCount(3);
      await expect(page.getByTestId("tab-3")).toHaveClass(ACTIVE);
      await expect(page.getByTestId("tab-host-3")).toBeVisible();

      // Activate by click: the background tab surfaces its keep-alive host.
      await page.getByTestId("tab-1").click();
      await expect(page.getByTestId("tab-1")).toHaveClass(ACTIVE);
      await expect(page.getByTestId("tab-host-1")).toBeVisible();
      await expect(page.getByTestId("tab-host-3")).toBeHidden();
      await expect(page.getByTestId("tab-host-3")).toBeAttached();

      // × a background tab: the active one keeps its identity.
      await page.getByTestId("tab-close-3").click();
      await expect(tabs).toHaveCount(2);
      await expect(page.getByTestId("tab-3")).toHaveCount(0);
      await expect(page.getByTestId("tab-1")).toHaveClass(ACTIVE);

      // × the ACTIVE tab: activation falls to the neighbor (iTerm2 rule).
      await page.getByTestId("tab-close-1").click();
      await expect(tabs).toHaveCount(1);
      await expect(page.getByTestId("tab-2")).toHaveClass(ACTIVE);
      await expect(page.getByTestId("tab-host-2")).toBeVisible();
    });

    test("a drag past the neighbor's midpoint reorders along the strip's axis", async ({
      page,
    }) => {
      await gotoWithPosition(page, position);
      await page.getByTestId("tab-new").click();
      await expect(page.locator(".tab-strip__tab")).toHaveCount(2);

      const box1 = (await page.getByTestId("tab-1").boundingBox())!;
      const box2 = (await page.getByTestId("tab-2").boundingBox())!;
      expect(box1).not.toBeNull();
      expect(box2).not.toBeNull();

      // Drag tab-1 from its center to well past tab-2's midpoint ON THE DRAG AXIS — x for
      // horizontal strips, y for vertical rails (hoverSlotFor flips at the midpoint).
      await page.mouse.move(box1.x + box1.width / 2, box1.y + box1.height / 2);
      await page.mouse.down();
      if (vertical) {
        await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height * 0.75, { steps: 8 });
      } else {
        await page.mouse.move(box2.x + box2.width * 0.75, box2.y + box2.height / 2, { steps: 8 });
      }
      await page.mouse.up();

      const order = await page
        .locator(".tab-strip__tab")
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
      expect(order).toEqual(["tab-2", "tab-1"]);
      // A drag is a reorder, not a click: the active tab (2) kept its identity across the move.
      await expect(page.getByTestId("tab-2")).toHaveClass(ACTIVE);
    });

    test("synthetic ⌘-digit chords select by index; an extra modifier is never intercepted", async ({
      page,
    }) => {
      await gotoWithPosition(page, position);
      await page.getByTestId("tab-new").click();
      await page.getByTestId("tab-new").click();
      await expect(page.locator(".tab-strip__tab")).toHaveCount(3);
      await expect(page.getByTestId("tab-3")).toHaveClass(ACTIVE);

      // ⌘2 activates the second tab.
      await dispatchMetaChord(page, "2");
      await expect(page.getByTestId("tab-2")).toHaveClass(ACTIVE);
      await expect(page.getByTestId("tab-host-2")).toBeVisible();

      // ⌘1 activates the first.
      await dispatchMetaChord(page, "1");
      await expect(page.getByTestId("tab-1")).toHaveClass(ACTIVE);

      // ⌘9 activates the LAST tab (the reducer's iTerm2 rule), whatever its index.
      await dispatchMetaChord(page, "9");
      await expect(page.getByTestId("tab-3")).toHaveClass(ACTIVE);

      // ⇧⌘2 is someone else's chord — the keymap's extra-modifier veto must leave it alone.
      // (⇧⌘[ / ⇧⌘] cycling is menu-owned — see the header — and covered headless + by --smoke.)
      await dispatchMetaChord(page, "2", true);
      await expect(page.getByTestId("tab-3")).toHaveClass(ACTIVE);
    });

    // Overflow on ONE horizontal strip (bottom) and ONE vertical rail (left) — the two scroll
    // axes — to keep the matrix's wall time sane.
    if (position === "bottom" || position === "left") {
      test("12 tabs overflow the strip; the last tab's × is clickable after scrolling to it", async ({
        page,
      }) => {
        // Small window so 12 tabs exceed the strip on either axis: horizontally
        // 12×60px(min-width)+34px(+) = 754 > 700; vertically 12×35px(min-height+divider)+34px
        // = 454 > 400.
        await page.setViewportSize({ width: 700, height: 400 });
        await gotoWithPosition(page, position);
        const tabs = page.locator(".tab-strip__tab");
        await expect(tabs).toHaveCount(1);
        for (let count = 2; count <= 12; count++) {
          await page.getByTestId("tab-new").click();
          await expect(tabs).toHaveCount(count);
        }

        // The strip actually overflows on its scroll axis.
        const strip = page.getByTestId("tab-strip");
        if (vertical) {
          await expect
            .poll(() => strip.evaluate((el) => el.scrollHeight - el.clientHeight))
            .toBeGreaterThan(0);
        } else {
          await expect
            .poll(() => strip.evaluate((el) => el.scrollWidth - el.clientWidth))
            .toBeGreaterThan(0);
        }

        // The LAST tab's close affordance still works once scrolled into view.
        const lastClose = page.getByTestId("tab-close-12");
        await lastClose.scrollIntoViewIfNeeded();
        await lastClose.click();
        await expect(tabs).toHaveCount(11);
        await expect(page.getByTestId("tab-12")).toHaveCount(0);
      });
    }
  });
}
