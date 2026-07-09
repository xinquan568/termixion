// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-82 (FR-2.3): side-rail label orientation against the Vite dev-server webview. The dev
// server has no Tauri backend, so hydrateSettings' config_read rejects and the D1 query seam
// (settingsStore.ts) seeds BOTH allowlisted keys — `?setting.tabs.barPosition=<p>` (trmx-81) and
// `?setting.tabs.sideLabelOrientation=<o>` (trmx-82) — the packaged app never reaches that path.
//
// Covered here (the browser-level half; jsdom can't do real layout/writing-mode/fixed anchoring):
// - left + vertical: both strip modifier classes, the slim 28px rail (trmx-163: the CSS-owned
//   --tab-bar-thickness — equal to the horizontal strip height — verified via the real boundingBox;
//   --tab-rail-width is retired), rotated label spans on every tab, and (trmx-169) the FIXED tab
//   height = calc(--tab-length + --tab-close-header) ≈ 204px — uniform across short and long titles;
// - the core tab flows survive vertical-label mode: activate by click, y-axis drag reorder past
//   the neighbor's midpoint, the synthetic ⌘-digit chord (the trmx-81 pattern — real ⌘ chords
//   are browser-owned and flaky in the dev server, so KeyboardEvents are dispatched on `window`,
//   where App's capture-phase keymap listens), close via ×;
// - the D4 rename overlay on a SCROLLED rail: position:fixed with inline left/top, wider than
//   the slim rail (never clipped by the 28px column), commit on Enter;
// - the applicability gate: a TOP bar ignores a vertical setting (labelOrientationFor forces
//   horizontal — no vertical-label class, NO geometry vars: the status-quo layout is CSS-owned);
// - the Settings surface: the Appearance page's Orientation row is aria-disabled with the hint
//   on the default bottom bar and enabled once the seam moves the bar left.
import { test, expect, type Page } from "@playwright/test";

const ACTIVE = /tab-strip__tab--active/;
const VERTICAL_URL = "/?setting.tabs.barPosition=left&setting.tabs.sideLabelOrientation=vertical";
const ORIENTATION_HINT = "Only applies when the tab bar is on the left or right.";

/** Dispatch a ⌘-chord keydown on `window` — the target App's capture-phase keymap listens on
 * (the tab-position.spec.ts helper; real ⌘ chords are browser-owned in the dev server). */
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

test("left bar + vertical setting: both modifier classes, the 28px rail, rotated labels on every tab", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto(VERTICAL_URL);

  const strip = page.getByTestId("tab-strip");
  await expect(strip).toBeVisible();
  await expect(strip).toHaveClass(/tab-strip--vertical/);
  await expect(strip).toHaveClass(/tab-strip--labels-vertical/);

  // The railGeometryFor tokens land as CSS custom properties on the strip's INLINE style
  // (TabStrip owns and writes them in vertical-label mode); trmx-163 retired --tab-rail-width, so
  // the surviving --tab-hint-header is the end-to-end signal here…
  expect(await strip.evaluate((el) => el.style.getPropertyValue("--tab-hint-header"))).toBe("20px");
  expect(await strip.evaluate((el) => el.style.getPropertyValue("--tab-rail-width"))).toBe("");
  // …and the rail actually renders slim: ≈28px (±2 — the shared --tab-bar-thickness, equal to the
  // horizontal strip height; the divider border is content-box-outside).
  const box = (await strip.boundingBox())!;
  expect(box).not.toBeNull();
  expect(box.width).toBeGreaterThanOrEqual(26);
  expect(box.width).toBeLessThanOrEqual(30);
  // Still pinned to the LEFT window edge (the trmx-81 flex trick is untouched by label mode).
  expect(box.x).toBeLessThanOrEqual(1);

  // Three tabs: every label span carries the writing-mode rotation class.
  await page.getByTestId("tab-new").click();
  await page.getByTestId("tab-new").click();
  await expect(page.locator(".tab-strip__tab")).toHaveCount(3);
  await expect(page.locator(".tab-strip__title--vertical")).toHaveCount(3);
});

test("the tab height is a FIXED label-axis length (--tab-length + close gutter): short & long tabs are UNIFORM (trmx-169)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto(VERTICAL_URL);
  const strip = page.getByTestId("tab-strip");
  await expect(strip).toHaveClass(/tab-strip--labels-vertical/);
  await page.getByTestId("tab-new").click();
  await expect(page.locator(".tab-strip__tab")).toHaveCount(2);

  // Pin both titles through the D4 rename overlay: tab-1 SHORT, tab-2 a 43-char path (its natural
  // rotated length far exceeds the tab's room).
  const longTitle = "/Users/dev/projects/termixion/very/deep/dir"; // 43 chars
  await page.getByTestId("tab-1").dblclick();
  const input = page.getByTestId("tab-rename-input");
  await input.fill("sh");
  await input.press("Enter");
  await expect(page.getByTestId("tab-1").locator(".tab-strip__title")).toHaveText("sh");
  await page.getByTestId("tab-2").dblclick();
  await input.fill(longTitle);
  await input.press("Enter");
  await expect(page.getByTestId("tab-2").locator(".tab-strip__title")).toHaveText(longTitle);

  // trmx-169: the vertical-label tab is now a FIXED height = calc(--tab-length 180px +
  // --tab-close-header 24px) = 204px (border-box), NOT a min/max range that grew with the label. So
  // BOTH tabs render at ~204px — a short and a very long title produce the SAME height (uniform,
  // like a horizontal tab is always ~180px wide), giving the rotated label the readable room the
  // ~80px-collapsed tabs lacked. The long label ellipsizes within its row (trmx-165 clip), so it
  // does NOT grow the tab.
  const shortBox = (await page.getByTestId("tab-1").boundingBox())!;
  const longBox = (await page.getByTestId("tab-2").boundingBox())!;
  expect(shortBox.height).toBeGreaterThanOrEqual(200); // ≈204 (180 + 24 gutter), border-box
  expect(shortBox.height).toBeLessThanOrEqual(208);
  expect(longBox.height).toBeGreaterThanOrEqual(200);
  expect(longBox.height).toBeLessThanOrEqual(208);
  // Uniform: the long-title tab is the SAME height as the short one (the trmx-169 fix — a long label
  // no longer grows the tab; it clips).
  expect(Math.abs(longBox.height - shortBox.height)).toBeLessThanOrEqual(1);
});

test("core flows survive vertical labels: click-activate, y-drag reorder, synthetic ⌘-digit, close", async ({
  page,
}) => {
  await page.goto(VERTICAL_URL);
  const tabs = page.locator(".tab-strip__tab");
  await page.getByTestId("tab-new").click();
  await expect(tabs).toHaveCount(2);
  await expect(page.getByTestId("tab-2")).toHaveClass(ACTIVE);

  // trmx-151: on the vertical rail the ⌘N prefix renders as the UPRIGHT chip (horizontal text,
  // outside the rotated writing-mode span) and stays visible despite the 28px rail being narrower
  // than the horizontal-drop threshold.
  const railHint = page.getByTestId("tab-1").locator(".tab-strip__hint");
  await expect(railHint).toHaveText("⌘1");
  await expect(railHint).toHaveClass(/tab-strip__hint--upright/);
  await expect(railHint).toBeVisible();

  // Drag tab-1 from its center to past tab-2's midpoint ON THE Y AXIS (the rail's drag axis;
  // hoverSlotFor flips at the midpoint) — the exact trmx-81 two-tab drag, now on TALL tabs.
  const box1 = (await page.getByTestId("tab-1").boundingBox())!;
  const box2 = (await page.getByTestId("tab-2").boundingBox())!;
  await page.mouse.move(box1.x + box1.width / 2, box1.y + box1.height / 2);
  await page.mouse.down();
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height * 0.75, { steps: 8 });
  await page.mouse.up();
  const order = await tabs.evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
  expect(order).toEqual(["tab-2", "tab-1"]);
  // A drag is a reorder, not a click: the active tab (2) kept its identity across the move.
  await expect(page.getByTestId("tab-2")).toHaveClass(ACTIVE);

  // Activate by click: the background tab surfaces its keep-alive host.
  await page.getByTestId("tab-1").click();
  await expect(page.getByTestId("tab-1")).toHaveClass(ACTIVE);
  await expect(page.getByTestId("tab-host-1")).toBeVisible();

  // A third tab (order [2, 1, 3]) drives the synthetic ⌘-digit chords (the trmx-81 pattern).
  await page.getByTestId("tab-new").click();
  await expect(tabs).toHaveCount(3);
  await expect(page.getByTestId("tab-3")).toHaveClass(ACTIVE);
  await dispatchMetaChord(page, "2"); // the second SLOT in [2, 1, 3] is tab-1
  await expect(page.getByTestId("tab-1")).toHaveClass(ACTIVE);
  await dispatchMetaChord(page, "1"); // the first slot is tab-2
  await expect(page.getByTestId("tab-2")).toHaveClass(ACTIVE);

  // Close via the × affordance: the active tab keeps its identity.
  await page.getByTestId("tab-close-3").click();
  await expect(tabs).toHaveCount(2);
  await expect(page.getByTestId("tab-3")).toHaveCount(0);
  await expect(page.getByTestId("tab-2")).toHaveClass(ACTIVE);
});

test("rename on a SCROLLED rail: the D4 fixed overlay is wider than the rail and commits on Enter", async ({
  page,
}) => {
  // Small window so ~10 tall tabs (fixed ~204px each, trmx-169) overflow the rail's height.
  await page.setViewportSize({ width: 700, height: 400 });
  await page.goto(VERTICAL_URL);
  const tabs = page.locator(".tab-strip__tab");
  for (let count = 2; count <= 10; count++) {
    await page.getByTestId("tab-new").click();
    await expect(tabs).toHaveCount(count);
  }

  // The rail overflows and a user-like wheel scroll actually moves it.
  const strip = page.getByTestId("tab-strip");
  await expect
    .poll(() => strip.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(0);
  await strip.hover();
  await page.mouse.wheel(0, 300);
  await expect.poll(() => strip.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);

  // Double-click a mid-rail tab: the rename input is the FIXED overlay, anchored to the tab's
  // viewport rect measured at rename start (inline left/top), NOT squeezed into the 28px column.
  const target = page.getByTestId("tab-6");
  await target.scrollIntoViewIfNeeded();
  await target.dblclick();
  const input = page.getByTestId("tab-rename-input");
  await expect(input).toBeVisible();
  await expect(input).toHaveClass(/tab-strip__rename--overlay/);
  expect(await input.evaluate((el) => getComputedStyle(el).position)).toBe("fixed");
  const inline = await input.evaluate((el) => ({
    left: (el as HTMLElement).style.left,
    top: (el as HTMLElement).style.top,
  }));
  expect(inline.left).not.toBe("");
  expect(inline.top).not.toBe("");
  const inputBox = (await input.boundingBox())!;
  const railBox = (await strip.boundingBox())!;
  expect(inputBox.width).toBeGreaterThan(railBox.width);

  // Type + Enter commits the manual title back onto the (rotated) label.
  await input.fill("build box");
  await input.press("Enter");
  await expect(page.getByTestId("tab-rename-input")).toHaveCount(0);
  await expect(page.getByTestId("tab-6").locator(".tab-strip__title")).toHaveText("build box");
});

test("a TOP bar ignores the vertical setting: horizontal labels enforced, status-quo geometry", async ({
  page,
}) => {
  await page.goto("/?setting.tabs.barPosition=top&setting.tabs.sideLabelOrientation=vertical");
  const strip = page.getByTestId("tab-strip");
  await expect(strip).toBeVisible();
  await expect(strip).not.toHaveClass(/tab-strip--vertical/);
  await expect(strip).not.toHaveClass(/tab-strip--labels-vertical/);
  await expect(page.locator(".tab-strip__title--vertical")).toHaveCount(0);
  // labelOrientationFor forced horizontal → NOT vertical-label mode, so TabStrip writes no
  // geometry vars at all: the horizontal strip's layout is a CSS-owned constant. (trmx-163:
  // --tab-hint-header is a surviving written token — absent here proves no vertical-label geometry.)
  expect(await strip.evaluate((el) => el.style.getPropertyValue("--tab-hint-header"))).toBe("");
});

test("Settings surface: the Orientation row is aria-disabled with the hint on the default bottom bar", async ({
  page,
}) => {
  await page.goto("/?window=settings&section=appearance");
  const group = page.getByRole("radiogroup", { name: "Tab label orientation" });
  await expect(group).toHaveAttribute("aria-disabled", "true");
  await expect(group.getByRole("radio")).toHaveText(["Horizontal", "Vertical"]);
  await expect(page.getByText(ORIENTATION_HINT)).toBeVisible();
});

test("Settings surface: the Orientation row enables once the bar sits left", async ({ page }) => {
  await page.goto("/?window=settings&section=appearance&setting.tabs.barPosition=left");
  // The seam seeded the position: the Position control shows it…
  await expect(page.getByRole("radio", { name: "Left" })).toHaveAttribute("aria-checked", "true");
  // …and the Orientation row is live (no aria-disabled anywhere in the group, no hint).
  const group = page.getByRole("radiogroup", { name: "Tab label orientation" });
  await expect(group).toBeVisible();
  await expect(group).not.toHaveAttribute("aria-disabled", "true");
  await expect(page.getByText(ORIENTATION_HINT)).toHaveCount(0);
});
