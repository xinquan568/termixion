// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the cross-window event seam. Tauri's emit/listen broadcast between webview windows
// (settings ⇄ main); tests inject a fake, and a plain browser (`pnpm dev`) simply has no runtime —
// `listen` rejects and consumers fall back to their local mode. Kept as thin as realUpdateClient:
// runtime glue with no logic of its own.
import { emit, listen } from "@tauri-apps/api/event";

export interface EventBus {
  /** Fire-and-forget broadcast to every window (including the emitter's own listeners). */
  emit(event: string, payload?: unknown): Promise<void> | void;
  /** Subscribe; resolves to an unlisten. Rejects when there is no Tauri runtime. */
  listen(event: string, handler: (payload: unknown) => void): Promise<() => void>;
}

export const realEventBus: EventBus = {
  emit(event, payload) {
    return emit(event, payload).catch(() => {
      // No runtime (plain browser) — broadcasting is best-effort by design.
    });
  },
  listen(event, handler) {
    return listen(event, (e) => handler(e.payload));
  },
};
