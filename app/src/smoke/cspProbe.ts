// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-252 (M3): the CSP gate. `tauri.conf.json` had `"csp": null`, and the two gates that looked
// like they would validate a policy cannot: Playwright drives the RAW Vite dev server
// (`playwright.config.ts` baseURL localhost:5173 + `webServer.command: "pnpm dev"`), so it never
// receives Tauri's devCsp at all; and the packaged `--smoke` path returns from `main.tsx` BEFORE
// React mounts, so it never instantiates xterm or a stylesheet. A CSP could therefore break the app
// on first launch with both of them green.
//
// This probe closes that. It runs inside the real webview under the real policy and ACTIVELY
// exercises each directive after the collector in `public/csp-probe.js` is live — rather than hoping
// to passively catch violations during startup, which cannot be made airtight because Vite prepends
// its own client in dev.
//
// Two rules hold everywhere below, both learned the hard way in review:
//   1. An ambiguous signal is never a verdict. The xterm renderer already falls back to the DOM
//      renderer on hardware without WebGL2 (TerminalView.tsx:75-81, :117-122), so "WebGL initialised"
//      cannot distinguish a CSP block from a headless runner — it is RECORDED, never asserted.
//   2. A check that cannot fail proves nothing. The canary is a deliberately blocked request whose
//      violation MUST appear; it is what proves the collector was live when `unexpected` came back
//      empty. An empty list on its own is equally consistent with a broken listener.

/** One collected violation, as `public/csp-probe.js` records it. */
export interface CspViolation {
  effectiveDirective: string;
  blockedURI: string;
  sourceFile: string;
}

/** The outcome of one active check. */
export type CheckOutcome = "pass" | "fail" | "skipped";

/**
 * The WebSocket check is three-way on purpose. Vite 8's HMR socket requires the `vite-hmr`
 * subprotocol plus a generated token and REJECTS connections lacking it, so a bare connection fails
 * even when CSP permits it. A failure is only a CSP failure when a matching `connect-src` violation
 * was actually recorded; otherwise it is environmental and must not be converted into a verdict.
 */
export type WebSocketOutcome = "pass" | "csp-fail" | "inconclusive" | "skipped";

export interface CspProbeRecord {
  probe: "csp";
  violations: { expected: CspViolation[]; unexpected: CspViolation[] };
  /** False means the probe script never ran — a different fault from a policy that let the canary through. */
  collectorPresent: boolean;
  /** Diagnostic only — never a pass/fail criterion (see rule 1 above). */
  renderer: "webgl" | "dom-fallback" | "error";
  checks: {
    styleLink: CheckOutcome;
    styleInline: CheckOutcome;
    workerSelf: CheckOutcome;
    workerBlob: CheckOutcome;
    webSocket: WebSocketOutcome;
    canary: CheckOutcome;
  };
  ok: boolean;
}

/** The origin the canary requests. `.invalid` never resolves, but CSP blocks it before DNS. */
export const CANARY_URI = "https://csp-canary.invalid/probe.png";

/** Milliseconds allowed for queued violation events to settle before a verdict is formed. */
const SETTLE_MS = 250;

export interface CspProbeDeps {
  /** The collector's array, installed by `public/csp-probe.js` before the module bundle ran. */
  violations: () => CspViolation[];
  /**
   * Whether the collector itself loaded. WITHOUT this, `canary=MISSING` is ambiguous between "the
   * policy was never applied" and "the probe script never ran" — the two have completely different
   * remedies, and reporting them identically is the exact failure this probe exists to avoid.
   * Found by running Gate B, where dev mode reported a missing canary and could not say why.
   */
  collectorPresent: () => boolean;
  /** Applies a same-origin `<link>` and resolves the resulting computed outline-width. */
  probeLinkStylesheet: () => Promise<string>;
  /** Applies an inline `<style>` and resolves the resulting computed outline-width. */
  probeInlineStyle: () => Promise<string>;
  /** Starts a same-origin worker and resolves its echo. */
  probeSelfWorker: () => Promise<string>;
  /** Starts a `blob:` worker and resolves its echo. */
  probeBlobWorker: () => Promise<string>;
  /** Opens the `vite-ping` socket; resolves true on `open`, false on error/timeout. */
  probeWebSocket: (() => Promise<boolean>) | null;
  /** Requests the canary image; resolves when it has failed (it always should). */
  probeCanary: () => Promise<void>;
  /** Which renderer the terminal would use — recorded, not asserted. */
  detectRenderer: () => "webgl" | "dom-fallback" | "error";
  /** Lets queued violation events settle. */
  settle: (ms: number) => Promise<void>;
}

const EXPECTED_STYLE = "3px";
const ECHO = "csp-probe-echo";

async function outcome(run: () => Promise<string>, want: string): Promise<CheckOutcome> {
  try {
    return (await run()) === want ? "pass" : "fail";
  } catch {
    return "fail";
  }
}

/**
 * Run every active check, then partition the collected violations. Pass requires ALL THREE of:
 * every assertion held, `unexpected` is empty, and `expected` is exactly the canary.
 */
export async function runCspProbe(deps: CspProbeDeps): Promise<CspProbeRecord> {
  const checks: CspProbeRecord["checks"] = {
    styleLink: await outcome(deps.probeLinkStylesheet, EXPECTED_STYLE),
    styleInline: await outcome(deps.probeInlineStyle, EXPECTED_STYLE),
    workerSelf: await outcome(deps.probeSelfWorker, ECHO),
    workerBlob: await outcome(deps.probeBlobWorker, ECHO),
    webSocket: "skipped",
    canary: "skipped",
  };

  try {
    await deps.probeCanary();
    checks.canary = "pass";
  } catch {
    checks.canary = "fail";
  }

  let renderer: CspProbeRecord["renderer"];
  try {
    renderer = deps.detectRenderer();
  } catch {
    renderer = "error";
  }

  // Only after the socket attempt do we read violations, and only after they settle — a violation
  // event queued by the attempt must be visible before "inconclusive" can be honestly claimed.
  let socketOpened: boolean | null = null;
  if (deps.probeWebSocket) {
    try {
      socketOpened = await deps.probeWebSocket();
    } catch {
      socketOpened = false;
    }
  }
  await deps.settle(SETTLE_MS);

  let collectorPresent: boolean;
  try {
    collectorPresent = deps.collectorPresent();
  } catch {
    collectorPresent = false;
  }
  const all = deps.violations();
  const expected = all.filter((v) => v.blockedURI === CANARY_URI);
  const unexpected = all.filter((v) => v.blockedURI !== CANARY_URI);

  if (deps.probeWebSocket) {
    if (socketOpened) {
      checks.webSocket = "pass";
    } else {
      // Attribute the failure instead of assuming it. Only a recorded connect-src violation makes
      // this a CSP verdict; anything else is the environment and stays a non-pass without blame.
      checks.webSocket = unexpected.some((v) => v.effectiveDirective.startsWith("connect-src"))
        ? "csp-fail"
        : "inconclusive";
    }
  }

  const assertionsHeld =
    checks.styleLink === "pass" &&
    checks.styleInline !== "fail" && // dev-only; "skipped" is fine under Gate A
    checks.workerSelf === "pass" &&
    checks.workerBlob === "pass" &&
    checks.canary === "pass" &&
    checks.webSocket !== "csp-fail" &&
    checks.webSocket !== "inconclusive";

  const ok =
    collectorPresent && assertionsHeld && unexpected.length === 0 && expected.length === 1;

  return {
    probe: "csp",
    violations: { expected, unexpected },
    collectorPresent,
    renderer,
    checks,
    ok,
  };
}

/** Render the record for `smoke_done`'s reason string, which is what CI actually surfaces. */
export function describeCspProbe(record: CspProbeRecord): string {
  const c = record.checks;
  const failed = Object.entries(c)
    .filter(([, v]) => v === "fail" || v === "csp-fail" || v === "inconclusive")
    .map(([k, v]) => `${k}=${v}`);
  const parts = [
    `csp=${record.ok ? "ok" : "FAIL"}`,
    `renderer=${record.renderer}`,
    `unexpected=${record.violations.unexpected.length}`,
    `collector=${record.collectorPresent ? "present" : "ABSENT"}`,
    `canary=${record.violations.expected.length === 1 ? "seen" : "MISSING"}`,
  ];
  if (failed.length > 0) parts.push(`failed[${failed.join(" ")}]`);
  for (const v of record.violations.unexpected) {
    parts.push(`violation[${v.effectiveDirective} ${v.blockedURI}]`);
  }
  return parts.join(" ");
}

/** How long an active check may take before it is treated as blocked. */
const CHECK_TIMEOUT_MS = 3000;

function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out`)), CHECK_TIMEOUT_MS),
    ),
  ]);
}

/** Applies `css` through `mount`, reads the target's computed outline-width, and cleans up. */
async function measureStyle(mount: (target: HTMLElement) => Promise<void> | void): Promise<string> {
  const target = document.createElement("div");
  target.id = "csp-probe-style-target";
  document.body.appendChild(target);
  try {
    await mount(target);
    return getComputedStyle(target).outlineWidth;
  } finally {
    target.remove();
  }
}

async function echoFrom(worker: Worker): Promise<string> {
  try {
    return await withTimeout(
      new Promise<string>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent) => resolve(String(event.data));
        worker.onerror = () => reject(new Error("worker error"));
        worker.postMessage(ECHO);
      }),
      "worker",
    );
  } finally {
    worker.terminate();
  }
}

const WORKER_SOURCE = "self.onmessage=function(e){self.postMessage(e.data)};";

/**
 * The real, DOM-backed checks. Deliberately NOT unit-tested — this is the untestable edge, and the
 * seam exists so `runCspProbe`'s decision logic can be tested headlessly without it.
 */
export function realCspProbeDeps(): CspProbeDeps {
  const isDev = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  return {
    violations: () =>
      ((window as unknown as { __cspViolations?: CspViolation[] }).__cspViolations ?? []).slice(),

    collectorPresent: () =>
      Array.isArray((window as unknown as { __cspViolations?: unknown }).__cspViolations),

    // `style-src 'self'` — the shape Vite emits into dist/index.html.
    probeLinkStylesheet: () =>
      measureStyle(
        (target) =>
          new Promise<void>((resolve, reject) => {
            const link = document.createElement("link");
            link.rel = "stylesheet";
            link.href = "/csp-probe.css";
            link.onload = () => resolve();
            link.onerror = () => reject(new Error("stylesheet blocked"));
            target.ownerDocument.head.appendChild(link);
            setTimeout(() => reject(new Error("stylesheet timed out")), CHECK_TIMEOUT_MS);
          }),
      ),

    // `style-src 'unsafe-inline'` — the shape Vite injects in dev.
    probeInlineStyle: () =>
      measureStyle((target) => {
        const style = document.createElement("style");
        style.textContent = "#csp-probe-style-target { outline-width: 3px; }";
        target.ownerDocument.head.appendChild(style);
      }),

    probeSelfWorker: () => echoFrom(new Worker("/csp-probe-worker.js")),

    // `worker-src blob:` — what xterm's WebGL path actually needs, and what `script-src 'self'`
    // alone would break. This is the directive A5 is really about.
    probeBlobWorker: () => {
      const url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
      return echoFrom(new Worker(url)).finally(() => URL.revokeObjectURL(url));
    },

    // Vite 8 rejects a handshake lacking the vite-hmr subprotocol and token, so a BARE connection
    // fails even when CSP allows it. `vite-ping` is the tokenless one; `open` is the success signal.
    probeWebSocket: isDev
      ? () =>
          new Promise<boolean>((resolve) => {
            let socket: WebSocket;
            try {
              socket = new WebSocket("ws://localhost:5173", "vite-ping");
            } catch {
              resolve(false);
              return;
            }
            const settle = (value: boolean) => {
              socket.onopen = socket.onerror = socket.onclose = null;
              try {
                socket.close();
              } catch {
                /* already closing */
              }
              resolve(value);
            };
            socket.onopen = () => settle(true);
            socket.onerror = () => settle(false);
            setTimeout(() => settle(false), CHECK_TIMEOUT_MS);
          })
      : null,

    // The canary MUST be blocked. Its violation is what proves the collector was live when the
    // unexpected list came back empty — an empty list alone is equally consistent with a dead
    // listener. `.invalid` never resolves, but CSP rejects it before DNS is consulted.
    probeCanary: () =>
      new Promise<void>((resolve) => {
        const image = new Image();
        image.onerror = () => resolve();
        image.onload = () => resolve();
        image.src = CANARY_URI;
        setTimeout(resolve, CHECK_TIMEOUT_MS);
      }),

    // Recorded, never asserted: TerminalView preflights getContext("webgl2") and falls back to the
    // DOM renderer on unsupported hardware, so this cannot distinguish a CSP block from a headless
    // runner. CSP does not govern getContext at all.
    detectRenderer: () => {
      try {
        return document.createElement("canvas").getContext("webgl2") != null
          ? "webgl"
          : "dom-fallback";
      } catch {
        return "error";
      }
    },

    settle: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
}
