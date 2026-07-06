// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-103 (test-first): the multi-pane NFR-1 load scenario. `runPerfMultipane` mounts six panes,
// floods four of them (the busy neighborhood), then measures typing latency in a fifth pane and
// scroll throughput in a sixth — the SAME four report keys the single-pane driver produces, so the
// UNCHANGED `evaluatePerf` + `BUDGETS` judge it. This spec pins the SHAPE (exact pane indices,
// the four scenario keys, the reused verdict) with a multi-session fake — one PTY handler +
// sessionId per pane — not real latency numbers (those are operator-run on the reference Mac).
import { describe, expect, it } from "vitest";
import type { InvokeFn, PtyBytesHandler, SessionInfo } from "../ipc/backend";
import { BUDGETS, evaluatePerf } from "./evaluatePerf";
import {
  READY_LINE,
  SCENARIO_MULTIPANE,
  SEQ_LINE,
  runPerfMultipane,
  type PerfDeps,
  type PerfMount,
} from "./runPerf";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A multi-session fake world: each `mountPane(i)` gets its own recording terminal, and each
 *  `openPty` gets its own handler keyed on a distinct sessionId so N panes drive independently. */
function multipaneWorld(opts: { renderer?: "webgl" | "dom" } = {}) {
  const rendererKind = opts.renderer ?? "webgl";
  const mountedIndices: number[] = [];
  const writesByPane: Record<number, string[]> = {};
  const scrollsByPane: Record<number, number[]> = {};
  const reports: Array<{ json: string; ok: boolean }> = [];
  const clock = { t: 0 };

  // Per-session PTY handlers — the multi-session part: sendInput routes to the right pane's onBytes.
  const handlers = new Map<number, PtyBytesHandler>();
  let nextSession = 0;

  const mkMount = (index: number): PerfMount => {
    writesByPane[index] ??= [];
    scrollsByPane[index] ??= [];
    return {
      terminal: {
        open: () => {},
        loadAddon: () => {},
        // The driver's onBytes closure for pane `index` writes here, so a pane's role is
        // observable from what its own terminal received (echoes vs flood output).
        write: (data: Uint8Array, callback?: () => void) => {
          writesByPane[index].push(decoder.decode(data));
          callback?.();
        },
        onData: () => {},
        onResize: () => {},
        dispose: () => {},
      },
      renderer: () => rendererKind,
      scrollPages: (n: number) => scrollsByPane[index].push(n),
      dispose: () => {},
    };
  };

  const deps: PerfDeps = {
    invoke: (() => Promise.resolve()) as InvokeFn,
    mount: () => mkMount(0), // the single-pane seam is unused by the multipane driver
    mountPane: (index) => {
      mountedIndices.push(index);
      return mkMount(index);
    },
    openPty: (handler): Promise<SessionInfo> => {
      nextSession += 1;
      const id = nextSession;
      handlers.set(id, handler);
      return Promise.resolve({ sessionId: id, title: "zsh" });
    },
    sendInput: (id, data) => {
      const handler = handlers.get(id);
      const emit = (text: string) => handler?.(encoder.encode(text));
      if (data === READY_LINE) {
        // Split-marker echo first (must NOT satisfy readiness), then the contiguous marker.
        setTimeout(() => {
          emit('echo __TXPERF""READY__ && cat > /dev/null\r\n');
          emit("__TXPERFREADY__\r\n");
        }, 0);
      } else if (data === "x") {
        emit("x"); // cat echo discipline — every key comes straight back
      } else if (data === SEQ_LINE) {
        setTimeout(() => {
          emit("1\r\n2\r\n3\r\n");
          emit(`${"4".repeat(80)}\r\n`);
          emit("__TXPERFSCROLLDONE__\r\n");
        }, 0);
      } else if (data === "yes\r") {
        setTimeout(() => emit("y\r\n".repeat(50)), 0);
      }
      return Promise.resolve();
    },
    sendAck: () => Promise.resolve(),
    reportDone: (json, ok) => {
      reports.push({ json, ok });
      return Promise.resolve();
    },
    raf: (cb) => {
      const enqueued = clock.t;
      setTimeout(() => cb(enqueued + 8), 0);
    },
    now: () => clock.t,
    delay: () => new Promise((resolve) => setTimeout(resolve, 0)),
    hasFocus: () => true,
  };
  return { deps, mountedIndices, writesByPane, scrollsByPane, reports };
}

/** Pane indices whose recorded terminal writes satisfy `pred`, ascending. */
function indicesWith(writesByPane: Record<number, string[]>, pred: (w: string[]) => boolean): number[] {
  return Object.keys(writesByPane)
    .map(Number)
    .filter((i) => pred(writesByPane[i]))
    .sort((a, b) => a - b);
}

describe("runPerfMultipane (multi-session fake)", () => {
  it("mounts 6 panes, streams [0,1,2,3], types on 4, scrolls on 5, judged by the unchanged budgets", async () => {
    const world = multipaneWorld();
    const report = await runPerfMultipane({ outDir: "/tmp/x", build: "release" }, world.deps);

    // Exactly six panes, indices 0..5 — the explicit grid the scenario pins.
    expect([...world.mountedIndices].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(world.mountedIndices).toHaveLength(6);
    expect(SCENARIO_MULTIPANE.panes).toBe(6);

    // Typing measured on pane index 4 — it (and only it) received the per-key "x" echoes.
    expect(indicesWith(world.writesByPane, (w) => w.includes("x"))).toEqual([4]);
    expect(SCENARIO_MULTIPANE.typingPaneIndex).toBe(4);

    // Scroll measured on pane index 5 — it (and only it) was paged, 20 up + 20 down.
    const scrolledPanes = Object.keys(world.scrollsByPane)
      .map(Number)
      .filter((i) => world.scrollsByPane[i].length > 0)
      .sort((a, b) => a - b);
    expect(scrolledPanes).toEqual([5]);
    expect(world.scrollsByPane[5].filter((n) => n < 0)).toHaveLength(SCENARIO_MULTIPANE.pagingPages);
    expect(world.scrollsByPane[5].filter((n) => n > 0)).toHaveLength(SCENARIO_MULTIPANE.pagingPages);
    expect(SCENARIO_MULTIPANE.scrollPaneIndex).toBe(5);

    // Streamers ran the flood on exactly panes [0,1,2,3] — busy neighbors, neither typed nor scrolled.
    expect(SCENARIO_MULTIPANE.streamPaneIndices).toEqual([0, 1, 2, 3]);
    for (const i of SCENARIO_MULTIPANE.streamPaneIndices) {
      expect(world.writesByPane[i].length).toBeGreaterThan(0);
      expect(world.writesByPane[i].includes("x")).toBe(false);
      expect(world.scrollsByPane[i]).toHaveLength(0);
    }

    // The report carries the SAME four scenario keys and passes the UNCHANGED budgets.
    expect(report.renderer).toBe("webgl");
    expect(report.scenarios.typing).toBeDefined();
    expect(report.scenarios.scrollSeq).toBeDefined();
    expect(report.scenarios.scrollYes).toBeDefined();
    expect(report.scenarios.scrollbackPaging).toBeDefined();
    expect(report.budgets).toEqual(BUDGETS);
    expect(evaluatePerf(report).ok).toBe(true);
    expect(report.pass).toBe(true);
    expect(world.reports).toHaveLength(1);
    expect(world.reports[0].ok).toBe(true);
  });

  it("a DOM renderer fails outright with the same invalid-measurement reason (budgets unchanged)", async () => {
    const world = multipaneWorld({ renderer: "dom" });
    const report = await runPerfMultipane({ outDir: "/tmp/x", build: "release" }, world.deps);

    expect(report.pass).toBe(false);
    expect(report.renderer).toBe("dom");
    expect(report.reason).toContain("renderer");
    // Skipped every scenario — no pane was typed or scrolled.
    expect(report.scenarios.typing).toBeUndefined();
    expect(indicesWith(world.writesByPane, (w) => w.includes("x"))).toEqual([]);
    expect(report.budgets).toEqual(BUDGETS);
    expect(world.reports[0].ok).toBe(false);
  });
});
