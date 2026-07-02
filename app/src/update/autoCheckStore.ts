// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: persistence for the single "check for updates automatically" preference. Intentionally a tiny
// key/value seam over `localStorage` — NOT the FR-13 config system (that is a later version). The Storage
// interface is injected so it round-trips under a fake in unit tests.

const KEY = "termixion.update.autoCheck";

/** The minimal slice of the Web Storage API we depend on (so tests can pass a fake). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface AutoCheckStore {
  /** Read the persisted flag; defaults to `true` when unset or unparseable. */
  load(): boolean;
  /** Persist the flag. */
  save(enabled: boolean): void;
}

/**
 * Build the store over the given key/value backend (defaults to `localStorage` in the webview). Reads are
 * defensive: any value other than the literal "false" is treated as enabled, and a throwing backend
 * degrades to the default rather than crashing the About page.
 */
export function makeAutoCheckStore(storage: KeyValueStore | undefined = safeLocalStorage()): AutoCheckStore {
  return {
    load() {
      if (!storage) return true;
      try {
        const raw = storage.getItem(KEY);
        if (raw === null) return true;
        return raw !== "false";
      } catch {
        return true;
      }
    },
    save(enabled) {
      if (!storage) return;
      try {
        storage.setItem(KEY, enabled ? "true" : "false");
      } catch {
        // Best-effort: a full/denied storage must not break the toggle.
      }
    },
  };
}

/** `localStorage` when present (browser/webview), else undefined (e.g. SSR / a locked-down runtime). */
function safeLocalStorage(): KeyValueStore | undefined {
  try {
    return typeof localStorage !== "undefined" ? localStorage : undefined;
  } catch {
    return undefined;
  }
}
