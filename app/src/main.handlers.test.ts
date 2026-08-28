// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-237 (grill H3): the two GLOBAL failure routes a React error boundary cannot see —
// `componentDidCatch` never fires for an error thrown in an event handler, a timer, or an async callback.
// Asserted SEPARATELY (one test per registration): a single "global handlers" test would let one of the
// two be missing, or wired to the wrong event name, while staying green.
//
// main.tsx cannot be imported under jsdom (it boots the real app), so — like main.order.test.ts — this is
// a source guard over the raw text. The behavioural coverage of the surface itself is in
// ErrorBoundary.test.tsx; what is pinned here is that both registrations exist and report.
import { describe, expect, it } from "vitest";
import source from "./main.tsx?raw";

describe("main.tsx global failure handlers (trmx-237 H3)", () => {
  it('registers a window "error" listener that reports', () => {
    const index = source.indexOf('window.addEventListener("error"');
    expect(index).toBeGreaterThan(-1);
    // The body must report — a silent listener would swallow the very thing it exists to surface.
    expect(source.slice(index, index + 260)).toContain("log.error");
  });

  it('registers a window "unhandledrejection" listener that reports', () => {
    const index = source.indexOf('window.addEventListener("unhandledrejection"');
    expect(index).toBeGreaterThan(-1);
    expect(source.slice(index, index + 260)).toContain("log.error");
  });

  it("registers both BEFORE boot() runs, so a startup failure is covered too", () => {
    const errorIndex = source.indexOf('window.addEventListener("error"');
    const rejectionIndex = source.indexOf('window.addEventListener("unhandledrejection"');
    const bootInvoke = source.indexOf("boot().catch(");
    expect(errorIndex).toBeLessThan(bootInvoke);
    expect(rejectionIndex).toBeLessThan(bootInvoke);
  });

  it("catches a rejected boot() and renders the recovery surface", () => {
    const index = source.indexOf("boot().catch(");
    expect(index).toBeGreaterThan(-1);
    // A bare .catch that only logs would leave the window blank — the surface must be rendered.
    expect(source.slice(index, index + 320)).toContain("renderFatalSurface");
  });

  it("wraps BOTH surfaces in an ErrorBoundary, with per-surface actions", () => {
    expect(source).toContain('<ErrorBoundary surface="settings"');
    expect(source).toContain('<ErrorBoundary surface="main"');
    // The settings surface must not be handed a quit action (quit_confirmed ignores it anyway).
    const settingsIndex = source.indexOf('<ErrorBoundary surface="settings"');
    const settingsTag = source.slice(settingsIndex, source.indexOf(">", settingsIndex));
    expect(settingsTag).toContain("onCloseWindow");
    expect(settingsTag).not.toContain("onQuit");
  });
});
