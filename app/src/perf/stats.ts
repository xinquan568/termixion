// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-78: pure statistics for the NFR-1 perf harness (docs/design/performance-protocol.md).
// Percentiles are NEAREST-RANK over a sorted sample set (deterministic, no interpolation — the
// budgets are coarse enough that interpolation only adds ambiguity). Missed frames follow the
// issue's rule: an inter-rAF gap greater than GAP_FACTOR × FRAME_BUDGET_MS counts the frames that
// never rendered inside that gap. Pure module — no DOM/xterm imports.

/** One frame's budget at 60 Hz, in ms. */
export const FRAME_BUDGET_MS = 1000 / 60;

/** A gap must exceed this multiple of the frame budget to count as dropped (issue: 1.5×16.7ms). */
export const GAP_FACTOR = 1.5;

/** Nearest-rank percentile over a SORTED ascending array. Throws on empty input. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error("perf stats: percentile of an empty sample set");
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

/** The typing-scenario summary shape the report carries. */
export interface LatencySummary {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Summarize latency samples (any order) into the report's percentile row. */
export function summarize(samples: readonly number[]): LatencySummary {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
  };
}

/** The scroll-scenario frame accounting the report carries. */
export interface FrameSummary {
  totalFrames: number;
  missed: number;
  droppedPct: number;
}

/**
 * Count dropped frames over a requestAnimationFrame timestamp stream. Each interval between
 * consecutive callbacks is one rendered frame; a gap wider than GAP_FACTOR × budget additionally
 * contains `round(gap / budget) - 1` frames that never rendered. `totalFrames` is rendered +
 * missed — the denominator the < 5 % budget divides by. 0–1 timestamps → zero frames (no NaN).
 */
export function missedFrames(
  timestamps: readonly number[],
  budgetMs: number = FRAME_BUDGET_MS,
  factor: number = GAP_FACTOR,
): FrameSummary {
  if (timestamps.length < 2) return { totalFrames: 0, missed: 0, droppedPct: 0 };
  let rendered = 0;
  let missed = 0;
  for (let i = 1; i < timestamps.length; i += 1) {
    const gap = timestamps[i] - timestamps[i - 1];
    rendered += 1;
    if (gap > factor * budgetMs) {
      missed += Math.max(0, Math.round(gap / budgetMs) - 1);
    }
  }
  const totalFrames = rendered + missed;
  return {
    totalFrames,
    missed,
    droppedPct: totalFrames === 0 ? 0 : (missed / totalFrames) * 100,
  };
}
