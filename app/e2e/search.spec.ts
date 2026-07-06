// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-98 (FR-1.5): the in-pane search WIRING, end to end in the dev server — ⌘F opens the real find
// bar (registry command → keymap → commandCtx → per-pane overlay), the bar is interactive, the search
// actually runs (calls the addon), and Esc closes it and returns focus to the terminal. The dev server
// is backend-less (no PTY), so there is no scrollback CONTENT to match here — the count/wrap/
// scroll-into-view/case-vs-regex behaviour over real content is pinned by the FindBar + findState unit
// tests and the packaged manual checklist (README); this spec proves the App integration.
import { test, expect } from "@playwright/test";

test("⌘F opens the find bar; typing runs a search; Esc closes it", async ({ page }) => {
  await page.goto("/");
  // The terminal (with its search addon) must be mounted before ⌘F can open its bar.
  await expect(page.locator(".xterm").first()).toBeVisible();
  await page.locator(".xterm").first().click(); // focus the pane

  // ⌘F — the App intercepts it (capture-phase keydown) and opens the pane's find bar.
  await page.keyboard.press("Meta+f");
  const bar = page.getByRole("search", { name: "Find in terminal" });
  await expect(bar).toBeVisible();
  const input = page.getByLabel("Find", { exact: true });
  await expect(input).toBeFocused(); // the bar takes the keyboard

  // Typing runs the search; with no PTY content the addon reports 0 matches → "0/0".
  await input.fill("needle");
  await expect(bar.locator(".tx-find-bar__count")).toHaveText("0/0");

  // The toggles are interactive.
  const caseToggle = page.getByRole("button", { name: "Match case" });
  await caseToggle.click();
  await expect(caseToggle).toHaveAttribute("aria-pressed", "true");
  const regexToggle = page.getByRole("button", { name: "Use regular expression" });
  await regexToggle.click();
  await expect(regexToggle).toHaveAttribute("aria-pressed", "true");

  // Esc closes the bar (and returns focus to the terminal).
  await page.keyboard.press("Escape");
  await expect(bar).toHaveCount(0);
});

test("the find bar is per-pane: splitting and ⌘F opens a bar on the focused pane only", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".xterm").first()).toBeVisible();
  await page.locator(".xterm").first().click();

  // Split right (⌘D) → two panes; the new pane is focused.
  await page.keyboard.press("Meta+d");
  await expect(page.locator(".xterm")).toHaveCount(2);

  // ⌘F opens a bar; exactly one is open (on the focused pane), not both.
  await page.keyboard.press("Meta+f");
  await expect(page.getByRole("search", { name: "Find in terminal" })).toHaveCount(1);
});
