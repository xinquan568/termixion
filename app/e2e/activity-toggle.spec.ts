// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-191: the ⌘⇧A manual activity toggle against a real browser. The dev server has no Tauri
// runtime — no detector ever fires — so the default pane's bar starts HIDDEN, which makes the
// override's own render the honestly-provable e2e surface: force-on shows the overlay, force-off
// hides it. Detector auto-clear and the trmx-190 counter coupling need injected activity events —
// jsdom-tier (App.test.tsx), by design. Real ⌘ chords are browser-owned and flaky in the dev
// server, so the chord is dispatched synthetically on `window` (the tab-position.spec precedent) —
// App's capture-phase keymap listener reads exactly {key, metaKey, ctrlKey, altKey, shiftKey}.
import { test, expect, type Page } from "@playwright/test";

function dispatchToggleChord(page: Page) {
  return page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

test("⌘⇧A force-shows the focused pane's hidden bar, and force-hides it again", async ({
  page,
}) => {
  await page.goto("/");
  const bar = page.getByTestId("pane-activity");
  await expect(bar).toHaveCount(0); // no detector in the dev server — hidden is the honest baseline

  await dispatchToggleChord(page);
  await expect(bar).toBeVisible(); // forced on — the override renders without any session

  await dispatchToggleChord(page);
  await expect(bar).toHaveCount(0); // rendered-active → forced off
});
