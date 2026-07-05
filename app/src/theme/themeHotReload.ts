// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-89 (FR-6): the main-window THEME HOT-RELOAD state machine. When the user edits a theme file
// on disk the backend fires `themes:changed`; the main window re-reads the user set (hydrateUserThemes
// → registerUserThemes) and then decides what to do about the ACTIVE theme via `decideHotReload`:
//   - the active theme is a built-in → nothing (a user-file edit can't touch it);
//   - the active `user:<stem>` file was DELETED → fall back to the derived default and persist it;
//   - the active `user:<stem>` was edited into an INVALID state → keep the previous colors (do NOT
//     touch the terminals — the last good palette stays up), just warn;
//   - the active `user:<stem>` is still valid → REAPPLY it, reusing the live `settings:changed` path
//     (buildXtermTheme rebuilds fresh tokens from the just-rehydrated registry — no direct terminal
//     poke here). The reapply re-emits the SAME id: the id is unchanged, only its tokens moved.
// `decideHotReload` is pure (list injected) so its truth table is unit-tested without a registry, and
// `installThemeHotReload`'s every edge (subscribe / hydrate / bus / settings / window) is injectable
// so the App wiring stays backend-free. Inert without a Tauri runtime: onThemesChanged's listen
// rejects and is swallowed, and hydrateUserThemes no-ops.
import { defaultThemeId } from "./defaultTheme";
import { isUserThemeIdShape, listThemes, type ThemeListEntry } from "./registry";
import { hydrateUserThemes, onThemesChanged } from "./themesBackend";
import { realEventBus, type EventBus } from "../ipc/eventBus";
import { SETTINGS_CHANGED_EVENT, type SettingsStore } from "../settings/settingsStore";

/**
 * What a `themes:changed` re-read implies for the ACTIVE theme (pure decision, no side effects):
 * - `none`        — unaffected (the active theme is a built-in id);
 * - `reapply`     — the active user theme is still valid; repaint it with its fresh tokens;
 * - `fallback`    — the active user theme's file is gone; switch to `to` (the derived default);
 * - `invalidated` — the active user theme parsed invalid now; keep the previous colors, only warn.
 */
export type HotReloadAction =
  | { kind: "none" }
  | { kind: "reapply"; id: string }
  | { kind: "fallback"; to: string }
  | { kind: "invalidated"; id: string };

/**
 * Decide what a fresh theme list implies for the currently-active theme id. Pure: `list` is the
 * post-rehydrate `listThemes()` and `derivedDefault` the OS-derived fallback id — no registry or
 * settings access here, so the truth table is unit-tested in isolation.
 *
 * A built-in active id is never affected by a user-theme file change (`none`). For a `user:<stem>`
 * active id: absent from the list → its file was removed (`fallback`); present but not valid → it
 * was edited into an unparseable state (`invalidated`); present and valid → repaint it (`reapply`).
 */
export function decideHotReload(
  activeId: string,
  list: ThemeListEntry[],
  derivedDefault: string,
): HotReloadAction {
  if (!isUserThemeIdShape(activeId)) return { kind: "none" };
  const entry = list.find((e) => e.id === activeId);
  if (!entry) return { kind: "fallback", to: derivedDefault };
  if (!entry.valid) return { kind: "invalidated", id: activeId };
  return { kind: "reapply", id: activeId };
}

/** Injection seams for `installThemeHotReload` — all default to the real edges (App passes `settings`). */
export interface ThemeHotReloadDeps {
  /** The settings store to read the active `appearance.theme` from and to persist a fallback into. */
  settings: SettingsStore;
  /** The bus a `reapply` re-emits `settings:changed` over; defaults to the real cross-window bus. */
  bus?: EventBus;
  /** The `themes:changed` subscription; defaults to the real `onThemesChanged`. */
  subscribe?: typeof onThemesChanged;
  /** The registry re-read run on each event; defaults to `hydrateUserThemes` (no-op without a backend). */
  hydrate?: () => Promise<unknown>;
  /** The window whose OS appearance derives the fallback default; defaults to the ambient window. */
  win?: Window;
}

/**
 * Install the hot-reload machine on the main window. On every `themes:changed` signal it re-reads the
 * user set, then applies `decideHotReload` over the fresh `listThemes()`:
 *   reapply     → `bus.emit(settings:changed)` with the SAME id (source "themes-reload"); TerminalView's
 *                 own observer rebuilds fresh tokens from the rehydrated registry — reusing the live path;
 *   fallback    → `settings.set("appearance.theme", <derived default>)` (persists + broadcasts) and warns;
 *   invalidated → warn only — the terminals keep the last good colors (nothing is reapplied);
 *   none        → nothing.
 * Returns the subscription's unsubscribe (App tears it down on unmount). A hot-reload failure is caught
 * and warned so it can never surface as an unhandled rejection.
 */
export function installThemeHotReload(deps: ThemeHotReloadDeps): () => void {
  const {
    settings,
    bus = realEventBus,
    subscribe = onThemesChanged,
    hydrate = hydrateUserThemes,
    win,
  } = deps;

  async function onThemesChangedSignal(): Promise<void> {
    await hydrate();
    const activeId = settings.get("appearance.theme");
    const action = decideHotReload(activeId, listThemes(), defaultThemeId(win));
    switch (action.kind) {
      case "reapply":
        // Re-emit over the live settings:changed path — the id is unchanged, but its tokens moved,
        // so a fresh buildXtermTheme(id) in TerminalView's observer repaints the terminal.
        bus.emit(SETTINGS_CHANGED_EVENT, {
          key: "appearance.theme",
          value: action.id,
          source: "themes-reload",
        });
        break;
      case "fallback":
        console.warn(
          `[termixion] active user theme "${activeId}" was removed; falling back to "${action.to}"`,
        );
        settings.set("appearance.theme", action.to);
        break;
      case "invalidated":
        console.warn(
          `[termixion] active user theme "${action.id}" is now invalid; keeping the previous colors`,
        );
        break;
      case "none":
        break;
    }
  }

  return subscribe(() => {
    onThemesChangedSignal().catch((err: unknown) => {
      console.warn("[termixion] theme hot-reload failed", err);
    });
  }, bus);
}
