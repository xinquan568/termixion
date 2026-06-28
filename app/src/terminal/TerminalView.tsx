// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// B-4: the React surface for a terminal. It owns a host <div>, mounts an xterm.js terminal into it
// on mount (via the injectable WebGL→DOM strategy), and disposes on unmount. B-5/C wire the live PTY
// across the Tauri channel into this terminal.
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import {
  mountTerminal,
  type AddonLike,
  type MountDeps,
  type TerminalLike,
} from "./mountTerminal";

// Is a WebGL2 context actually obtainable? Preflighting here means we throw *before* constructing
// `WebglAddon` on unsupported hardware — `WebglAddon.activate()` registers some renderer listeners
// before its own `getContext("webgl2")` would throw, so skipping it entirely keeps the fallback clean.
function supportsWebgl2(): boolean {
  try {
    return document.createElement("canvas").getContext("webgl2") != null;
  } catch {
    return false;
  }
}

// Adapter seam: bridge the real xterm classes to the strategy's small interfaces. The casts are
// localized here — the one place our pure logic meets the external library's wider types.
const realDeps: MountDeps = {
  createTerminal: () =>
    new Terminal({
      convertEol: true,
      fontFamily: "monospace",
      cursorBlink: true,
    }) as unknown as TerminalLike,
  createWebglAddon: () => {
    if (!supportsWebgl2()) {
      throw new Error("WebGL2 is not available; using the DOM renderer");
    }
    return new WebglAddon() as unknown as AddonLike;
  },
};

export interface TerminalViewProps {
  /** Injection seam for tests; defaults to the real WebGL→DOM strategy. */
  mount?: typeof mountTerminal;
  /** Injection seam for tests; defaults to the real xterm-backed factories. */
  deps?: MountDeps;
}

export function TerminalView({
  mount = mountTerminal,
  deps = realDeps,
}: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handle = mount(host, deps);
    return () => handle.dispose();
  }, [mount, deps]);

  return <div ref={hostRef} data-testid="terminal" className="terminal-host" />;
}
