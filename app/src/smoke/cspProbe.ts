// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-252 (M3): the CSP gate. `tauri.conf.json` had `"csp": null`, and neither existing gate could
// tell whether a policy breaks the app: Playwright drives the RAW Vite dev server
// (`playwright.config.ts` baseURL localhost:5173 + `webServer: "pnpm dev"`), so it never receives a
// Tauri CSP; and the packaged `--smoke` returns from `main.tsx` BEFORE React mounts, so it never
// instantiated a stylesheet or a worker. A CSP could therefore break the app on first launch with
// both of them green.
//
// This probe runs inside the real webview under the real policy and ACTIVELY exercises each
// directive after the collector in `public/csp-probe.js` is live — rather than hoping to passively
// catch startup violations, which cannot be made airtight because Vite prepends its own client.
//
// THREE RULES, each of which exists because breaking it produced a real defect in review:
//
//  1. An ambiguous signal is never a verdict. The xterm renderer falls back to the DOM renderer on
//     hardware without WebGL2 (TerminalView.tsx:75-81, :117-122), so "WebGL initialised" cannot
//     separate a CSP block from a headless runner — it is RECORDED, never asserted. Likewise
//     `canary=MISSING` is reported beside `collector=present|ABSENT`, because "the policy let it
//     through" and "the probe never loaded" have opposite remedies (Gate B hit exactly this).
//
//  2. A check that cannot fail proves nothing. Every relaxation this policy grants is paired with a
//     NEGATIVE probe whose violation must appear. An empty violation list on its own is equally
//     consistent with a dead listener.
//
//  3. A positive check must be able to fail INDEPENDENTLY. The first version used one element id
//     and one sentinel value for both style checks and never removed the injected `<link>`, so the
//     inline check passed off the still-mounted external stylesheet even when inline CSS was
//     blocked — a tautology. Each check now owns a distinct id, a distinct sentinel, and removes
//     what it injected.
//
// WHAT THIS GATE DOES NOT DO: it verifies the policy is ENFORCED and COMPATIBLE, not that the
// policy is STRONG. A wide-open `script-src *` would still satisfy every runtime check here. The
// strength half is pinned separately by `cspPolicy.test.ts`, which asserts the directives in
// `tauri.conf.json` by source.

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
 * even when CSP permits it. A failure is a CSP failure only when a `connect-src` violation whose
 * blocked URI is THIS socket was recorded; otherwise it is environmental and must not become a
 * verdict.
 */
export type WebSocketOutcome = "pass" | "csp-fail" | "inconclusive" | "skipped";

export interface CspProbeRecord {
  probe: "csp";
  violations: { expected: CspViolation[]; unexpected: CspViolation[] };
  /** False means the probe script never ran — a different fault from a policy that let a canary through. */
  collectorPresent: boolean;
  /** Which negative canaries were actually observed. Every one must fire. */
  canaries: { image: boolean; blobWorker: boolean };
  /** Diagnostic only — never a pass/fail criterion (rule 1). */
  renderer: "webgl" | "dom-fallback" | "error";
  checks: {
    styleLink: CheckOutcome;
    styleInline: CheckOutcome;
    workerSelf: CheckOutcome;
    webSocket: WebSocketOutcome;
  };
  ok: boolean;
}

/** The origin the image canary requests. `.invalid` never resolves, but CSP blocks it before DNS. */
export const CANARY_URI = "https://csp-canary.invalid/probe.png";

/** The socket the dev-mode `connect-src` check attempts. */
export const WS_URI = "ws://localhost:5173";

/** Milliseconds allowed for queued violation events to settle before a verdict is formed. */
const SETTLE_MS = 250;

/**
 * Distinct sentinels: rule 3 — neither style check may be satisfied by the other's effect.
 * Measured on `padding-top`, deliberately: `outline-width` computes to 0 when `outline-style` is
 * `none`, so the first version silently depended on a property nobody set and failed on CI with
 * `unexpected=0` (no violation — the value simply was not there).
 */
const LINK_SENTINEL = "3px";
const INLINE_SENTINEL = "7px";
const ECHO = "csp-probe-echo";

export interface CspProbeDeps {
  /** The collector's array, installed by `public/csp-probe.js` before the module bundle ran. */
  violations: () => CspViolation[];
  /** Whether the collector itself loaded (see rule 1). */
  collectorPresent: () => boolean;
  /** Applies a same-origin `<link>`, resolves the computed padding-top, removes what it injected. */
  probeLinkStylesheet: () => Promise<string>;
  /** Applies an inline `<style>`, resolves the computed padding-top, removes what it injected. */
  probeInlineStyle: () => Promise<string>;
  /** Starts a same-origin worker and resolves its echo. */
  probeSelfWorker: () => Promise<string>;
  /**
   * Attempts a `blob:` worker, which the policy MUST refuse. Resolves when the attempt is over,
   * however it ended — the verdict comes from the violation list, not from this promise.
   */
  probeBlobWorker: () => Promise<void>;
  /** Opens the `vite-ping` socket; resolves true on `open`, false on error/timeout. Null outside dev. */
  probeWebSocket: (() => Promise<boolean>) | null;
  /** Requests the canary image, which the policy MUST refuse. */
  probeCanary: () => Promise<void>;
  /** Which renderer the terminal would use — recorded, not asserted. */
  detectRenderer: () => "webgl" | "dom-fallback" | "error";
  /** Lets queued violation events settle. */
  settle: (ms: number) => Promise<void>;
}

async function outcome(run: () => Promise<string>, want: string): Promise<CheckOutcome> {
  try {
    return (await run()) === want ? "pass" : "fail";
  } catch {
    return "fail";
  }
}

const normalizeUri = (uri: string) => uri.replace(/\/+$/, "");

const isBlobWorkerViolation = (v: CspViolation) =>
  v.effectiveDirective.startsWith("worker-src") ||
  (v.effectiveDirective.startsWith("script-src") && v.blockedURI.startsWith("blob"));

const isImageCanary = (v: CspViolation) => v.blockedURI === CANARY_URI;

/**
 * Run every active check, then partition the collected violations into the canaries we DEMANDED and
 * everything else. Pass requires all of: the collector loaded, every positive assertion held, BOTH
 * canaries fired, and nothing unexpected was blocked.
 */
export async function runCspProbe(deps: CspProbeDeps): Promise<CspProbeRecord> {
  const checks: CspProbeRecord["checks"] = {
    styleLink: await outcome(deps.probeLinkStylesheet, LINK_SENTINEL),
    styleInline: await outcome(deps.probeInlineStyle, INLINE_SENTINEL),
    workerSelf: await outcome(deps.probeSelfWorker, ECHO),
    webSocket: "skipped",
  };

  // Negative probes. Neither is expected to "succeed" — the violation list is the evidence.
  for (const attempt of [deps.probeBlobWorker, deps.probeCanary]) {
    try {
      await attempt();
    } catch {
      /* a rejection here is the expected shape of a blocked request */
    }
  }

  let renderer: CspProbeRecord["renderer"];
  try {
    renderer = deps.detectRenderer();
  } catch {
    renderer = "error";
  }

  let socketOpened: boolean | null = null;
  if (deps.probeWebSocket) {
    try {
      socketOpened = await deps.probeWebSocket();
    } catch {
      socketOpened = false;
    }
  }

  // Only now read violations, and only after they settle — an event queued by the attempts above
  // must be visible before "inconclusive" or "missing canary" can be claimed honestly.
  await deps.settle(SETTLE_MS);

  let collectorPresent: boolean;
  try {
    collectorPresent = deps.collectorPresent();
  } catch {
    collectorPresent = false;
  }

  const all = deps.violations();
  const expected = all.filter((v) => isImageCanary(v) || isBlobWorkerViolation(v));
  const unexpected = all.filter((v) => !isImageCanary(v) && !isBlobWorkerViolation(v));
  const canaries = {
    image: all.some(isImageCanary),
    blobWorker: all.some(isBlobWorkerViolation),
  };

  if (deps.probeWebSocket) {
    if (socketOpened) {
      checks.webSocket = "pass";
    } else {
      // Correlate by BOTH directive and blocked URI: an unrelated connect-src violation must not be
      // mislabelled as this socket's CSP failure.
      // EXACT match after normalising trailing slashes. `startsWith` was wrong: it also matched
      // `ws://localhost:51730/` (a different port that shares the prefix) and
      // `ws://localhost:5173/other` (a different path), either of which would have been
      // misattributed to this socket.
      const blocked = unexpected.some(
        (v) =>
          v.effectiveDirective.startsWith("connect-src") &&
          normalizeUri(v.blockedURI) === normalizeUri(WS_URI),
      );
      checks.webSocket = blocked ? "csp-fail" : "inconclusive";
    }
  }

  const assertionsHeld =
    checks.styleLink === "pass" &&
    checks.styleInline === "pass" &&
    checks.workerSelf === "pass" &&
    checks.webSocket !== "csp-fail" &&
    checks.webSocket !== "inconclusive";

  const ok =
    collectorPresent &&
    assertionsHeld &&
    canaries.image &&
    canaries.blobWorker &&
    unexpected.length === 0;

  return {
    probe: "csp",
    violations: { expected, unexpected },
    collectorPresent,
    canaries,
    renderer,
    checks,
    ok,
  };
}

/** Render the record for `smoke_done`'s reason string, which is what CI actually surfaces. */
export function describeCspProbe(record: CspProbeRecord): string {
  const failed = Object.entries(record.checks)
    .filter(([, v]) => v === "fail" || v === "csp-fail" || v === "inconclusive")
    .map(([k, v]) => `${k}=${v}`);
  const parts = [
    `csp=${record.ok ? "ok" : "FAIL"}`,
    `renderer=${record.renderer}`,
    `collector=${record.collectorPresent ? "present" : "ABSENT"}`,
    `canaries=img:${record.canaries.image ? "seen" : "MISSING"},blob:${
      record.canaries.blobWorker ? "seen" : "MISSING"
    }`,
    `unexpected=${record.violations.unexpected.length}`,
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
  // The timer is CLEARED on settle. Leaving it armed kept the probe's process alive past its own
  // result and leaked one timer per check — harmless in the smoke, wrong in a unit test.
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), CHECK_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Mount `node`, measure the target's computed padding-top, and remove BOTH the target and the
 * injected node. Leaving the node mounted is what made the two style checks non-independent.
 */
export async function measureStyle(
  targetId: string,
  node: HTMLElement,
  awaitLoad: boolean,
): Promise<string> {
  const target = document.createElement("div");
  target.id = targetId;
  document.body.appendChild(target);
  document.head.appendChild(node);
  try {
    if (awaitLoad) {
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          node.onload = () => resolve();
          node.onerror = () => reject(new Error("blocked"));
        }),
        "stylesheet",
      );
    }
    return getComputedStyle(target).paddingTop;
  } finally {
    target.remove();
    node.remove();
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

    // `style-src 'self'` — the shape Vite emits into dist/index.html. Own id, own sentinel (3px).
    probeLinkStylesheet: () => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/csp-probe.css";
      return measureStyle("csp-probe-link-target", link, true);
    },

    // `style-src 'unsafe-inline'` — the shape Vite injects in dev. Own id, own sentinel (7px), so
    // it cannot be satisfied by the external stylesheet above.
    probeInlineStyle: () => {
      const style = document.createElement("style");
      style.textContent = "#csp-probe-inline-target { padding-top: 7px; }";
      return measureStyle("csp-probe-inline-target", style, false);
    },

    probeSelfWorker: () => echoFrom(new Worker("/csp-probe-worker.js")),

    // NEGATIVE (trmx-252 review finding 2): nothing in the app constructs a blob: worker —
    // @xterm/addon-webgl 0.18.0 contains no Worker/Blob/createObjectURL at all — so `worker-src` is
    // 'self' only, and a blob: worker MUST be refused. This doubles as a second directive-specific
    // canary, so the gate proves enforcement of two directives rather than one.
    probeBlobWorker: async () => {
      let url: string | null = null;
      try {
        url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
        const worker = new Worker(url);
        try {
          await echoFrom(worker);
        } catch {
          /* expected: the policy refused it */
        }
      } catch {
        /* expected: construction itself may throw when blocked */
      } finally {
        if (url) URL.revokeObjectURL(url);
      }
    },

    probeWebSocket: isDev
      ? () =>
          new Promise<boolean>((resolve) => {
            let socket: WebSocket;
            try {
              socket = new WebSocket(WS_URI, "vite-ping");
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

    probeCanary: () =>
      new Promise<void>((resolve) => {
        const image = new Image();
        image.onerror = () => resolve();
        image.onload = () => resolve();
        image.src = CANARY_URI;
        setTimeout(resolve, CHECK_TIMEOUT_MS);
      }),

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
