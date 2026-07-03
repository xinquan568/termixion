// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-78 (test-first): the pure statistics behind the NFR-1 perf report — percentiles over
// latency samples and missed-frame counting over requestAnimationFrame timestamp streams
// (docs/design/performance-protocol.md defines both). Known-value pins so the math can never
// drift silently under a later refactor.
import { describe, expect, it } from "vitest";
import { FRAME_BUDGET_MS, GAP_FACTOR, missedFrames, percentile, summarize } from "./stats";

describe("percentile (nearest-rank over a sorted array)", () => {
  const oneToHundred = Array.from({ length: 100 }, (_, i) => i + 1);

  it("pins the canonical 1..100 table", () => {
    expect(percentile(oneToHundred, 50)).toBe(50);
    expect(percentile(oneToHundred, 95)).toBe(95);
    expect(percentile(oneToHundred, 99)).toBe(99);
    expect(percentile(oneToHundred, 100)).toBe(100);
  });

  it("a single sample is every percentile", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });

  it("rejects an empty sample set loudly (a silent 0 would fake a passing budget)", () => {
    expect(() => percentile([], 50)).toThrow();
  });
});

describe("summarize", () => {
  it("sorts internally and reports count/p50/p95/p99/max", () => {
    const samples = [30, 10, 20, 50, 40]; // deliberately unsorted
    expect(summarize(samples)).toEqual({ count: 5, p50: 30, p95: 50, p99: 50, max: 50 });
  });
});

describe("missedFrames (rAF gap counting)", () => {
  it("a perfect 60 Hz stream drops nothing", () => {
    const stamps = Array.from({ length: 61 }, (_, i) => i * FRAME_BUDGET_MS);
    expect(missedFrames(stamps)).toEqual({ totalFrames: 60, missed: 0, droppedPct: 0 });
  });

  it("counts the frames missed inside a long gap (issue: gap > 1.5 × 16.7 ms)", () => {
    // One 50 ms gap ≈ 3 frame budgets → 2 frames never rendered in that window.
    const result = missedFrames([0, 50]);
    expect(result.missed).toBe(2);
    expect(result.totalFrames).toBe(3); // 1 rendered interval + 2 missed
    expect(result.droppedPct).toBeCloseTo((2 / 3) * 100, 1);
  });

  it("a gap under the 1.5× threshold is jitter, not a drop", () => {
    expect(missedFrames([0, 20, 40]).missed).toBe(0); // 20 ms < 25 ms threshold
    expect(GAP_FACTOR).toBe(1.5);
  });

  it("degenerate streams (0–1 timestamps) report zero frames, not NaN", () => {
    expect(missedFrames([])).toEqual({ totalFrames: 0, missed: 0, droppedPct: 0 });
    expect(missedFrames([5])).toEqual({ totalFrames: 0, missed: 0, droppedPct: 0 });
  });
});
