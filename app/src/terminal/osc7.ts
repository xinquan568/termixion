// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-64: OSC 7 working-directory retention. Shells report their cwd as `OSC 7 ; file://host/path
// ST` (zsh/bash via precmd hooks, same convention iTerm2/Terminal.app consume); xterm.js has no
// built-in handler, so without one the report is discarded. This module parses and RETAINS the last
// reported path — no UI reads it yet; it is the seam later new-tab-inherits-cwd work (v0.0.3+)
// consumes via one import point (`currentCwd` / the default store). The handler is defensive the way
// `cursorSettings.ts` is about events: OSC payloads are untrusted input, junk must be inert (consume
// as a no-op, never throw), and the sequence is always swallowed (return true) so a malformed report
// never leaks to another handler.

/** A retained working directory: the last valid OSC 7 path, or null before any report. */
export interface CwdStore {
  set(cwd: string): void;
  get(): string | null;
}

/** A fresh, independent store — tests and per-session tracking use one each. */
export function makeCwdStore(): CwdStore {
  let cwd: string | null = null;
  return {
    set(next: string): void {
      cwd = next;
    },
    get(): string | null {
      return cwd;
    },
  };
}

/** The module-default store `attachOsc7` writes when no store is injected. */
export const defaultCwdStore: CwdStore = makeCwdStore();

/** The last shell-reported working directory (module-default store), or null before any report. */
export function currentCwd(): string | null {
  return defaultCwdStore.get();
}

/** A minimal disposable, matching xterm's `IDisposable`. */
export interface Osc7Disposable {
  dispose(): void;
}

/**
 * The slice of an xterm `Terminal` OSC 7 needs — `parser` is xterm's proposed API (requires
 * `allowProposedApi: true`); the narrow shape fits both `@xterm/xterm` and `@xterm/headless`.
 */
export interface Osc7TerminalLike {
  readonly parser: {
    registerOscHandler(ident: number, callback: (data: string) => boolean): Osc7Disposable;
  };
}

/**
 * Register the OSC 7 handler on `terminal`, retaining each reported cwd in `store` (the module
 * default unless injected). The payload must be a `file://` URL; the hostname (empty or a machine
 * name) is ignored and the path is percent-decoded. Any other scheme, an empty path, or a malformed
 * payload is consumed as a no-op. Returns a teardown that disposes the handler.
 */
export function attachOsc7(terminal: Osc7TerminalLike, store: CwdStore = defaultCwdStore): () => void {
  const handler = terminal.parser.registerOscHandler(7, (data) => {
    try {
      const url = new URL(data);
      if (url.protocol === "file:") {
        const path = decodeURIComponent(url.pathname);
        if (path !== "") store.set(path);
      }
    } catch {
      // Malformed payload (`new URL` TypeError / `decodeURIComponent` URIError): keep the old value.
    }
    return true;
  });
  return () => handler.dispose();
}
