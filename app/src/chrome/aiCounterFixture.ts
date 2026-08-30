// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu

import { NAMED_BUCKETS, type AiSession } from "./aiSessionBuckets";

/**
 * trmx-190: the counter's e2e fixture — `?e2e.aiCounter=claude:2/3,codex:0/2,Other:1/1` becomes
 * synthetic sessions (one per counted total, `active` for the first `active` of each bucket,
 * titles `fixture-<bucket>-<i>`), letting the runtime-less Playwright tier drive the CSS contract.
 * Junk-tolerant: any malformed part (or an unknown bucket, or active > total) → no fixture.
 */
export function parseAiCounterFixture(raw: string | null): AiSession[] | null {
  if (raw === null) return null;
  const buckets = new Set<string>([...NAMED_BUCKETS, "Other"]);
  const sessions: AiSession[] = [];
  let paneId = 1;
  for (const part of raw.split(",")) {
    const match = /^([A-Za-z-]+):(\d+)\/(\d+)$/.exec(part.trim());
    if (!match || !buckets.has(match[1])) return null;
    const active = Number(match[2]);
    const total = Number(match[3]);
    if (active > total) return null;
    for (let i = 1; i <= total; i += 1) {
      sessions.push({
        tabId: 1,
        paneId: paneId++,
        bucket: match[1] as AiSession["bucket"],
        name: match[1] === "Other" ? "gemini" : match[1],
        title: `fixture-${match[1]}-${i}`,
        active: i <= active,
      });
    }
  }
  return sessions;
}
