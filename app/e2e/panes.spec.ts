// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-84 (FR-3.1/3.2): component-level E2E of split panes against the Vite dev-server webview.
// There is NO backend here (open_pty rejects), so each pane keeps a dead session — which is fine,
// these tests assert the STRUCTURAL contract: a tab renders one absolutely-positioned pane host per
// leaf, a split adds a sibling + a divider, and a re-layout never DETACHES an existing pane host
// (keep-alive — the frontend half of "sessions survive re-layout"; the PID-level proof is the
// packaged `--smoke` tier + the Rust real-PTY lifecycle test). Splits are driven by a SYNTHETIC
// keydown dispatched from JS (App's capture-phase window handler picks it up) rather than a real
// ⌘D — a real ⌘D is browser-owned (bookmark) and flaky, the same reason tabs.spec.ts avoids chords.
import { test, expect, type Page } from "@playwright/test";

/** Split the focused pane via App's keymap, without a real (browser-owned) ⌘D keypress. */
async function split(page: Page, opts: { below?: boolean } = {}) {
  // Wait for a focused pane to exist first — the split targets it, and a keydown dispatched before
  // boot finishes rendering the pane would be a no-op (there is nothing focused to split yet).
  await page.locator(".pane-host--focused").first().waitFor({ state: "attached" });
  await page.evaluate((below) => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "d", metaKey: true, shiftKey: below, bubbles: true }),
    );
  }, opts.below ?? false);
}

test("boots with a single pane; ⌘D splits into attached sibling panes with a divider", async ({
  page,
}) => {
  await page.goto("/");
  const panes = page.locator(".pane-host");
  await expect(panes).toHaveCount(1);
  await expect(page.getByTestId("pane-host-1")).toBeVisible();

  // Split Right: a second pane host + a (vertical, row) divider.
  await split(page);
  await expect(panes).toHaveCount(2);
  await expect(page.getByTestId("pane-host-2")).toBeVisible();
  await expect(page.locator(".pane-divider--row")).toHaveCount(1);
  // The new pane is focused.
  await expect(page.getByTestId("pane-host-2")).toHaveClass(/pane-host--focused/);
});

test("re-layout keeps existing pane hosts ATTACHED (keep-alive across splits)", async ({ page }) => {
  await page.goto("/");
  await split(page); // panes 1 | 2
  await expect(page.locator(".pane-host")).toHaveCount(2);

  // A second split re-lays-out the tab; neither existing pane host may detach.
  await split(page, { below: true }); // splits the focused pane 2 → (2 / 3)
  await expect(page.locator(".pane-host")).toHaveCount(3);
  await expect(page.getByTestId("pane-host-1")).toBeAttached();
  await expect(page.getByTestId("pane-host-2")).toBeAttached();
  await expect(page.getByTestId("pane-host-3")).toBeAttached();
  // The nested split added a horizontal (column) divider alongside the first vertical one.
  await expect(page.locator(".pane-divider--column")).toHaveCount(1);
  await expect(page.locator(".pane-divider--row")).toHaveCount(1);
});

test("panes stay within one tab; a new tab boots to a single pane again", async ({ page }) => {
  await page.goto("/");
  await split(page);
  await expect(page.locator(".pane-host")).toHaveCount(2); // tab 1 has two panes

  // A brand-new tab is a single pane (splitting never leaks across tabs); switching hides tab 1's
  // panes but keeps them attached (keep-alive).
  await page.getByTestId("tab-new").click();
  await expect(page.getByTestId("tab-2")).toHaveClass(/tab-strip__tab--active/);
  await expect(page.getByTestId("tab-host-2").locator(".pane-host")).toHaveCount(1);
  await expect(page.getByTestId("tab-host-1")).toBeHidden();
  await expect(page.getByTestId("pane-host-1")).toBeAttached();
});

test("dragging a divider resizes the two panes (keep-alive); double-click resets to ~50/50", async ({
  page,
}) => {
  await page.goto("/");
  await split(page); // panes 1 | 2 with a vertical (row) divider
  const divider = page.locator(".pane-divider--row").first();
  await expect(divider).toBeVisible();

  const p1 = page.getByTestId("pane-host-1");
  const beforeWidth = (await p1.boundingBox())!.width;
  const box = (await divider.boundingBox())!;

  // Grab the divider and drag it left; pane 1 must shrink and both panes stay attached (keep-alive).
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 150, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();

  const afterWidth = (await p1.boundingBox())!.width;
  expect(afterWidth).toBeLessThan(beforeWidth - 20);
  await expect(page.getByTestId("pane-host-1")).toBeAttached();
  await expect(page.getByTestId("pane-host-2")).toBeAttached();

  // Double-click the divider resets the split back to roughly half.
  await divider.dblclick();
  const resetWidth = (await p1.boundingBox())!.width;
  expect(Math.abs(resetWidth - beforeWidth)).toBeLessThan(8);
});

// trmx-86 (FR-3.5): keyboard pane navigation moves the focused-pane class. Nav chords are dispatched
// synthetically (App's capture-phase handler picks them up) — a real ⌥⌘-arrow is OS/browser-owned. The
// marker-char-lands-in-the-focused-pane check needs a PTY, so it is the packaged/manual gate; here we
// assert the observable focus movement (no backend in e2e).
async function navKey(page: Page, key: string, opts: { alt?: boolean } = {}) {
  await page.evaluate(
    ({ key, alt }) =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: true, altKey: alt, bubbles: true })),
    { key, alt: opts.alt ?? false },
  );
}

test("⌥⌘-arrows and ⌘] move the focused pane (trmx-86)", async ({ page }) => {
  await page.goto("/");
  await split(page); // panes 1 | 2; the new pane (2) is focused
  await expect(page.getByTestId("pane-host-2")).toHaveClass(/pane-host--focused/);

  await navKey(page, "ArrowLeft", { alt: true }); // ⌥⌘← → left pane (1)
  await expect(page.getByTestId("pane-host-1")).toHaveClass(/pane-host--focused/);
  await expect(page.getByTestId("pane-host-2")).not.toHaveClass(/pane-host--focused/);

  await navKey(page, "ArrowRight", { alt: true }); // ⌥⌘→ → right pane (2)
  await expect(page.getByTestId("pane-host-2")).toHaveClass(/pane-host--focused/);

  await navKey(page, "]"); // ⌘] cycles (2 → 1, wrapping over the leaves order)
  await expect(page.getByTestId("pane-host-1")).toHaveClass(/pane-host--focused/);
});

test("the focused pane's dividers render active; a focus flip moves the active chrome (trmx-87)", async ({
  page,
}) => {
  await page.goto("/");
  await split(page); // 1 | 2 (focus 2)
  await page.getByTestId("pane-host-1").click(); // focus 1
  await split(page, { below: true }); // split pane 1 → pane 3; tree ((1/3) | 2), focus 3

  // Focus pane 3 (bottom-left): the root divider + the left-column divider both outline it → 2 active.
  await expect(page.locator(".pane-divider--active")).toHaveCount(2);

  // Focus pane 2 (full-height right): only the root divider outlines it → 1 active; the left-column
  // divider becomes inactive (a class flip, no re-layout).
  await page.getByTestId("pane-host-2").click();
  await expect(page.locator(".pane-divider--active")).toHaveCount(1);
  await expect(page.locator(".pane-divider--inactive")).toHaveCount(1);
});
