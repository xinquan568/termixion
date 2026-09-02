// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-253 (M20): LOCALISATION, not new coverage. The `_core.coreMouseService` seam is ALREADY
// asserted — `mouse-reporting.test.ts:48` does `expect(svc).toBeDefined()` before every encoding
// case. What this file adds is WHERE the failure lands. driver.ts reaches into an xterm internal
// (`term._core.coreMouseService`) because the headless build ships no public mouse ingress; if an
// xterm bump renames or removes that internal, `mouseService()` starts returning `undefined`. Today
// that surfaces as a mouse-conformance failure, which reads as "our mouse reporting broke" when the
// truth is "the harness lost its ingress". A test named for the seam, sitting next to the driver,
// says which of the two happened.
//
// CHARACTERISATION: the seam resolves today, so this passes on its first run. That is correct under
// R8 — RED is required for newly specified behaviour, not for relocating an existing assertion to
// where it diagnoses.
import { describe, it, expect } from "vitest";
import { mouseService, openTerm } from "./driver";

describe("conformance driver: the xterm internal seams it depends on", () => {
  // The pinned @xterm/headless 5.5.0 bundle exposes the common-code CoreMouseService un-mangled at
  // `_core.coreMouseService`. This is the whole reason mouse reports are assertable headless.
  it("mouseService() resolves the _core.coreMouseService seam", () => {
    const svc = mouseService(openTerm());
    expect(svc).toBeDefined();
  });

  it("the resolved service exposes triggerMouseEvent", () => {
    const svc = mouseService(openTerm());
    expect(typeof svc?.triggerMouseEvent).toBe("function");
  });

  // `mouseService()` is typed to return `undefined` rather than throwing when the internal moves —
  // pin that it degrades by returning, so the mouse suite's existence assertion is what reports the
  // loss (loud), not a TypeError from inside the driver (noisy and misattributed).
  it("returns undefined instead of throwing when the internal is absent", () => {
    const notATerm = {} as unknown as ReturnType<typeof openTerm>;
    expect(mouseService(notATerm)).toBeUndefined();
  });
});
