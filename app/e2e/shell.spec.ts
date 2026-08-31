// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-205: the Shell selector on the settings surface. trmx-251: it now runs against the fake
// Tauri runtime, so `shells_list` RESOLVES and the row asserts the hydrated list — the surface a
// user actually sees. The degraded no-backend shape it used to assert has not been deleted; it
// moved to shell-degraded.spec.ts, because trmx-205 documented it as specified behaviour rather
// than a harness artefact.
//
// The list content comes from the Rust-asserted golden, so a change to `ShellEntry`'s serialization
// breaks the Rust assertion rather than silently rewriting what this spec expects.
import { test, expect } from "@playwright/test";
import { installTauriFake, commandGolden } from "./fixtures/tauriFake";

test("the Shell row renders the REAL discovered shells, defaulting to System default", async ({
  page,
}) => {
  await installTauriFake(page);
  await page.goto("/?window=settings");
  const select = page.getByRole("combobox", { name: "Shell" });
  await expect(select).toBeVisible();
  await expect(select).toHaveValue("__system__");

  // The composition, asserted as the UI actually builds it: its OWN "System default" sentinel
  // first, then every shell the BACKEND discovered, then the free-text escape hatch. The middle
  // segment is derived from the golden rather than restated, so it cannot drift from Rust silently.
  //
  // Note the backend does not emit a "System default" entry — that option belongs to the UI. An
  // earlier golden hand-wrote one and produced a duplicate here, which is how it was caught.
  const discovered = (commandGolden.shellsList as { label: string }[]).map((e) => e.label);
  const labels = await select.locator("option").allTextContents();
  expect(labels).toEqual(["System default", ...discovered, "Custom path…"]);

  // The point of the rewrite: real discovered shells are present, which the degraded list
  // (System default + Custom path… only) could never show.
  expect(discovered).toContain("zsh");
  expect(discovered.length).toBeGreaterThan(1);
  await expect(page.getByText("Applies to new sessions", { exact: false })).toBeVisible();
});

test("Custom path… reveals the free-text field and System default hides it again", async ({
  page,
}) => {
  await page.goto("/?window=settings");
  const select = page.getByRole("combobox", { name: "Shell" });
  await select.selectOption("__custom__");
  const custom = page.getByRole("textbox", { name: "Shell" });
  await expect(custom).toBeVisible();
  await expect(custom).toHaveAttribute("placeholder", "/bin/zsh");
  await custom.fill("/opt/homebrew/bin/fish");
  await custom.press("Enter");
  await expect(select).toHaveValue("__custom__");

  await select.selectOption("__system__");
  await expect(page.getByRole("textbox", { name: "Shell" })).toHaveCount(0);
});
