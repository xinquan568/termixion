// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-93 (FR-5): the frontend↔backend SCRIPTS service — the thin IPC seam over the Tauri script
// commands (scripts_list / scripts_open_dir) and the `scripts:changed` file-watch signal. Mirrors
// themesBackend.ts: every command is injectable (InvokeFn) so tests drive a fake backend, and
// `onScriptsChanged` uses the exact live-guard / teardown-safe / .catch()-no-runtime discipline as
// `onThemesChanged`. Each entry carries its `sourceLine` (the escaped `source '<abs>'` command
// computed in Rust core) so the frontend NEVER re-implements shell escaping.
import { realInvoke, type InvokeFn } from "../ipc/backend";
import { realEventBus, type EventBus } from "../ipc/eventBus";

/** The backend broadcast fired when the scripts directory tree changes (a bare re-read signal). */
export const SCRIPTS_CHANGED_EVENT = "scripts:changed";

/** One script the backend surfaces (`scripts_list`). `relPath` is the display + startup-match key,
 * `name` the leaf, `sourceLine` the ready-to-send `source '<abs>'` command (core-escaped). */
export interface ScriptEntry {
  relPath: string;
  name: string;
  sourceLine: string;
}

/** Shallow-assert a `scripts_list` element: the three string fields the picker + execution need. A
 * single malformed entry from a mismatched backend is dropped, not allowed to poison the list. */
function isScriptEntryShape(value: unknown): value is ScriptEntry {
  if (typeof value !== "object" || value === null) return false;
  const { relPath, name, sourceLine } = value as {
    relPath?: unknown;
    name?: unknown;
    sourceLine?: unknown;
  };
  return (
    typeof relPath === "string" && typeof name === "string" && typeof sourceLine === "string"
  );
}

/**
 * List the user scripts the backend discovers (`scripts_list` → `ScriptEntry[]`, folders-first).
 * Untrusted input: a non-array (a mismatched backend, or no Tauri runtime where the invoke rejects)
 * degrades to `[]`, and each element is shape-validated. Never throws — a plain browser / jsdom with
 * no backend resolves `[]` so the picker + startup path just see "no scripts".
 */
export async function listScripts(invoke: InvokeFn = realInvoke): Promise<ScriptEntry[]> {
  try {
    const result = await invoke("scripts_list");
    if (!Array.isArray(result)) return [];
    return result.filter(isScriptEntryShape);
  } catch {
    return [];
  }
}

/** Reveal the user scripts directory in the OS file manager (`scripts_open_dir`). */
export function openScriptsDir(invoke: InvokeFn = realInvoke): Promise<void> {
  return invoke("scripts_open_dir").then(() => {});
}

/**
 * Subscribe to `scripts:changed` and call `handler` on each event (the picker re-runs `listScripts`).
 * The payload is a BARE signal — ignored; every event fires `handler`. Same discipline as
 * `onThemesChanged`: teardown is safe BEFORE the async `listen` resolves, the `live` guard silences a
 * torn-down handler, and without a Tauri runtime the `listen` rejects and the subscription is inert.
 */
export function onScriptsChanged(handler: () => void, bus: EventBus = realEventBus): () => void {
  let live = true;
  let unlisten: (() => void) | undefined;
  bus
    .listen(SCRIPTS_CHANGED_EVENT, () => {
      if (!live) return;
      handler();
    })
    .then((u) => {
      if (live) unlisten = u;
      else u();
    })
    .catch(() => {
      // No Tauri runtime — nothing announces script-file changes; the subscription is inert.
    });
  return () => {
    live = false;
    unlisten?.();
  };
}
