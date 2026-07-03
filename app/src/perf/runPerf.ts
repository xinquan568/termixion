// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-78: the NFR-1 perf driver. In `--perf` mode the webview mounts the REAL terminal pipeline
// (the same realDeps.createTerminal + mountTerminal chokepoint TerminalView uses — xterm options,
// WebGL-first strategy, renderer report), opens a session over the PRODUCTION channel, and runs
// the measured scenarios end-to-end: typing latency through sendPtyInput → pty_write → PTY →
// shell echo → channel → term.write(chunk, cb) → requestAnimationFrame, and scroll throughput as
// rAF-gap accounting under streaming output. Deps are injected (runSmoke's discipline) so the
// orchestration is unit-tested headless; the real run needs the packaged app.
//
// Fidelity boundary (docs/design/performance-protocol.md): the React tab layer and title-hint UI
// churn are deliberately OUTSIDE this mount (the backend title poller still runs); a full-surface
// re-measure is the designated check for that class of cost.
import {
  openPty,
  realInvoke,
  sendPtyInput,
  type InvokeFn,
  type PtyBytesHandler,
  type SessionInfo,
} from "../ipc/backend";
import { mountTerminal, type RendererKind, type TerminalLike } from "../terminal/mountTerminal";
import { realDeps } from "../terminal/TerminalView";
import { BUDGETS, evaluatePerf, type PerfReportBody } from "./evaluatePerf";
import { missedFrames, summarize } from "./stats";

/** The scenario parameters — exported so tests, the Rust watchdog derivation, and the protocol
 *  doc all quote ONE source. End-to-end schedule ≈ 105 s; PERF_WATCHDOG_SECS (main.rs) is 300. */
export const SCENARIO = {
  typingKeys: 1000,
  typingPaceMs: 50,
  warmupKeys: 10,
  seqLines: 300000,
  yesDurationMs: 5000,
  pagingPages: 20,
  pagingPaceMs: 100,
  settleMs: 300,
  readinessTimeoutMs: 10000,
  drainTimeoutMs: 30000,
  scrollTimeoutMs: 60000,
} as const;

/** Output markers — matched CONTIGUOUS only. The sent lines below carry the `""` split (the
 *  smoke's discipline), so the shell's echo of the command can never satisfy a wait; only the
 *  shell's OUTPUT (which concatenates the quotes away) matches. */
export const READY_MARKER = "__TXPERFREADY__";
export const SCROLL_MARKER = "__TXPERFSCROLLDONE__";

/** Readiness line: `stty -icanon` gives per-byte delivery with echo intact (no MAX_CANON line
 *  limit under 1000+ unterminated keystrokes) while keeping ISIG so ctrl-C still ends `cat`/`yes`;
 *  `cat > /dev/null` is the pure-echo discipline (tty-layer echo, output discarded). One line, CR
 *  terminated — the smoke's single-line rule. */
export const READY_LINE = `stty -icanon && echo __TXPERF""READY__ && cat > /dev/null\r`;

/** The seq scroll load, with the completion marker on the same line. */
export const SEQ_LINE = `seq 1 ${SCENARIO.seqLines}; echo __TXPERF""SCROLLDONE__\r`;

/** Byte-stream state machine: marker detection over accumulated text (always on), plus
 *  phase-scoped counting — warmup byte counting, and the typing FIFO that pairs echoed bytes
 *  back to their send timestamps (coalesced chunks pop multiple t0s at one frame time). */
export class ByteRouter {
  phase: "collect" | "discard" | "warmup" | "typing" = "collect";
  warmupBytes = 0;
  samples: number[] = [];
  private text = "";
  private pending: number[] = [];
  private decoder = new TextDecoder();

  ingest(bytes: Uint8Array): void {
    this.text += this.decoder.decode(bytes, { stream: true });
    if (this.phase === "warmup") this.warmupBytes += bytes.length;
  }

  sawMarker(marker: string): boolean {
    return this.text.includes(marker);
  }

  resetText(): void {
    this.text = "";
  }

  /** Record a timed keystroke's send time. */
  push(t0: number): void {
    this.pending.push(t0);
  }

  get outstanding(): number {
    return this.pending.length;
  }

  /** Close up to `byteCount` samples at frame time `t1` (FIFO; never over-pops). */
  closeSamples(byteCount: number, t1: number): void {
    for (let i = 0; i < byteCount; i += 1) {
      const t0 = this.pending.shift();
      if (t0 === undefined) return;
      this.samples.push(t1 - t0);
    }
  }
}

/** What the driver needs from a mounted terminal (D2: the dedicated perf mount). */
export interface PerfMount {
  terminal: TerminalLike;
  /** LIVE renderer read (step-8 F2) — the handle flips to "dom" on WebGL context loss, and a
   *  mid-run fallback must invalidate the report, so the driver re-reads this at evaluation. */
  renderer(): RendererKind;
  /** Scrollback paging (xterm `scrollPages`, reached via a localized adapter in the real deps). */
  scrollPages(pages: number): void;
  dispose(): void;
}

/** Injected world — real Tauri/xterm edges in the app, fakes in tests. */
export interface PerfDeps {
  invoke: InvokeFn;
  mount(): PerfMount;
  openPty(
    onBytes: PtyBytesHandler,
    rows: number,
    cols: number,
    invoke: InvokeFn,
  ): Promise<SessionInfo>;
  sendInput(sessionId: number, data: string, invoke: InvokeFn): Promise<void>;
  reportDone(reportJson: string, ok: boolean, invoke: InvokeFn): Promise<void>;
  raf(callback: (t: number) => void): void;
  now(): number;
  delay(ms: number): Promise<void>;
  hasFocus(): boolean;
}

/** What perf_config resolved (camelCase over the wire from Rust). */
export interface PerfLaunchConfig {
  outDir: string;
  build: string;
}

/** The full on-disk report: the judged body plus the budgets and the verdict. */
export type PerfReport = PerfReportBody & {
  error?: string;
  budgets: typeof BUDGETS;
  pass: boolean;
  reason: string;
};

/** Continuous rAF timestamp sampling for the scroll scenarios. */
function startFrameSampling(deps: PerfDeps): { stop(): number[] } {
  const stamps: number[] = [];
  let live = true;
  const loop = (t: number) => {
    if (!live) return;
    stamps.push(t);
    deps.raf(loop);
  };
  deps.raf(loop);
  return {
    stop: () => {
      live = false;
      return stamps;
    },
  };
}

const POLL_MS = 25;

/** Timeout for the backend invokes the driver awaits (open_pty, pty_write, perf_done): a hung
 *  invoke must fail INTO the report path, not starve the Rust watchdog report-less. */
const INVOKE_TIMEOUT_MS = 15000;

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  what: string,
  deps: PerfDeps,
): Promise<void> {
  const start = deps.now();
  // Bounded by clock AND iteration count — identical under real 25 ms delays, and the iteration
  // cap keeps the bound meaningful under an injected clock that a fake delay does not advance.
  for (let i = 0; !predicate(); i += 1) {
    if (deps.now() - start > timeoutMs || i * POLL_MS > timeoutMs) {
      throw new Error(`perf: timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await deps.delay(POLL_MS);
  }
}

/** Bound `promise` by the waitFor discipline (clock + iteration cap over deps.delay) so a hung
 *  backend invoke throws into the normal error/report path instead of hanging runPerf. */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  what: string,
  deps: PerfDeps,
): Promise<T> {
  let settled = false;
  const guarded = promise.then(
    (value) => {
      settled = true;
      return value;
    },
    (err) => {
      settled = true;
      throw err;
    },
  );
  const start = deps.now();
  for (let i = 0; !settled; i += 1) {
    if (deps.now() - start > timeoutMs || i * POLL_MS > timeoutMs) {
      throw new Error(`perf: timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await deps.delay(POLL_MS);
  }
  return guarded;
}

/**
 * Drive the NFR-1 scenarios and report the verdict. Resolves with the full report once
 * `reportDone` has been called (the backend then writes the JSON and exits 0/1).
 */
export async function runPerf(config: PerfLaunchConfig, deps: PerfDeps): Promise<PerfReport> {
  const body: PerfReportBody = {
    schema: 1,
    build: config.build,
    renderer: "unmounted",
    hasFocus: deps.hasFocus(),
    scenarios: {},
  };
  let error: string | undefined;
  let mounted: PerfMount | undefined;

  // Everything after this point — INCLUDING the mount — fails into the report path: two field
  // runs died report-less to the Rust watchdog, and a report naming the hung phase is the only
  // way a failure in the field is diagnosable.
  try {
    mounted = deps.mount();
    body.renderer = mounted.renderer();
    // A DOM fallback invalidates every number — skip the scenarios entirely (the verdict below
    // fails on the renderer check with a named reason).
    if (mounted.renderer() === "webgl") {
      const router = new ByteRouter();
      const terminal = mounted.terminal; // const-captured for the closure (strict narrowing)
      const onBytes: PtyBytesHandler = (bytes) => {
        router.ingest(bytes);
        if (router.phase === "typing") {
          // The measured tail: chunk parsed (write callback) → next frame (rAF) → close samples.
          terminal.write(bytes, () => deps.raf((t1) => router.closeSamples(bytes.length, t1)));
        } else {
          terminal.write(bytes);
        }
      };
      const { sessionId } = await withTimeout(
        deps.openPty(onBytes, 24, 80, deps.invoke),
        INVOKE_TIMEOUT_MS,
        "open_pty",
        deps,
      );
      const send = (data: string) =>
        withTimeout(
          deps.sendInput(sessionId, data, deps.invoke),
          INVOKE_TIMEOUT_MS,
          "pty_write",
          deps,
        );

      // Readiness (D4): configure the tty + start the echo discipline; wait for the CONTIGUOUS
      // marker (the echoed command carries the split form and cannot match).
      await send(READY_LINE);
      await waitFor(
        () => router.sawMarker(READY_MARKER),
        SCENARIO.readinessTimeoutMs,
        "readiness",
        deps,
      );
      router.phase = "discard"; // trailing marker-echo noise must not count as warmup bytes
      await deps.delay(SCENARIO.settleMs);

      // Warmup: prove the echo loop is live at the scenario pace; samples discarded.
      router.phase = "warmup";
      for (let i = 0; i < SCENARIO.warmupKeys; i += 1) {
        void send("x").catch(() => {});
        await deps.delay(SCENARIO.typingPaceMs);
      }
      await waitFor(
        () => router.warmupBytes >= SCENARIO.warmupKeys,
        SCENARIO.drainTimeoutMs,
        "warmup echoes",
        deps,
      );

      // Typing latency: N paced keys through the production input path (D5: FIFO matching).
      router.phase = "typing";
      for (let i = 0; i < SCENARIO.typingKeys; i += 1) {
        router.push(deps.now());
        void send("x").catch(() => {});
        await deps.delay(SCENARIO.typingPaceMs);
      }
      await waitFor(
        () => router.samples.length >= SCENARIO.typingKeys,
        SCENARIO.drainTimeoutMs,
        "typing echoes to drain",
        deps,
      );
      body.scenarios.typing = summarize(router.samples);

      // End `cat` (ISIG survived -icanon), settle back to the shell.
      router.phase = "collect";
      await send("\x03");
      await deps.delay(SCENARIO.settleMs);

      // Scroll throughput: seq burst, sampled send → completion marker.
      router.resetText();
      const seqSampler = startFrameSampling(deps);
      await send(SEQ_LINE);
      await waitFor(
        () => router.sawMarker(SCROLL_MARKER),
        SCENARIO.scrollTimeoutMs,
        "seq scroll",
        deps,
      );
      body.scenarios.scrollSeq = missedFrames(seqSampler.stop());

      // Sustained stream: yes for a fixed window, then SIGINT.
      const yesSampler = startFrameSampling(deps);
      await send("yes\r");
      await deps.delay(SCENARIO.yesDurationMs);
      await send("\x03");
      body.scenarios.scrollYes = missedFrames(yesSampler.stop());
      await deps.delay(SCENARIO.settleMs);

      // Scrollback interaction: page through the filled buffer both ways.
      const pagingSampler = startFrameSampling(deps);
      for (let i = 0; i < SCENARIO.pagingPages; i += 1) {
        mounted.scrollPages(-1);
        await deps.delay(SCENARIO.pagingPaceMs);
      }
      for (let i = 0; i < SCENARIO.pagingPages; i += 1) {
        mounted.scrollPages(1);
        await deps.delay(SCENARIO.pagingPaceMs);
      }
      body.scenarios.scrollbackPaging = missedFrames(pagingSampler.stop());
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // Re-read the renderer AFTER the scenarios (step-8 F2): a WebGL context loss mid-run flips the
  // handle to "dom", and the report must carry — and be judged on — the end-of-run value.
  if (mounted) body.renderer = mounted.renderer();
  const verdict = evaluatePerf(body);
  const pass = verdict.ok && error === undefined;
  const report: PerfReport = {
    ...body,
    ...(error === undefined ? {} : { error }),
    budgets: BUDGETS,
    pass,
    reason: error ?? verdict.reason,
  };
  try {
    await withTimeout(
      deps.reportDone(JSON.stringify(report, null, 2), pass, deps.invoke),
      INVOKE_TIMEOUT_MS,
      "perf_done",
      deps,
    );
  } catch {
    // Nothing left to report to — the Rust watchdog is the final backstop.
  }
  return report;
}

/** The real, Tauri/xterm-backed deps used by the app entry (main.tsx `--perf` gate). */
export function realPerfDeps(): PerfDeps {
  return {
    invoke: realInvoke,
    mount: () => {
      const container = document.getElementById("root");
      if (!container) throw new Error("perf: #root container missing");
      const handle = mountTerminal(container, realDeps);
      // Scrollback paging is an xterm capability the narrow seam deliberately does not carry for
      // one consumer — the same localized-adapter pattern as useBackend's rows/cols read.
      const t = handle.terminal as unknown as { scrollPages?: (pages: number) => void };
      return {
        terminal: handle.terminal,
        renderer: () => handle.renderer, // live — flips on context loss (step-8 F2)
        scrollPages: (pages) => t.scrollPages?.(pages),
        dispose: () => handle.dispose(),
      };
    },
    openPty: (onBytes, rows, cols, invoke) => openPty(onBytes, rows, cols, undefined, invoke),
    sendInput: sendPtyInput,
    reportDone: (report, ok, invoke) => invoke("perf_done", { report, success: ok }).then(() => {}),
    raf: (callback) => requestAnimationFrame(callback),
    now: () => performance.now(),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    hasFocus: () => document.hasFocus(),
  };
}
