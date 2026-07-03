// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-78 (test-first): the NFR-1 budget verdict over an assembled perf report. Budgets are the
// issue's table (typing p50 ≤ 16 ms / p95 ≤ 33 ms; dropped frames < 5 % on EVERY scroll
// scenario), plus the validity gate the issue calls out explicitly: a report whose renderer is
// not "webgl" is invalid — a silent DOM fallback would fake every number.
import { describe, expect, it } from "vitest";
import { BUDGETS, evaluatePerf, type PerfReportBody } from "./evaluatePerf";

function goodReport(): PerfReportBody {
  return {
    schema: 1,
    build: "release",
    renderer: "webgl",
    hasFocus: true,
    scenarios: {
      typing: { count: 1000, p50: 8, p95: 21, p99: 29, max: 40 },
      scrollSeq: { totalFrames: 1800, missed: 12, droppedPct: 0.7 },
      scrollYes: { totalFrames: 300, missed: 3, droppedPct: 1 },
      scrollbackPaging: { totalFrames: 240, missed: 0, droppedPct: 0 },
    },
  };
}

describe("evaluatePerf", () => {
  it("pins the issue's budget table", () => {
    expect(BUDGETS).toEqual({ typingP50Ms: 16, typingP95Ms: 33, droppedPct: 5 });
  });

  it("passes a report inside every budget", () => {
    expect(evaluatePerf(goodReport())).toEqual({
      ok: true,
      reason: "all budgets met (typing p50 8ms p95 21ms; worst scroll 1%)",
    });
  });

  it("fails typing p50 over budget, naming metric and value", () => {
    const report = goodReport();
    report.scenarios.typing!.p50 = 17;
    const verdict = evaluatePerf(report);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("p50");
    expect(verdict.reason).toContain("17");
  });

  it("fails typing p95 over budget", () => {
    const report = goodReport();
    report.scenarios.typing!.p95 = 34;
    expect(evaluatePerf(report).ok).toBe(false);
  });

  it("fails when ANY scroll scenario reaches 5% dropped, naming the scenario", () => {
    const report = goodReport();
    report.scenarios.scrollYes!.droppedPct = 5;
    const verdict = evaluatePerf(report);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("scrollYes");
  });

  it("fails a non-webgl renderer outright (invalid measurement, not a budget miss)", () => {
    const report = goodReport();
    report.renderer = "dom";
    const verdict = evaluatePerf(report);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("renderer");
  });

  it("fails an unfocused run outright — the protocol's validity gate, enforced (step-8 F1)", () => {
    const unfocused = goodReport();
    unfocused.hasFocus = false;
    const verdict = evaluatePerf(unfocused);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain("focus");

    const unknown = goodReport();
    delete unknown.hasFocus;
    expect(evaluatePerf(unknown).ok).toBe(false);
  });

  it("fails a report with a missing scenario (a partial run must not pass)", () => {
    const report = goodReport();
    delete report.scenarios.scrollbackPaging;
    expect(evaluatePerf(report).ok).toBe(false);
  });
});
