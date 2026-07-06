// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-94 (FR-9.3): the frontend↔backend KEYS service — the thin IPC seam over the `keys_read`
// command (the raw `[keys]` chord→command map) and the `keys:changed` file-watch signal. Mirrors
// scriptsBackend/themesBackend: injectable invoke + bus, teardown-safe subscription, inert without a
// Tauri runtime. The effective keymap is built frontend-side (mergeKeymap(FULL_DEFAULT_KEYS, …)).
import { realInvoke, type InvokeFn } from "../ipc/backend";
import { realEventBus, type EventBus } from "../ipc/eventBus";

/** The backend broadcast fired when the `[keys]` map in the config file changes (a bare re-read). */
export const KEYS_CHANGED_EVENT = "keys:changed";

/** Whether a value is a plain `Record<string,string>` (the keys map's wire shape). */
function isStringMap(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === "string");
}

/**
 * Read the raw user `[keys]` map (`keys_read` → `{ chord: commandId }`). Untrusted input: a non-map
 * (a mismatched backend, or no Tauri runtime where the invoke rejects) degrades to `{}`, so the
 * effective keymap falls back to the shipped defaults. Never throws.
 */
export async function readKeys(invoke: InvokeFn = realInvoke): Promise<Record<string, string>> {
  try {
    const result = await invoke("keys_read");
    return isStringMap(result) ? result : {};
  } catch {
    return {};
  }
}

/**
 * Subscribe to `keys:changed` and call `handler` on each event (the app re-reads + rebuilds the
 * effective keymap). Same teardown-safe / live-guard / no-runtime discipline as `onScriptsChanged`.
 */
export function onKeysChanged(handler: () => void, bus: EventBus = realEventBus): () => void {
  let live = true;
  let unlisten: (() => void) | undefined;
  bus
    .listen(KEYS_CHANGED_EVENT, () => {
      if (live) handler();
    })
    .then((u) => {
      if (live) unlisten = u;
      else u();
    })
    .catch(() => {
      // No Tauri runtime — nothing announces [keys] edits; the subscription is inert.
    });
  return () => {
    live = false;
    unlisten?.();
  };
}
