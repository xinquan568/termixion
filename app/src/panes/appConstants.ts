// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu

// trmx-254: pane-shaped constants and the activity observation seam. `ActivityObservation`
// carries `ActivityMeta` from panes/, so it is L1 — in ipc/ it would be an upward import.

import type { ActivityMeta } from "./activityLine";
import type { Rect } from "./layoutTree";

/** The default content bounds before the real ResizeObserver measures the pane area (px). */
export const DEFAULT_BOUNDS: Rect = { x: 0, y: 0, width: 800, height: 600 };

// trmx-90: cols fallback for the badge's narrow-pane threshold before the terminal has fit (or
// under a headless test stub with no metrics) — a sane wide default so a freshly-set badge still shows
// (a badge is only ever set once a live terminal exists, so this window is effectively pre-mount only).
// trmx-149 dropped the rows twin: font sizing now fits the pane RECT (iTerm2's box), not cell metrics.
export const FALLBACK_BADGE_COLS = 80;

/**
 * Observe `session:activity` busy<->idle transitions (trmx-91); returns a teardown. trmx-159: a busy
 * rise also carries optional classification metadata (foreground name / argv tail / stdin-tty).
 */
export type ActivityObservation = (
  onActivity: (sessionId: number, busy: boolean, meta?: ActivityMeta) => void,
) => () => void;
