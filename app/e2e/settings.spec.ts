// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: component-level coverage of the settings-window surface in the webview (the dev server
// has no Tauri runtime — window creation itself is covered by the packaged --smoke + the manual
// dev pass). `?window=settings` must route to the settings surface with the vmark chrome: sidebar
// (search + Appearance/Terminal/About since trmx-53), the centered title, drag-region strips, and
// the pages' rows. trmx-53 adds the REAL computed-style proof (plan D4 layer ii) that a swatch
// click re-themes elements inside .tx-settings — jsdom can't cascade custom properties, so this
// browser-level check is the authoritative half of the cascade guarantee.
import { test, expect } from "@playwright/test";

test("?window=settings renders the settings surface with the vmark chrome", async ({ page }) => {
  await page.goto("/?window=settings");

  // Not the terminal surface —
  await expect(page.locator(".xterm")).toHaveCount(0);
  // — but the settings shell: search field, both nav entries, centered title.
  await expect(page.getByPlaceholder("Search settings…")).toBeVisible();
  await expect(page.getByRole("button", { name: "Terminal" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Scripts" })).toBeVisible();
  await expect(page.getByRole("button", { name: "About" })).toBeVisible();
  await expect(page.locator(".tx-settings__title")).toHaveText("Settings");

  // The Overlay-titlebar chrome that makes the window draggable (sidebar strip, content strip,
  // title overlay).
  const dragRegions = page.locator("[data-tauri-drag-region]");
  await expect(dragRegions).toHaveCount(3);

  // Default landing: the Terminal page with exactly the boxed rows (trmx-80 added Scrollback /
  // Font Family / Font Size below the two cursor rows; trmx-91 adds Activity Indicator; trmx-95
  // adds Copy on Select; trmx-144 adds Confirm Before Closing; trmx-190 adds AI Session Counter).
  await expect(page.getByText("Cursor Style", { exact: true })).toBeVisible();
  await expect(page.getByText("Cursor Blink", { exact: true })).toBeVisible();
  await expect(page.getByText("Copy on Select", { exact: true })).toBeVisible();
  await expect(page.getByText("Activity Indicator", { exact: true })).toBeVisible();
  await expect(page.getByText("AI Session Counter", { exact: true })).toBeVisible();
  await expect(page.getByText("Confirm before closing", { exact: true })).toBeVisible();
  await expect(page.getByText("Shell", { exact: true })).toBeVisible();
  await expect(page.getByText("Scrollback", { exact: true })).toBeVisible();
  await expect(page.getByText("Font Family", { exact: true })).toBeVisible();
  await expect(page.getByText("Font Size", { exact: true })).toBeVisible();
  await expect(page.locator(".tx-setting-row")).toHaveCount(14);
});

test("?window=settings&section=about lands on the vmark-parity About page", async ({ page }) => {
  await page.goto("/?window=settings&section=about");

  await expect(page.getByText("Automatic updates")).toBeVisible();
  await expect(page.getByText("Check frequency")).toBeVisible();
  await expect(page.getByText("Download updates automatically")).toBeVisible();
  await expect(page.getByRole("button", { name: "Check Now" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reset to Defaults" })).toBeVisible();
  // The identity links, stacked with icons.
  await expect(page.getByRole("button", { name: "Website" })).toBeVisible();
  await expect(page.getByRole("button", { name: "GitHub" })).toBeVisible();
});

test("?window=settings&section=scripts lands on the Scripts page (trmx-93)", async ({ page }) => {
  await page.goto("/?window=settings&section=scripts");

  await expect(page.locator(".tx-nav-item--active")).toHaveText("Scripts");
  // The Startup script row + its Select ("None" is present with no backend), and the folder action.
  await expect(page.getByText("Run on launch", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Startup script")).toBeVisible();
  await expect(page.getByRole("option", { name: "None" })).toBeAttached();
  await expect(page.getByRole("button", { name: "Open scripts folder" })).toBeVisible();
});

test("?window=settings&section=appearance shows the Theme row; a swatch click re-themes the window live (trmx-53)", async ({
  page,
}) => {
  await page.goto("/?window=settings&section=appearance");

  // Appearance is the FIRST nav entry (palette icon page), and the deep link landed on it.
  await expect(page.locator(".tx-nav-item").first()).toHaveText("Appearance");
  await expect(page.locator(".tx-nav-item--active")).toHaveText("Appearance");

  // The Theme row: eight labeled swatches, lightest to darkest (trmx-202 luminance order;
  // scoped to the Theme radiogroup —
  // trmx-81 adds the Tab bar Position radiogroup below it).
  const swatches = page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio");
  await expect(swatches).toHaveCount(8);
  await expect(swatches).toHaveText(["Catppuccin Latte", "Nord", "Dracula", "Gruvbox", "Solarized", "Catppuccin Mocha", "Tokyo Night", "Night"]);

  // trmx-81 (FR-2.2): the Tab bar group below Theme — the four-way Position segmented control,
  // Bottom (the registry default) selected. The live application is covered by
  // tab-position.spec.ts; the write-through/broadcast by the AppearanceSettings unit suite.
  const positions = page.getByRole("radiogroup", { name: "Tab bar position" }).getByRole("radio");
  await expect(positions).toHaveText(["Top", "Bottom", "Left", "Right"]);
  await expect(page.getByRole("radio", { name: "Bottom" })).toHaveAttribute(
    "aria-checked",
    "true",
  );

  // The COMPUTED background of an element inside .tx-settings follows the selection instantly —
  // the runtime documentElement vars must beat the :root fallback (plan D4).
  // trmx-202: leftmost (Catppuccin Latte) and rightmost (Night) of the luminance order both
  // re-theme live — the issue's explicit acceptance pair.
  await page.getByRole("radio", { name: "Catppuccin Latte" }).click();
  await expect(page.locator(".tx-settings")).toHaveCSS("background-color", "rgb(239, 241, 245)");
  await page.getByRole("radio", { name: "Night", exact: true }).click();
  await expect(page.locator(".tx-settings")).toHaveCSS("background-color", "rgb(0, 0, 0)");

  // NOTE (trmx-80): persistence-across-reload is no longer observable in the plain-browser dev
  // server. Settings now persist to the TOML config file through the Tauri backend; without a
  // runtime the store deliberately falls back to defaults (the issue's inert-degradation
  // contract), so a reload re-derives the OS default theme. Persistence is covered by the
  // settingsStore hydration/write unit tests and the packaged-app checklist.
});

test("theme Duplicate is a right-click context menu, not a per-swatch button (trmx-171)", async ({
  page,
}) => {
  await page.goto("/?window=settings&section=appearance");
  await expect(page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio")).toHaveCount(8);

  // No visible "Duplicate" button anywhere; the tip explains the right-click.
  await expect(page.getByRole("button", { name: /^Duplicate/ })).toHaveCount(0);
  await expect(
    page.getByText("Right-click a theme to duplicate it, or create a brand-new one."),
  ).toBeVisible();

  const night = page.getByRole("radio", { name: "Night", exact: true });

  // Right-click opens the custom in-DOM menu with a Duplicate item…
  await night.click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /^Duplicate/ })).toBeVisible();

  // …Escape closes it…
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  // …an OUTSIDE click closes it (pointerdown outside the popover)…
  await night.click({ button: "right" });
  await expect(page.getByRole("menu")).toBeVisible();
  await page.locator(".tx-settings-group__title").first().click(); // the "Theme" heading — inert, outside
  await expect(page.getByRole("menu")).toHaveCount(0);

  // …choosing Duplicate closes it. (The file WRITE needs the Tauri backend the dev server lacks, so
  // the write/hydrate/select is covered by the AppearanceSettings unit suite; here we only assert the
  // browser-observable menu flow — same reason themes.spec.ts avoids file-backed Duplicate.)
  await night.click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Duplicate/ }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);

  // …and near the viewport's right edge the popover is CLAMPED inside the window (jsdom can't check
  // this — real layout). Dispatch a contextmenu with clientX at the far edge, then assert the box.
  const vw = page.viewportSize()!.width;
  await night.dispatchEvent("contextmenu", { clientX: vw - 2, clientY: 140, bubbles: true });
  const clamped = page.getByRole("menu");
  await expect(clamped).toBeVisible();
  const box = await clamped.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(vw + 1);
});

test("the plain root still boots the terminal surface", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".xterm")).toBeAttached();
  await expect(page.getByPlaceholder("Search settings…")).toHaveCount(0);
});
