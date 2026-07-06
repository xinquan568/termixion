// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-78 (test-first): the perf driver. The ByteRouter state machine is tested directly (marker
// discipline, warmup counting, FIFO sample matching under coalesced chunks); runPerf is driven
// end-to-end with injected fakes (auto-responder PTY, virtual clock, async fake rAF) — the same
// injected-deps discipline as runSmoke. The real edge needs the packaged `--perf` run.
import { describe, expect, it } from "vitest";
import type { InvokeFn, PtyBytesHandler, SessionInfo } from "../ipc/backend";
import { BUDGETS } from "./evaluatePerf";
import {
  ByteRouter,
  READY_LINE,
  READY_MARKER,
  SCENARIO,
  SEQ_LINE,
  runPerf,
  type PerfDeps,
  type PerfMount,
} from "./runPerf";

const encoder = new TextEncoder();

describe("ByteRouter", () => {
  it("detects the contiguous marker even split across chunks", () => {
    const router = new ByteRouter();
    router.ingest(encoder.encode("__TXPERFRE"));
    expect(router.sawMarker(READY_MARKER)).toBe(false);
    router.ingest(encoder.encode("ADY__\r\n"));
    expect(router.sawMarker(READY_MARKER)).toBe(true);
  });

  it("the echoed SPLIT marker never satisfies the wait (step-5 F1 — smoke discipline)", () => {
    const router = new ByteRouter();
    // The shell echoes the command as typed: the marker still carries the quote split.
    router.ingest(encoder.encode('echo __TXPERF""READY__ && cat > /dev/null\r\n'));
    expect(router.sawMarker(READY_MARKER)).toBe(false);
  });

  it("counts warmup bytes only in the warmup phase (settle bytes are discarded)", () => {
    const router = new ByteRouter();
    router.phase = "discard";
    router.ingest(encoder.encode("\r\n")); // trailing readiness-echo noise
    expect(router.warmupBytes).toBe(0);
    router.phase = "warmup";
    router.ingest(encoder.encode("xx"));
    expect(router.warmupBytes).toBe(2);
  });

  it("closes FIFO samples per echoed byte — a coalesced 2-byte chunk pops two t0s", () => {
    const router = new ByteRouter();
    router.push(100);
    router.push(110);
    router.closeSamples(2, 130);
    expect(router.samples).toEqual([30, 20]);
  });

  it("never over-pops the FIFO on stray bytes", () => {
    const router = new ByteRouter();
    router.push(100);
    router.closeSamples(3, 120);
    expect(router.samples).toEqual([20]);
    router.closeSamples(1, 140); // nothing outstanding — inert
    expect(router.samples).toEqual([20]);
  });
});

/** A controllable fake world: virtual clock, async rAF (+8 ms frame stamp), auto-responder PTY. */
function fakeWorld(
  opts: { renderer?: "webgl" | "dom"; respondReady?: boolean; loseWebglAtSeq?: boolean } = {},
) {
  const clock = { t: 0 };
  const sent: string[] = [];
  const scrolled: number[] = [];
  const reports: Array<{ json: string; ok: boolean }> = [];
  let onBytes: PtyBytesHandler = () => {};
  const emit = (text: string) => onBytes(encoder.encode(text));

  let rendererNow: "webgl" | "dom" = opts.renderer ?? "webgl";
  const mount: PerfMount = {
    terminal: {
      open: () => {},
      loadAddon: () => {},
      // Parse completion is synchronous in the fake — the callback fires immediately.
      write: (_data: Uint8Array, callback?: () => void) => callback?.(),
      onData: () => {},
      onResize: () => {},
      dispose: () => {},
    },
    // Live read (step-8 F2): the real handle's renderer flips to "dom" on WebGL context loss.
    renderer: () => rendererNow,
    scrollPages: (n: number) => scrolled.push(n),
    dispose: () => {},
  };

  const acks: number[] = [];
  const deps: PerfDeps = {
    invoke: (() => Promise.resolve()) as InvokeFn,
    mount: () => mount,
    // trmx-103: the single-pane driver never calls mountPane; the seam returns the one shared mount.
    mountPane: () => mount,
    openPty: (handler): Promise<SessionInfo> => {
      onBytes = handler;
      return Promise.resolve({ sessionId: 1, title: "zsh" });
    },
    sendInput: (_id, data) => {
      sent.push(data);
      if (data === READY_LINE) {
        // Echo the command back first (split marker — must NOT satisfy readiness), then, when
        // enabled, the real contiguous marker output.
        setTimeout(() => {
          emit('echo __TXPERF""READY__ && cat > /dev/null\r\n');
          if (opts.respondReady !== false) emit("__TXPERFREADY__\r\n");
        }, 0);
      } else if (data === "x") {
        emit("x"); // cat echo discipline: every key comes straight back
      } else if (data === SEQ_LINE) {
        if (opts.loseWebglAtSeq) rendererNow = "dom"; // mid-run context loss
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
    sendAck: (_id, bytes) => {
      acks.push(bytes);
      return Promise.resolve();
    },
    reportDone: (json, ok) => {
      reports.push({ json, ok });
      return Promise.resolve();
    },
    raf: (cb) => {
      const enqueued = clock.t;
      setTimeout(() => cb(enqueued + 8), 0);
    },
    now: () => clock.t,
    // The fake delay yields the event loop WITHOUT advancing the clock: a virtual-time jump would
    // fabricate giant rAF gaps and fail the scroll budgets for the wrong reason. waitFor's
    // iteration cap keeps timeouts meaningful under this stationary clock.
    delay: () => new Promise((resolve) => setTimeout(resolve, 0)),
    hasFocus: () => true,
  };
  return { deps, sent, scrolled, reports, clock, acks };
}

describe("runPerf (fake world)", () => {
  it("runs the full scenario sequence and reports a passing release run", async () => {
    const world = fakeWorld();
    const report = await runPerf({ outDir: "/tmp/x", build: "release" }, world.deps);

    expect(report.pass).toBe(true);
    expect(report.renderer).toBe("webgl");
    expect(report.scenarios.typing?.count).toBe(SCENARIO.typingKeys);
    // Fake frame stamp is enqueue+8ms — every sample is 8, comfortably inside the budgets.
    expect(report.scenarios.typing?.p50).toBeLessThanOrEqual(BUDGETS.typingP50Ms);
    expect(report.scenarios.scrollSeq).toBeDefined();
    expect(report.scenarios.scrollYes).toBeDefined();
    expect(report.scenarios.scrollbackPaging).toBeDefined();
    // Scrollback paging drove the pages both ways.
    expect(world.scrolled.filter((n) => n < 0)).toHaveLength(SCENARIO.pagingPages);
    expect(world.scrolled.filter((n) => n > 0)).toHaveLength(SCENARIO.pagingPages);
    // The scenario ended cat + yes with SIGINT (isig stays on under stty -icanon).
    expect(world.sent.filter((s) => s === "\x03").length).toBeGreaterThanOrEqual(2);
    // Flow-control acks flowed for the parsed chunks (round 2b — mirrors production wiring).
    expect(world.acks.length).toBeGreaterThan(SCENARIO.typingKeys / 2);
    // The verdict reached the backend exactly once, ok=true, with the report JSON.
    expect(world.reports).toHaveLength(1);
    expect(world.reports[0].ok).toBe(true);
    expect(JSON.parse(world.reports[0].json).pass).toBe(true);
  });

  it("a DOM-fallback renderer fails outright without running scenarios", async () => {
    const world = fakeWorld({ renderer: "dom" });
    const report = await runPerf({ outDir: "/tmp/x", build: "release" }, world.deps);
    expect(report.pass).toBe(false);
    expect(report.scenarios.typing).toBeUndefined();
    expect(world.sent).toHaveLength(0); // no PTY driving at all
    expect(world.reports[0].ok).toBe(false);
    expect(world.reports[0].json).toContain("renderer");
  });

  it("a mid-run WebGL context loss is caught at evaluation time (step-8 F2)", async () => {
    const world = fakeWorld({ loseWebglAtSeq: true });
    const report = await runPerf({ outDir: "/tmp/x", build: "release" }, world.deps);
    expect(report.pass).toBe(false);
    expect(report.renderer).toBe("dom"); // the report carries the END-of-run renderer
    expect(report.reason).toContain("renderer");
    expect(world.reports[0].ok).toBe(false);
  });

  it("a hung backend invoke fails into a report instead of starving the watchdog", async () => {
    const world = fakeWorld();
    world.deps.openPty = () => new Promise(() => {}); // never resolves — the watchdog-starver
    const report = await runPerf({ outDir: "/tmp/x", build: "release" }, world.deps);
    expect(report.pass).toBe(false);
    expect(report.error).toContain("open_pty");
    expect(world.reports).toHaveLength(1); // the report still reaches the backend
  }, 15000);

  it("an echo-only world (marker never arrives) times out readiness and fails the run", async () => {
    const world = fakeWorld({ respondReady: false });
    const report = await runPerf({ outDir: "/tmp/x", build: "release" }, world.deps);
    expect(report.pass).toBe(false);
    expect(report.error).toContain("readiness");
    expect(world.reports[0].ok).toBe(false);
  }, 15000);

  it("pins the scenario parameters the watchdog derivation quotes", () => {
    expect(SCENARIO.typingKeys).toBe(1000);
    expect(SCENARIO.typingPaceMs).toBe(50);
    expect(SCENARIO.seqLines).toBe(300000);
    expect(SCENARIO.yesDurationMs).toBe(5000);
    expect(SCENARIO.pagingPages).toBe(20);
  });
});
