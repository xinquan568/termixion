// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-51: the pure "should an automatic update check run now?" decision. The master toggle gates
// everything; frequency then decides: on-startup checks at every launch, daily/weekly check when
// the recorded last check is at least one period old (or unknown/unparseable), manual never checks
// automatically. Total: garbage input degrades to a safe answer, never a throw. A lastCheckAt in
// the future (clock skew) counts as "recent" — the periodic check stays suppressed until the
// period genuinely passes; Check Now is always available.
import type { CheckFrequency } from "../settings/settingsStore";

export interface AutoCheckPrefs {
  autoCheck: boolean;
  frequency: CheckFrequency;
  lastCheckAt: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

export function shouldAutoCheck(now: Date, prefs: AutoCheckPrefs): boolean {
  if (!prefs.autoCheck) return false;
  switch (prefs.frequency) {
    case "on-startup":
      return true;
    case "daily":
      return isStale(now, prefs.lastCheckAt, DAY_MS);
    case "weekly":
      return isStale(now, prefs.lastCheckAt, WEEK_MS);
    case "manual":
      return false;
  }
}

function isStale(now: Date, lastCheckAt: string | null, periodMs: number): boolean {
  if (!lastCheckAt) return true;
  const t = Date.parse(lastCheckAt);
  if (Number.isNaN(t)) return true;
  return now.getTime() - t >= periodMs;
}
