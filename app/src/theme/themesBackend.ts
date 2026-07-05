// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-89 (FR-6): the frontend↔backend THEMES service — the thin IPC seam over the Tauri theme
// commands (themes_read / themes_write / themes_open_dir) and the `themes:changed` file-watch signal.
// Mirrors ipc/backend.ts: every command is injectable (InvokeFn) so tests drive a fake backend, and
// the real edge (realInvoke / realEventBus) is exercised by the packaged app. `hydrateUserThemes` is
// the ONE call both startup AND the hot-reload handler make — read the user set, push it into the
// runtime registry (registry.ts), and in a plain browser (no Tauri runtime) degrade to a no-op.
// `onThemesChanged` subscribes to the backend's bare re-read signal with the EXACT live-guard /
// teardown-safe-before-listen-resolves / .catch()-no-runtime discipline as `onPtyExited`; the payload
// is `null` (a bare "something changed, re-read" signal), so it is ignored and `handler()` is called
// on every event.
import { realInvoke, type InvokeFn } from "../ipc/backend";
import { realEventBus, type EventBus } from "../ipc/eventBus";
import { registerUserThemes, type UserThemeEntry } from "./registry";

/** The backend broadcast fired when the user themes directory changes (a bare re-read signal, trmx-89). */
export const THEMES_CHANGED_EVENT = "themes:changed";

/**
 * The one place `themes_read()`'s contract is shallow-asserted: an entry is well-shaped when it has a
 * string `id` and a boolean `valid`. That is enough for the registry (registerUserThemes) to route it
 * — a valid entry derives its spec, an invalid one lists with its warnings. Deeper validation (the
 * spec's own fields) is the registry's / the core parser's job; here we only drop entries too
 * malformed to route, so a single junk element from a mismatched backend can't poison the whole set.
 */
function isUserThemeEntryShape(value: unknown): value is UserThemeEntry {
  if (typeof value !== "object" || value === null) return false;
  const { id, valid } = value as { id?: unknown; valid?: unknown };
  return typeof id === "string" && typeof valid === "boolean";
}

/**
 * Read the user themes the backend surfaces (`themes_read` → `UserThemeEntry[]`). The result is
 * untrusted input: a non-array (a mismatched/legacy backend) coerces to `[]`, and each element is
 * shape-validated so a single malformed entry is dropped rather than crashing registration.
 */
export async function readUserThemes(invoke: InvokeFn = realInvoke): Promise<UserThemeEntry[]> {
  const result = await invoke("themes_read");
  if (!Array.isArray(result)) return [];
  return result.filter(isUserThemeEntryShape);
}

/**
 * Read the user set and push it into the runtime registry — the ONE call startup and the
 * `themes:changed` hot-reload handler both make. Without a Tauri runtime (plain browser / jsdom) the
 * read rejects; we swallow it, register NOTHING (the built-ins already stand alone), and resolve `[]`.
 * Any other failure is handled the same way so a bad backend never blocks the app from booting.
 */
export async function hydrateUserThemes(invoke: InvokeFn = realInvoke): Promise<UserThemeEntry[]> {
  try {
    const entries = await readUserThemes(invoke);
    registerUserThemes(entries);
    return entries;
  } catch {
    // No Tauri runtime (or a failed read) — leave the registry as-is (register nothing) and no-op.
    return [];
  }
}

/**
 * Write `text` to the user theme file `<stem>.toml` (`themes_write`). Resolves the backend's string
 * (the resolved `user:<stem>` id / path); rejects on an I/O error so the caller can surface it. The
 * subsequent `themes:changed` event drives the re-read — this call does not itself re-register.
 */
export function writeUserTheme(
  stem: string,
  text: string,
  invoke: InvokeFn = realInvoke,
): Promise<string> {
  return invoke("themes_write", { stem, text }) as Promise<string>;
}

/** Reveal the user themes directory in the OS file manager (`themes_open_dir`). */
export function openThemesDir(invoke: InvokeFn = realInvoke): Promise<void> {
  return invoke("themes_open_dir").then(() => {});
}

/**
 * Subscribe to `themes:changed` and call `handler` on each event (trmx-89 — the hot-reload path
 * re-runs `hydrateUserThemes`). The payload is a BARE signal (`null`) — there is nothing to guard, so
 * it is ignored and every event fires `handler`. Same discipline as `onPtyExited`: the returned
 * teardown is safe to call BEFORE the async `listen` resolves (a late-resolving subscription is
 * unlistened immediately instead of leaking), the `live` guard keeps a torn-down handler silent even
 * if the bus still fires, and without a Tauri runtime the `listen` rejects and the subscription is inert.
 */
export function onThemesChanged(handler: () => void, bus: EventBus = realEventBus): () => void {
  let live = true;
  let unlisten: (() => void) | undefined;
  bus
    .listen(THEMES_CHANGED_EVENT, () => {
      if (!live) return;
      handler();
    })
    .then((u) => {
      if (live) unlisten = u;
      else u();
    })
    .catch(() => {
      // No Tauri runtime — there is no backend to announce theme-file changes; the subscription is inert.
    });
  return () => {
    live = false;
    unlisten?.();
  };
}
