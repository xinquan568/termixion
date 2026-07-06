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
  sendPtyAck,
  sendPtyInput,
  type InvokeFn,
  type PtyBytesHandler,
  type SessionInfo,
} from "../ipc/backend";
import { mountTerminal, type RendererKind, type TerminalLike } from "../terminal/mountTerminal";
import { realDeps } from "../terminal/TerminalView";
import { BUDGETS, evaluatePerf, type PerfReportBody } from "./evaluatePerf";
import { missedFrames, summarize, type LatencySummary } from "./stats";

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

/** The v0.0.9 Beta-hardening multi-pane LOAD scenario (trmx-103). Six panes are mounted in ONE
 *  webview; four (`streamPaneIndices`) run a `yes`/`seq` flood as background load, typing latency
 *  is measured in a fifth (`typingPaneIndex`) busy-adjacent, and the three scroll scenarios run in
 *  a sixth (`scrollPaneIndex`). Multi-pane is a LOAD condition, NOT a new report schema: the driver
 *  emits the SAME four scenario keys so `evaluatePerf` + `BUDGETS` judge it UNCHANGED. Indices are
 *  explicit and zero-based; the timing knobs are the single-pane values (docs quote ONE source). */
export const SCENARIO_MULTIPANE = {
  panes: 6,
  streamPaneIndices: [0, 1, 2, 3],
  typingPaneIndex: 4,
  scrollPaneIndex: 5,
  typingKeys: SCENARIO.typingKeys,
  typingPaceMs: SCENARIO.typingPaceMs,
  warmupKeys: SCENARIO.warmupKeys,
  settleMs: SCENARIO.settleMs,
  readinessTimeoutMs: SCENARIO.readinessTimeoutMs,
  drainTimeoutMs: SCENARIO.drainTimeoutMs,
  scrollTimeoutMs: SCENARIO.scrollTimeoutMs,
  yesDurationMs: SCENARIO.yesDurationMs,
  pagingPages: SCENARIO.pagingPages,
  pagingPaceMs: SCENARIO.pagingPaceMs,
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
  /** Mount the terminal pipeline into a per-index grid slot (trmx-103) — the multi-pane seam. The
   *  single-pane driver ignores it; `runPerfMultipane` mounts `SCENARIO_MULTIPANE.panes` of them so
   *  N xterms coexist in one webview. Index 0 reuses the `#root` mount; the rest get a child slot. */
  mountPane(index: number): PerfMount;
  openPty(
    onBytes: PtyBytesHandler,
    rows: number,
    cols: number,
    invoke: InvokeFn,
  ): Promise<SessionInfo>;
  sendInput(sessionId: number, data: string, invoke: InvokeFn): Promise<void>;
  /** Flow-control ack on parse completion (trmx-78 round 2b) — mirrors the production wiring. */
  sendAck(sessionId: number, bytes: number, invoke: InvokeFn): Promise<void>;
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
  /** Which scenario to drive (trmx-103): `"multipane"` selects `runPerfMultipane`; anything else
   *  (incl. absent, for backward-compatible reports) is the default single-pane `runPerf`. */
  scenario?: string;
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

/** The timing knobs `measureTyping`/`measureScroll` read — the shared subset SCENARIO and
 *  SCENARIO_MULTIPANE both carry, so ONE measurement body drives single-pane and multi-pane. */
type ScenarioKnobs = Pick<
  typeof SCENARIO,
  | "typingKeys"
  | "typingPaceMs"
  | "warmupKeys"
  | "settleMs"
  | "readinessTimeoutMs"
  | "drainTimeoutMs"
  | "scrollTimeoutMs"
  | "yesDurationMs"
  | "pagingPages"
  | "pagingPaceMs"
>;

/** A PTY wired to a mount with production flow-control acks + the typing FIFO (trmx-78 round 2b):
 *  every chunk is acked on PARSE COMPLETION so the backend's credit window throttles floods by the
 *  real parse rate, and the "typing" phase closes latency samples one rAF after the parse. */
interface PerfChannel {
  router: ByteRouter;
  send(data: string): Promise<void>;
}

async function openPerfPty(mount: PerfMount, deps: PerfDeps): Promise<PerfChannel> {
  const router = new ByteRouter();
  const terminal = mount.terminal; // const-captured for the closure (strict narrowing)
  // The id lands after openPty resolves; the readiness preamble rides the initial credit window.
  let ackSessionId = 0;
  const ack = (bytes: number) => {
    if (ackSessionId > 0) void deps.sendAck(ackSessionId, bytes, deps.invoke).catch(() => {});
  };
  const onBytes: PtyBytesHandler = (bytes) => {
    router.ingest(bytes);
    if (router.phase === "typing") {
      // The measured tail: chunk parsed (write callback) → next frame (rAF) → close samples.
      terminal.write(bytes, () => {
        ack(bytes.length);
        deps.raf((t1) => router.closeSamples(bytes.length, t1));
      });
    } else {
      terminal.write(bytes, () => ack(bytes.length));
    }
  };
  const { sessionId } = await withTimeout(
    deps.openPty(onBytes, 24, 80, deps.invoke),
    INVOKE_TIMEOUT_MS,
    "open_pty",
    deps,
  );
  ackSessionId = sessionId;
  const send = (data: string) =>
    withTimeout(deps.sendInput(sessionId, data, deps.invoke), INVOKE_TIMEOUT_MS, "pty_write", deps);
  return { router, send };
}

/** Measure typing latency on a freshly opened channel: readiness → warmup → N paced keys, matched
 *  back to their send times by the ByteRouter FIFO (D5). Leaves `cat` running — the caller ends it. */
async function measureTyping(
  channel: PerfChannel,
  deps: PerfDeps,
  s: ScenarioKnobs,
): Promise<LatencySummary> {
  const { router, send } = channel;
  // Readiness (D4): configure the tty + start the echo discipline; wait for the CONTIGUOUS marker
  // (the echoed command carries the split form and cannot match).
  await send(READY_LINE);
  await waitFor(() => router.sawMarker(READY_MARKER), s.readinessTimeoutMs, "readiness", deps);
  router.phase = "discard"; // trailing marker-echo noise must not count as warmup bytes
  await deps.delay(s.settleMs);

  // Warmup: prove the echo loop is live at the scenario pace; samples discarded.
  router.phase = "warmup";
  for (let i = 0; i < s.warmupKeys; i += 1) {
    void send("x").catch(() => {});
    await deps.delay(s.typingPaceMs);
  }
  await waitFor(() => router.warmupBytes >= s.warmupKeys, s.drainTimeoutMs, "warmup echoes", deps);

  // Typing latency: N paced keys through the production input path.
  router.phase = "typing";
  for (let i = 0; i < s.typingKeys; i += 1) {
    router.push(deps.now());
    void send("x").catch(() => {});
    await deps.delay(s.typingPaceMs);
  }
  await waitFor(
    () => router.samples.length >= s.typingKeys,
    s.drainTimeoutMs,
    "typing echoes to drain",
    deps,
  );
  return summarize(router.samples);
}

/** Measure the three scroll scenarios on a channel + its mount: seq burst, sustained `yes`, and
 *  scrollback paging both ways — rAF-gap accounting under each. The shell must be at a prompt. */
async function measureScroll(
  mount: PerfMount,
  channel: PerfChannel,
  deps: PerfDeps,
  s: ScenarioKnobs,
): Promise<Pick<PerfReportBody["scenarios"], "scrollSeq" | "scrollYes" | "scrollbackPaging">> {
  const { router, send } = channel;
  // Scroll throughput: seq burst, sampled send → completion marker.
  router.resetText();
  const seqSampler = startFrameSampling(deps);
  await send(SEQ_LINE);
  await waitFor(() => router.sawMarker(SCROLL_MARKER), s.scrollTimeoutMs, "seq scroll", deps);
  const scrollSeq = missedFrames(seqSampler.stop());

  // Sustained stream: yes for a fixed window, then SIGINT.
  const yesSampler = startFrameSampling(deps);
  await send("yes\r");
  await deps.delay(s.yesDurationMs);
  await send("\x03");
  const scrollYes = missedFrames(yesSampler.stop());
  await deps.delay(s.settleMs);

  // Scrollback interaction: page through the filled buffer both ways.
  const pagingSampler = startFrameSampling(deps);
  for (let i = 0; i < s.pagingPages; i += 1) {
    mount.scrollPages(-1);
    await deps.delay(s.pagingPaceMs);
  }
  for (let i = 0; i < s.pagingPages; i += 1) {
    mount.scrollPages(1);
    await deps.delay(s.pagingPaceMs);
  }
  return { scrollSeq, scrollYes, scrollbackPaging: missedFrames(pagingSampler.stop()) };
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
      const channel = await openPerfPty(mounted, deps);
      body.scenarios.typing = await measureTyping(channel, deps, SCENARIO);

      // End `cat` (ISIG survived -icanon), settle back to the shell.
      channel.router.phase = "collect";
      await channel.send("\x03");
      await deps.delay(SCENARIO.settleMs);

      const scroll = await measureScroll(mounted, channel, deps, SCENARIO);
      body.scenarios.scrollSeq = scroll.scrollSeq;
      body.scenarios.scrollYes = scroll.scrollYes;
      body.scenarios.scrollbackPaging = scroll.scrollbackPaging;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // Re-read the renderer AFTER the scenarios (step-8 F2): a WebGL context loss mid-run flips the
  // handle to "dom", and the report must carry — and be judged on — the end-of-run value.
  if (mounted) body.renderer = mounted.renderer();
  return finalizeReport(body, error, deps);
}

/** Judge the assembled body against the UNCHANGED budgets, wrap it in the on-disk report, and hand
 *  it to `reportDone` (the backend writes JSON + exits 0/1). Shared by the single- and multi-pane
 *  drivers so multi-pane is a LOAD condition, not a second report schema. */
async function finalizeReport(
  body: PerfReportBody,
  error: string | undefined,
  deps: PerfDeps,
): Promise<PerfReport> {
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

/**
 * Drive the NFR-1 scenarios under MULTI-PANE LOAD (trmx-103, v0.0.9 Beta hardening). Six panes are
 * mounted in one webview; four (`streamPaneIndices`) run a `yes`/`seq` flood as background load
 * (rendered — the busy neighborhood — but feeding no sampler), typing latency is measured in a
 * fifth (`typingPaneIndex`) busy-adjacent, and the three scroll scenarios in a sixth
 * (`scrollPaneIndex`). The report carries the SAME four scenario keys as `runPerf`, so
 * `evaluatePerf` + `BUDGETS` judge it UNCHANGED. Resolves once `reportDone` has been called.
 */
export async function runPerfMultipane(
  config: PerfLaunchConfig,
  deps: PerfDeps,
): Promise<PerfReport> {
  const s = SCENARIO_MULTIPANE;
  const body: PerfReportBody = {
    schema: 1,
    build: config.build,
    renderer: "unmounted",
    hasFocus: deps.hasFocus(),
    scenarios: {},
  };
  let error: string | undefined;
  const mounts: PerfMount[] = [];

  try {
    for (let i = 0; i < s.panes; i += 1) mounts.push(deps.mountPane(i));
    const typingMount = mounts[s.typingPaneIndex];
    const scrollMount = mounts[s.scrollPaneIndex];
    // The report renderer is read from the pane under measurement (the typing pane).
    body.renderer = typingMount.renderer();
    // A DOM fallback invalidates every number — skip the scenarios entirely (same rule as runPerf).
    if (typingMount.renderer() === "webgl") {
      // Background LOAD: a PTY per streaming pane firing a `yes`/`seq` mix. The bytes render into
      // their pane (real GPU/IPC load) but feed no sampler — a discard sink, not a measured
      // scenario. Keep the stop closures to SIGINT the floods once the measurements are done.
      const stopStreamers: Array<() => Promise<void>> = [];
      for (const idx of s.streamPaneIndices) {
        const streamer = await openPerfPty(mounts[idx], deps);
        const floodCmd = idx % 2 === 0 ? SEQ_LINE : "yes\r"; // seq/yes mix across the four
        await streamer.send(floodCmd);
        stopStreamers.push(() => streamer.send("\x03").then(() => {}));
      }

      // Typing latency, measured busy-adjacent in its own pane.
      const typingChannel = await openPerfPty(typingMount, deps);
      body.scenarios.typing = await measureTyping(typingChannel, deps, s);
      typingChannel.router.phase = "collect";
      await typingChannel.send("\x03"); // end the typing pane's `cat`
      await deps.delay(s.settleMs);

      // Scroll throughput, measured in the sixth pane under the same background load.
      const scrollChannel = await openPerfPty(scrollMount, deps);
      const scroll = await measureScroll(scrollMount, scrollChannel, deps, s);
      body.scenarios.scrollSeq = scroll.scrollSeq;
      body.scenarios.scrollYes = scroll.scrollYes;
      body.scenarios.scrollbackPaging = scroll.scrollbackPaging;

      // Quiesce the floods (best-effort — a stuck streamer must not fail an otherwise-good run).
      for (const stop of stopStreamers) await stop().catch(() => {});
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  // Re-read the measured pane's renderer AFTER the scenarios (step-8 F2 — context loss flips it).
  const typingMount = mounts[s.typingPaneIndex];
  if (typingMount) body.renderer = typingMount.renderer();
  return finalizeReport(body, error, deps);
}

/** Mount the real xterm/WebGL pipeline into `container` (the production chokepoint), wrapped in the
 *  PerfMount seam. Shared by `mount()` and `mountPane()` so every pane is a REAL terminal. */
function mountPerfInto(container: HTMLElement): PerfMount {
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
}

/** The `#root` mount container, or throw into the report path if it is missing. */
function rootContainer(): HTMLElement {
  const container = document.getElementById("root");
  if (!container) throw new Error("perf: #root container missing");
  return container;
}

/** The real, Tauri/xterm-backed deps used by the app entry (main.tsx `--perf` gate). */
export function realPerfDeps(): PerfDeps {
  return {
    invoke: realInvoke,
    mount: () => mountPerfInto(rootContainer()),
    // trmx-103: pane 0 reuses `#root`; each further pane gets a fresh child slot so N real xterms
    // coexist in one webview — the multi-pane grid the load scenario measures under.
    mountPane: (index) => {
      const root = rootContainer();
      if (index === 0) return mountPerfInto(root);
      const slot = document.createElement("div");
      slot.dataset.perfPane = String(index);
      root.appendChild(slot);
      return mountPerfInto(slot);
    },
    openPty: (onBytes, rows, cols, invoke) => openPty(onBytes, rows, cols, undefined, invoke),
    sendInput: sendPtyInput,
    sendAck: sendPtyAck,
    reportDone: (report, ok, invoke) => invoke("perf_done", { report, success: ok }).then(() => {}),
    raf: (callback) => requestAnimationFrame(callback),
    now: () => performance.now(),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    hasFocus: () => document.hasFocus(),
  };
}
