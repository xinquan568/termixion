// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-251: the DEGRADED Shell row, kept as its own spec.
//
// This assertion used to live in shell.spec.ts, which now installs the fake and asserts the
// hydrated list (the issue's acceptance). The degraded shape is not an artefact of the harness —
// trmx-205 documented it as specified behaviour: when `shells_list` rejects, the dropdown falls
// back to exactly System default + Custom path…. Rewriting the other spec without moving this one
// would have deleted that contract at the browser level while looking like a pure improvement.
//
// It opts out of the fake simply by not calling installTauriFake — which is why the fake is a
// helper rather than an auto-applied fixture.
//
// The same contract is pinned at unit level in
// app/src/settings/TerminalSettings.test.tsx:422-429; this keeps the E2E layer too.
import { test, expect } from "@playwright/test";

test("with no backend, the Shell row degrades to System default + Custom path…", async ({
  page,
}) => {
  // Deliberately NO fake: every invoke rejects, exactly as the plain dev server behaves.
  await page.goto("/?window=settings");
  const select = page.getByRole("combobox", { name: "Shell" });
  await expect(select).toBeVisible();
  await expect(select).toHaveValue("__system__");
  const labels = await select.locator("option").allTextContents();
  expect(labels).toEqual(["System default", "Custom path…"]);
  await expect(page.getByText("Applies to new sessions", { exact: false })).toBeVisible();
});
