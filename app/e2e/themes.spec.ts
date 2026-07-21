// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-89 (I): e2e for the user-theme picker's UI surface. The Playwright harness runs against the
// plain `pnpm dev` server (no Tauri backend), so the FILE-backed flows — dropping a theme file,
// Duplicate writing to disk, live hot reload — cannot be exercised here (they need the real fs and
// are covered by the unit/integration suites with a fake backend + the packaged-app checklist in
// the PR's Test plan). What this spec pins is that the widened picker (trmx-89 D/4b) DEGRADES
// GRACEFULLY without a backend: the six built-ins still render and stay selectable, the new
// affordances (Open themes folder, the trmx-171 right-click Duplicate menu, the docs hint) are
// present, and no user themes appear (the registry hydrate no-ops without a runtime) — never crashes.
import { test, expect } from "@playwright/test";

test("Appearance picker: built-ins still render + the user-theme affordances are present (trmx-89)", async ({
  page,
}) => {
  await page.goto("/?window=settings&section=appearance");

  // The widening (ThemeId -> string, listThemes()) must not regress the built-in row: still exactly
  // the eight built-ins (trmx-202: luminance order, light novelties removed), all selectable radios
  // (user themes need the backend, absent here).
  const swatches = page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio");
  await expect(swatches).toHaveCount(8);
  await expect(swatches).toHaveText(["Catppuccin Latte", "Nord", "Dracula", "Gruvbox", "Solarized", "Catppuccin Mocha", "Tokyo Night", "Night"]);

  // The new user-theme affordances render even with no backend:
  // - "Open themes folder" button (clicking it is a no-op without a runtime — the opener rejects
  //   and is swallowed; we assert presence + that a click does not crash the page).
  const openFolder = page.getByRole("button", { name: "Open themes folder" });
  await expect(openFolder).toBeVisible();

  // - trmx-171: Duplicate is a right-click context menu now (no per-swatch button); right-clicking a
  //   built-in swatch opens the menu with a Duplicate item.
  await expect(page.getByRole("button", { name: /^Duplicate / })).toHaveCount(0);
  await page.getByRole("radio", { name: "Night", exact: true }).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /^Duplicate/ })).toBeVisible();
  await page.keyboard.press("Escape");

  // - the file-format docs hint links docs/themes.md.
  const hint = page.getByRole("link", { name: "Learn the theme file format" });
  await expect(hint).toHaveAttribute("href", /docs\/themes\.md$/);

  // Graceful degradation: clicking Open-folder (opener rejects, no runtime) does not break the page —
  // the built-in row is still intact and interactive afterwards.
  await openFolder.click();
  await expect(swatches).toHaveCount(8);
  await page.getByRole("radio", { name: "Night", exact: true }).click();
  await expect(page.locator(".tx-settings")).toHaveCSS("background-color", "rgb(0, 0, 0)");
});

// trmx-218: the picker is a UNIFORM grid — circles form columns across wrapped rows, labels wrap
// to at most two lines inside a fixed two-line box, and only truly overlong names clamp (full name
// recoverable from the label span's title). This test seeds ONE long-stem user theme through a
// fake __TAURI_INTERNALS__ installed BEFORE navigation whose invoke answers ONLY themes_read —
// every other command rejects, exactly like the no-backend dev server — so the built-ins hydrate
// as in production while the user cell joins the grid. (The previous test keeps running WITHOUT
// the bootstrap: the production no-backend shape stays pinned.)
test("Appearance picker: swatches align in a uniform grid; long labels clamp to two lines (trmx-218)", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      transformCallback: () => 0,
      invoke: (cmd: string) =>
        cmd === "themes_read"
          ? Promise.resolve([
              {
                id: "user:aurora-borealis-midnight-express-overdrive",
                source: "user",
                valid: false,
                spec: null,
                // Wire-realistic (step-8 F1): Rust serializes InvalidColor as { type, key, got },
                // so the badge exercises the same firstMessage branch production hits.
                warnings: [{ type: "InvalidColor", key: "color.bg.primary", got: "not-a-color" }],
              },
            ])
          : Promise.reject(new Error(`e2e fake backend: unhandled command ${cmd}`)),
    };
  });
  await page.goto("/?window=settings&section=appearance");

  // The user cell hydrated: 8 built-in radios + 1 invalid (non-radio) user swatch = 9 cells.
  const cells = page.locator(".tx-swatch-cell");
  await expect(cells).toHaveCount(9);

  // 1. Uniform cells: every cell box has the same width.
  const boxes = [];
  for (let i = 0; i < 9; i++) {
    const box = await cells.nth(i).boundingBox();
    if (!box) throw new Error(`cell ${i} has no box`);
    boxes.push(box);
  }
  const widths = boxes.map((b) => Math.round(b.width));
  expect(new Set(widths).size).toBe(1);

  // 2. Wrapped rows form COLUMNS: group cells by row (y), then left-edges must align across rows
  //    (≤1px tolerance — grid gaps can land on sub-pixels).
  const rows = new Map<number, number[]>();
  for (const b of boxes) {
    const y = Math.round(b.y);
    rows.set(y, [...(rows.get(y) ?? []), b.x]);
  }
  expect(rows.size).toBeGreaterThan(1); // the catalog wraps at the settings-window width
  const [firstRow, ...restRows] = [...rows.values()].map((xs) => xs.sort((a, b) => a - b));
  for (const row of restRows) {
    row.forEach((x, col) => expect(Math.abs(x - firstRow[col])).toBeLessThanOrEqual(1));
  }

  // 3. Fixed two-line label box: every label renders the same client height — one-line "Nord",
  //    two-line "Catppuccin Mocha", and the clamped user label alike.
  const labels = page.locator(".tx-swatch__label");
  await expect(labels).toHaveCount(9);
  const metrics = await labels.evaluateAll((els) =>
    els.map((el) => ({
      text: el.textContent ?? "",
      title: el.getAttribute("title"),
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    })),
  );
  expect(new Set(metrics.map((m) => m.clientHeight)).size).toBe(1);

  // 4. No built-in clamps (both Catppuccins render fully, on two lines); the long user label DOES
  //    clamp — and its textContent is still the FULL name (CSS-only truncation).
  const user = metrics.find((m) => m.text.includes("Aurora"));
  if (!user) throw new Error("user-theme label not found");
  for (const m of metrics) {
    if (m === user) continue;
    expect(m.scrollHeight, `built-in "${m.text}" must not clamp`).toBeLessThanOrEqual(
      m.clientHeight,
    );
  }
  expect(user.scrollHeight).toBeGreaterThan(user.clientHeight);
  expect(user.text).toContain("Overdrive"); // the tail is in the DOM, only visually clamped

  // 5. Every label span carries the full name as its tooltip.
  for (const m of metrics) {
    expect(m.title).toBe(m.text);
  }

  // 6. The invalid badge centers under its uniform cell.
  const badge = page.locator(".tx-swatch__badge--error");
  await expect(badge).toBeVisible();
  const badgeBox = await badge.boundingBox();
  const userCellBox = await cells.nth(8).boundingBox();
  if (!badgeBox || !userCellBox) throw new Error("badge/cell box missing");
  const badgeCenter = badgeBox.x + badgeBox.width / 2;
  const cellCenter = userCellBox.x + userCellBox.width / 2;
  expect(Math.abs(badgeCenter - cellCenter)).toBeLessThanOrEqual(1);
});
