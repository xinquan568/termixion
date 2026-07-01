// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-48: the pure update state machine. The whole auto-update UX is a small, deterministic reducer so
// it is unit-testable headless (R8) with no Tauri edge — the real plugin client (realUpdateClient) and
// the About page merely drive these transitions. Status flow:
//   idle → checking → { up-to-date | available | error }
//   available → downloading → { ready | error }
//   ready → (relaunch, external)      skip → dismissedVersion set, card hidden

/** Where the update flow currently is. */
export type UpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "error";

/** What we learned about an available update. */
export interface UpdateInfo {
  /** The newer version offered by the endpoint. */
  version: string;
  /** The version currently running (for "current X" context). */
  currentVersion?: string;
  /** Release notes / changelog body, if the manifest carries them. */
  notes?: string;
  /** Publish date (ISO string) if present. */
  date?: string;
}

/** Bytes downloaded so far (total is absent until the server reports a content length). */
export interface DownloadProgress {
  downloaded: number;
  total?: number;
}

export interface UpdateState {
  status: UpdateStatus;
  /** Present once an update is known (`available`/`downloading`/`ready`). */
  updateInfo?: UpdateInfo;
  progress?: DownloadProgress;
  /** Human-readable error when `status === "error"`. */
  error?: string;
  /** Whether we check automatically (persisted separately — see autoCheckStore). */
  autoCheckEnabled: boolean;
  /** A version the user chose to skip; the available card stays hidden for it. */
  dismissedVersion?: string;
}

export type UpdateAction =
  | { type: "checkStarted" }
  | { type: "foundUpToDate" }
  | { type: "foundAvailable"; info: UpdateInfo }
  | { type: "downloadStarted" }
  | { type: "downloadProgress"; progress: DownloadProgress }
  | { type: "downloadReady" }
  | { type: "failed"; error: string }
  | { type: "skip"; version: string }
  | { type: "setAutoCheck"; enabled: boolean }
  | { type: "reset" };

/** The starting state; `autoCheckEnabled` is seeded from persisted config. */
export function initialUpdateState(autoCheckEnabled: boolean): UpdateState {
  return { status: "idle", autoCheckEnabled };
}

/**
 * The reducer. Pure and total: unknown transitions return the state unchanged rather than throwing, so a
 * stray event (e.g. a late progress tick after an error) can never crash the UI.
 */
export function updateReducer(state: UpdateState, action: UpdateAction): UpdateState {
  switch (action.type) {
    case "checkStarted":
      return { ...state, status: "checking", error: undefined };

    case "foundUpToDate":
      return { ...state, status: "up-to-date", updateInfo: undefined, progress: undefined };

    case "foundAvailable":
      return { ...state, status: "available", updateInfo: action.info, progress: undefined };

    case "downloadStarted":
      // Only meaningful from `available`; ignore otherwise so a double-click can't skip the known update.
      if (state.status !== "available") return state;
      return { ...state, status: "downloading", progress: { downloaded: 0 } };

    case "downloadProgress":
      if (state.status !== "downloading") return state;
      return { ...state, progress: action.progress };

    case "downloadReady":
      if (state.status !== "downloading") return state;
      return { ...state, status: "ready", progress: undefined };

    case "failed":
      return { ...state, status: "error", error: action.error, progress: undefined };

    case "skip":
      // Record the skipped version and drop back to idle; the card is hidden by isCardVisible().
      return {
        ...state,
        status: "idle",
        dismissedVersion: action.version,
        updateInfo: undefined,
        progress: undefined,
      };

    case "setAutoCheck":
      return { ...state, autoCheckEnabled: action.enabled };

    case "reset":
      return { status: "idle", autoCheckEnabled: state.autoCheckEnabled };

    default:
      return state;
  }
}

/**
 * Whether the "update available" card should show: we have an update, we're in a stage that owns the card
 * (`available`/`downloading`/`ready`), and the user hasn't skipped this exact version.
 */
export function isCardVisible(state: UpdateState): boolean {
  if (!state.updateInfo) return false;
  if (state.dismissedVersion && state.dismissedVersion === state.updateInfo.version) return false;
  return state.status === "available" || state.status === "downloading" || state.status === "ready";
}

/** Percentage 0–100 for the progress bar (0 when total is unknown). */
export function progressPercent(progress: DownloadProgress | undefined): number {
  if (!progress || !progress.total) return 0;
  return Math.min(100, Math.round((progress.downloaded / progress.total) * 100));
}
