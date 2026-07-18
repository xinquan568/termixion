// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-190: the pure bucketing/aggregation model for the title-bar AI-session counters. No React,
// no DOM, no clock — per-pane `{foreground, activityVisible}` state in, an ordered display model
// out (the tabTitle.ts discipline: one pure module owns every display rule, so the reducer, App,
// and the component share one definition). Buckets group by the LITERAL foreground command name:
// the four named buckets below, every other AI_CLI_PROGRAMS member folded into `Other`, anything
// else null (not an AI session). THE NUMERATOR INVARIANT lives here by construction: a bucket's
// numerator counts its sessions with `active === true`, and a session is active exactly when its
// pane's activity bar is lit (activityVisible) — the shared state trmx-191's manual toggle will
// flip, moving the count with zero extra wiring.

import { AI_CLI_PROGRAMS } from "../panes/interactivePrograms";
import { tabPaneIds, type Tab } from "../tabs/tabState";

/**
 * The named buckets, in display order — the ONE-LINE promotion surface: adding an
 * AI_CLI_PROGRAMS member here gives it its own segment and removes it from `Other`.
 */
export const NAMED_BUCKETS = ["claude", "codex", "copilot", "github-copilot"] as const;

/** A counter bucket: one of the named four, or the fold for the rest of AI_CLI_PROGRAMS. */
export type BucketId = (typeof NAMED_BUCKETS)[number] | "Other";

/** Case-insensitive basename (`/usr/local/bin/Claude` → `claude`) — the classifyInvocation rule. */
function basename(name: string): string {
  const stripped = name.split("/").pop() ?? name;
  return stripped.toLowerCase();
}

/** The bucket for a foreground program name, or null when it is not a listed AI CLI. */
export function bucketFor(name: string): BucketId | null {
  const base = basename(name);
  const named = NAMED_BUCKETS.find((b) => b === base);
  if (named) return named;
  return AI_CLI_PROGRAMS.some((p) => p.toLowerCase() === base) ? "Other" : null;
}

/** One AI session (an AI-foregrounded pane) in the counter model. */
export interface AiSession {
  tabId: number;
  paneId: number;
  bucket: BucketId;
  /** The literal foreground name (the tooltip shows the bucket; kept for future promotion UX). */
  name: string;
  /** The pane's effective title, for the tooltip's per-session row. */
  title: string;
  /** The numerator state: this pane's activity bar is lit (activityVisible === true). */
  active: boolean;
}

/** Collect the AI sessions over `tabs` in tab order (pane order within each tab's tree). */
export function sessionsFrom(tabs: readonly Tab[]): AiSession[] {
  const sessions: AiSession[] = [];
  for (const tab of tabs) {
    for (const paneId of tabPaneIds(tab)) {
      const pane = tab.panes[paneId];
      const name = pane?.foreground?.name;
      if (name === undefined) continue;
      const bucket = bucketFor(name);
      if (bucket === null) continue;
      sessions.push({
        tabId: tab.tabId,
        paneId,
        bucket,
        name,
        title: pane.title,
        active: pane.activityVisible === true,
      });
    }
  }
  return sessions;
}

/** One rendered segment: `bucket: active/total`. */
export interface BucketSegment {
  bucket: BucketId;
  active: number;
  total: number;
}

/** The full counter display model. */
export interface AiCounterModel {
  /** Visible buckets in display order (a 0/0 bucket never appears). */
  segments: BucketSegment[];
  /** The aggregate, rendered last — `redundant` when a single bucket makes it pure repetition. */
  all: { active: number; total: number; redundant: boolean } | null;
  /** Every numerator is 0 (the dimmed, scannable all-idle state). Vacuously true with no buckets. */
  allIdle: boolean;
}

/** Aggregate sessions into the ordered display model, applying the hide/suppress rules. */
export function aggregate(sessions: readonly AiSession[]): AiCounterModel {
  const order: readonly BucketId[] = [...NAMED_BUCKETS, "Other"];
  const segments: BucketSegment[] = [];
  for (const bucket of order) {
    const members = sessions.filter((s) => s.bucket === bucket);
    if (members.length === 0) continue; // 0/0 is hidden
    segments.push({
      bucket,
      active: members.filter((s) => s.active).length,
      total: members.length,
    });
  }
  const all =
    segments.length === 0
      ? null
      : {
          active: segments.reduce((n, s) => n + s.active, 0),
          total: segments.reduce((n, s) => n + s.total, 0),
          redundant: segments.length <= 1,
        };
  return { segments, all, allIdle: segments.every((s) => s.active === 0) };
}

/** The stable identity of a session across re-derives (panes never migrate tabs). */
export function sessionKey(session: Pick<AiSession, "tabId" | "paneId">): string {
  return `${session.tabId}:${session.paneId}`;
}

/**
 * The click-to-cycle selector: the next session after `lastKey` among the ACTIVE sessions in tab
 * order with wrap-around, falling back to cycling ALL AI sessions when none are active. An
 * unknown/absent `lastKey` starts at the first; no sessions at all yields null.
 */
export function nextAiSession(
  sessions: readonly AiSession[],
  lastKey: string | null,
): AiSession | null {
  const active = sessions.filter((s) => s.active);
  const pool = active.length > 0 ? active : sessions;
  if (pool.length === 0) return null;
  const index = lastKey === null ? -1 : pool.findIndex((s) => sessionKey(s) === lastKey);
  return pool[(index + 1) % pool.length];
}
