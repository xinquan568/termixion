// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-78: the NFR-1 budget verdict (docs/design/performance-protocol.md §budgets). Pure: takes
// the assembled report body, returns { ok, reason } — the same evaluate/run split as the smoke
// (evaluateSmoke.ts). The verdict drives perf_done's exit code, so `scripts/perf.sh` is a gate.
// A non-webgl renderer fails OUTRIGHT: the issue pins that a silent DOM fallback invalidates
// every number, so that is an invalid measurement, not a budget miss.
import type { FrameSummary, LatencySummary } from "./stats";

/** The issue's budget table — floors the gate enforces, quoted by the protocol doc. */
export const BUDGETS = {
  typingP50Ms: 16,
  typingP95Ms: 33,
  droppedPct: 5,
} as const;

/** The report body evaluatePerf judges (the full report adds `budgets` + `pass` around it). */
export interface PerfReportBody {
  schema: 1;
  build: string;
  renderer: string;
  hasFocus?: boolean;
  scenarios: {
    typing?: LatencySummary;
    scrollSeq?: FrameSummary;
    scrollYes?: FrameSummary;
    scrollbackPaging?: FrameSummary;
  };
}

export interface PerfVerdict {
  ok: boolean;
  reason: string;
}

const SCROLL_SCENARIOS = ["scrollSeq", "scrollYes", "scrollbackPaging"] as const;

/** Judge a report against the NFR-1 budgets. Reasons name the failing metric and its value. */
export function evaluatePerf(report: PerfReportBody): PerfVerdict {
  if (report.renderer !== "webgl") {
    return {
      ok: false,
      reason: `invalid measurement: renderer is '${report.renderer}', not webgl`,
    };
  }
  // The protocol's frontmost/visible requirement, ENFORCED (step-8 F1): an unfocused window gets
  // rAF-throttled and fabricates both latency tails and dropped frames — those numbers must never
  // pass, even when they happen to land inside the budgets.
  if (report.hasFocus !== true) {
    return {
      ok: false,
      reason: `invalid measurement: window did not have focus (hasFocus=${String(report.hasFocus)})`,
    };
  }
  const { typing } = report.scenarios;
  if (!typing) return { ok: false, reason: "incomplete run: typing scenario missing" };
  if (typing.p50 > BUDGETS.typingP50Ms) {
    return { ok: false, reason: `typing p50 ${typing.p50}ms over the ${BUDGETS.typingP50Ms}ms budget` };
  }
  if (typing.p95 > BUDGETS.typingP95Ms) {
    return { ok: false, reason: `typing p95 ${typing.p95}ms over the ${BUDGETS.typingP95Ms}ms budget` };
  }
  let worstScroll = 0;
  for (const name of SCROLL_SCENARIOS) {
    const frames = report.scenarios[name];
    if (!frames) return { ok: false, reason: `incomplete run: ${name} scenario missing` };
    if (frames.droppedPct >= BUDGETS.droppedPct) {
      return {
        ok: false,
        reason: `${name} dropped ${round1(frames.droppedPct)}% of frames (budget < ${BUDGETS.droppedPct}%)`,
      };
    }
    worstScroll = Math.max(worstScroll, frames.droppedPct);
  }
  return {
    ok: true,
    reason: `all budgets met (typing p50 ${typing.p50}ms p95 ${typing.p95}ms; worst scroll ${round1(worstScroll)}%)`,
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
