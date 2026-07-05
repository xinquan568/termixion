// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-90 (FR-4, I): e2e of the per-pane badge UI path against the Vite dev-server webview (no
// backend — open_pty rejects, the pane keeps a dead session, which is fine: the badge UI is a
// frontend concern). The keyboard round-trip is driven through App's keymap (⇧⌘B) exactly as
// panes.spec drives ⌘D split — a synthetic window keydown, since a real browser-owned ⇧⌘B would be
// swallowed by the OS/menu in the packaged app (mutually exclusive with the keymap path, see
// tabKeymap.ts). The OSC-1337 escape path + real cross-pane scoping are covered by the unit/component
// suites + the packaged checklist; here we prove set → render → edit → clear end to end.
import { test, expect, type Page } from "@playwright/test";

/** Open the badge editor on the focused pane via App's keymap (⇧⌘B). */
async function openBadgeEditor(page: Page) {
  await page.locator(".pane-host--focused").first().waitFor({ state: "attached" });
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "b", metaKey: true, shiftKey: true, bubbles: true }),
    );
  });
}

test("⇧⌘B sets a per-pane badge, edits it, and clears it (trmx-90)", async ({ page }) => {
  await page.goto("/");

  // Set: ⇧⌘B → the inline editor opens on the focused pane; type + Enter commits.
  await openBadgeEditor(page);
  const editor = page.locator(".tx-badge-input");
  await expect(editor).toBeVisible();
  await editor.fill("DB PROD");
  await editor.press("Enter");

  // The badge overlay renders the text in the pane's corner.
  const badge = page.getByTestId("pane-badge");
  await expect(badge).toHaveText("DB PROD");
  // The overlay is non-interactive (click-through): it must never intercept terminal mouse events.
  await expect(badge).toHaveCSS("pointer-events", "none");

  // Edit: ⇧⌘B again → the editor re-opens seeded with the current badge; change + Enter.
  await openBadgeEditor(page);
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue("DB PROD");
  await editor.fill("STAGING");
  await editor.press("Enter");
  await expect(badge).toHaveText("STAGING");

  // Clear: ⇧⌘B → empty + Enter clears the slot; the overlay disappears.
  await openBadgeEditor(page);
  await editor.fill("");
  await editor.press("Enter");
  await expect(page.getByTestId("pane-badge")).toHaveCount(0);

  // Esc cancels without changing the (now empty) badge.
  await openBadgeEditor(page);
  await expect(editor).toBeVisible();
  await editor.fill("SCRATCH");
  await editor.press("Escape");
  await expect(page.getByTestId("pane-badge")).toHaveCount(0);
});
