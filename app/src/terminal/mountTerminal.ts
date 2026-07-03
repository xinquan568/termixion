// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// B-4: the renderer-selection strategy for an xterm.js terminal.
//
// Rendering tiers (the "Canvas/DOM fallback" of the build plan): xterm.js v5 ships a built-in **DOM
// renderer** (always available, the universal fallback) and an accelerated **WebGL renderer** via
// `@xterm/addon-webgl`. We try WebGL first; if WebGL2 is unavailable or the addon fails to activate,
// or the GPU context is later lost, we drop the addon and xterm transparently reverts to the DOM
// renderer — so the terminal always renders. (The deprecated canvas addon is intentionally not used;
// DOM is the safe fallback.)
//
// This module is pure logic over small interfaces (no runtime xterm/React import), so the decision
// is unit-testable headless with fakes. `TerminalView` injects the real xterm-backed deps.

/** The slice of an xterm `Terminal` this strategy drives (incl. the C-2 PTY I/O surface). */
export interface TerminalLike {
  open(container: HTMLElement): void;
  loadAddon(addon: AddonLike | FitLike): void;
  /** Write PTY output bytes into the terminal. The optional callback is xterm's own parse-
   *  completion signal (`write(data, cb)` — fires after the chunk is parsed), surfaced for the
   *  trmx-78 perf harness; production wiring keeps calling `write(bytes)` and fakes may ignore it. */
  write(data: Uint8Array, callback?: () => void): void;
  /** Subscribe to user keystrokes (xterm delivers them as a string). */
  onData(handler: (data: string) => void): void;
  /** Subscribe to terminal resizes (cell grid). */
  onResize(handler: (size: { rows: number; cols: number }) => void): void;
  dispose(): void;
}

/** The slice of the `@xterm/addon-webgl` `WebglAddon` this strategy drives. */
export interface AddonLike {
  /** Fires when the GPU drops the WebGL context (e.g. driver reset, tab backgrounding). */
  onContextLoss(handler: () => void): void;
  dispose(): void;
}

/**
 * The slice of the `@xterm/addon-fit` `FitAddon` this strategy drives. `fit()` resizes xterm's cell
 * grid to fill the host element's current size — the renderer-agnostic engine behind issues 1 & 2
 * (the terminal owns the whole window and its content scales as the window resizes).
 */
export interface FitLike {
  fit(): void;
  dispose(): void;
}

/** Factories for the terminal and its WebGL + fit addons — real ones in the app, fakes in tests. */
export interface MountDeps {
  createTerminal(): TerminalLike;
  createWebglAddon(): AddonLike;
  createFitAddon(): FitLike;
}

/** Which renderer is currently active. */
export type RendererKind = "webgl" | "dom";

/** A mounted terminal plus the active renderer, a re-fit hook, and a teardown. */
export interface TerminalHandle {
  terminal: TerminalLike;
  /** `"webgl"` while the addon is active; flips to `"dom"` on fallback / context loss. */
  renderer: RendererKind;
  /** Re-fit the cell grid to the host element's current size — called on container/window resize. */
  fit(): void;
  dispose(): void;
}

/**
 * Mount a terminal into `container`, preferring the WebGL renderer and falling back to the DOM
 * renderer on any failure. Never throws for a missing/failed WebGL path — the terminal still opens.
 */
export function mountTerminal(
  container: HTMLElement,
  deps: MountDeps,
): TerminalHandle {
  const terminal = deps.createTerminal();
  terminal.open(container);

  // The fit addon is renderer-agnostic and always available, so it is loaded unconditionally (unlike
  // WebGL, which may be missing). It sizes xterm's grid to the host element so the terminal fills the
  // whole window and its content re-flows as the window resizes.
  const fit = deps.createFitAddon();
  terminal.loadAddon(fit);

  // Declared outside the try so dispose/catch can tear down a WebGL addon that was created (and
  // possibly already registered with the terminal by loadAddon) before activation threw.
  let webgl: AddonLike | undefined;

  // Default to the DOM renderer; upgrade to WebGL only if the addon actually activates. dispose()
  // always tears down the fit addon + terminal, plus the WebGL addon if one was created.
  const handle: TerminalHandle = {
    terminal,
    renderer: "dom",
    fit: () => fit.fit(),
    dispose: () => {
      webgl?.dispose();
      fit.dispose();
      terminal.dispose();
    },
  };

  try {
    webgl = deps.createWebglAddon();
    terminal.loadAddon(webgl); // throws if WebGL2 is unavailable / activation fails
    webgl.onContextLoss(() => {
      // Disposing the addon reverts xterm to its DOM renderer — the terminal keeps rendering.
      webgl?.dispose();
      handle.renderer = "dom";
    });
    handle.renderer = "webgl";
  } catch {
    // WebGL unavailable / activation failed — dispose the half-registered addon (idempotent) so it
    // doesn't linger attached, then stay on the DOM renderer (already the default above).
    webgl?.dispose();
    handle.renderer = "dom";
  }

  // Initial fit: size the grid to the host now that the terminal is open and its addons are loaded,
  // so it fills the window from the first frame regardless of which renderer won above.
  fit.fit();

  return handle;
}
