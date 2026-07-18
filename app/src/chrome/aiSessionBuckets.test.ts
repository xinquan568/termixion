// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-190 (test-first): the pure bucketing/aggregation model for the title-bar AI-session
// counters. No React, no DOM, no clock — sessions in, ordered display model out, so every issue
// display rule is pinned headless: named buckets by LITERAL command name, the Other fold for the
// remaining AI_CLI_PROGRAMS members, 0/0 hidden, All last + suppressed-as-redundant with a single
// bucket, all-idle dimming, and THE NUMERATOR INVARIANT — a bucket's numerator is exactly the
// count of its panes whose activity bar is lit (activityVisible === true), the shared state that
// lets trmx-191's manual toggle move the count with zero extra wiring. The click-cycle selector
// (nextAiSession) is here too: active subset in tab order, wrap-around, fall back to all.
import { describe, it, expect } from "vitest";
import {
  NAMED_BUCKETS,
  bucketFor,
  sessionsFrom,
  aggregate,
  sessionKey,
  nextAiSession,
  type AiSession,
} from "./aiSessionBuckets";
import { reduceTabs, initialTabsState, type TabsAction, type TabsState } from "../tabs/tabState";

function run(...actions: TabsAction[]): TabsState {
  return actions.reduce(reduceTabs, initialTabsState());
}

/** A minimal AiSession literal for aggregate/cycle tests (bucketed already). */
function s(over: Partial<AiSession> & Pick<AiSession, "bucket">): AiSession {
  return {
    tabId: 1,
    paneId: 1,
    name: over.bucket === "Other" ? "gemini" : over.bucket,
    title: "shell",
    active: false,
    ...over,
  } as AiSession;
}

describe("bucketFor (trmx-190)", () => {
  it("maps the four literal command names to their named buckets", () => {
    for (const name of ["claude", "codex", "copilot", "github-copilot"]) {
      expect(bucketFor(name)).toBe(name);
    }
  });

  it("folds every other AI_CLI_PROGRAMS member into Other", () => {
    for (const name of ["gemini", "aider", "goose", "amp", "opencode", "cursor-agent", "q"]) {
      expect(bucketFor(name)).toBe("Other");
    }
  });

  it("returns null for non-AI programs (shells, REPLs, junk)", () => {
    for (const name of ["zsh", "bash", "python3", "vim", "ssh", ""]) {
      expect(bucketFor(name)).toBe(null);
    }
  });

  it("takes the basename case-insensitively (the classifyInvocation discipline)", () => {
    expect(bucketFor("/usr/local/bin/Claude")).toBe("claude");
    expect(bucketFor("/opt/ai/GEMINI")).toBe("Other");
  });

  it("promoting a tool is a one-line change: every NAMED_BUCKETS entry short-circuits Other", () => {
    // The pin: the named list drives the mapping — if "gemini" were added there, it would leave
    // Other. Guard the CURRENT contract (4 named buckets, gemini folded).
    expect(NAMED_BUCKETS).toEqual(["claude", "codex", "copilot", "github-copilot"]);
    expect(bucketFor("gemini")).toBe("Other");
  });
});

describe("sessionsFrom (trmx-190)", () => {
  it("collects AI panes in tab order with title + active state; non-AI panes excluded", () => {
    let state = run({ kind: "openTab" }, { kind: "openTab" });
    // tab 1 pane 1: claude, lit; tab 2 pane 2: zsh (no foreground) — excluded.
    state = reduceTabs(state, { kind: "setForeground", tabId: 1, paneId: 1, name: "claude" });
    state = reduceTabs(state, { kind: "setActivity", tabId: 1, paneId: 1, visible: true });
    const sessions = sessionsFrom(state.tabs);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ tabId: 1, paneId: 1, bucket: "claude", active: true });
  });

  it("two claudes in split panes of one tab count as two sessions", () => {
    let state = run({ kind: "openTab" }, { kind: "splitPane", tabId: 1, dir: "row" });
    const [p1, p2] = state.tabs[0] ? Object.keys(state.tabs[0].panes).map(Number) : [];
    state = reduceTabs(state, { kind: "setForeground", tabId: 1, paneId: p1, name: "claude" });
    state = reduceTabs(state, { kind: "setForeground", tabId: 1, paneId: p2, name: "claude" });
    const sessions = sessionsFrom(state.tabs);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((x) => x.bucket === "claude")).toBe(true);
  });

  it("a closed tab drops its sessions from the model entirely", () => {
    let state = run({ kind: "openTab" }, { kind: "openTab" });
    state = reduceTabs(state, { kind: "setForeground", tabId: 2, paneId: 2, name: "codex" });
    expect(sessionsFrom(state.tabs)).toHaveLength(1);
    state = reduceTabs(state, { kind: "closeTab", tabId: 2 });
    expect(sessionsFrom(state.tabs)).toHaveLength(0);
  });

  it("an OSC/manual title override never affects counting (foreground, not titles, decides)", () => {
    let state = run({ kind: "openTab" });
    state = reduceTabs(state, { kind: "setForeground", tabId: 1, paneId: 1, name: "claude" });
    state = reduceTabs(state, {
      kind: "setTitleSource",
      tabId: 1,
      paneId: 1,
      source: "osc",
      value: "definitely-not-claude",
    });
    state = reduceTabs(state, { kind: "setTabTitle", tabId: 1, value: "pinned label" });
    const sessions = sessionsFrom(state.tabs);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].bucket).toBe("claude");
  });
});

describe("aggregate (trmx-190)", () => {
  it("orders segments claude, codex, copilot, github-copilot, Other; All last", () => {
    const model = aggregate([
      s({ bucket: "Other", paneId: 5 }),
      s({ bucket: "codex", paneId: 2 }),
      s({ bucket: "claude", paneId: 1, active: true }),
    ]);
    expect(model.segments.map((x) => x.bucket)).toEqual(["claude", "codex", "Other"]);
    expect(model.all).toMatchObject({ active: 1, total: 3, redundant: false });
  });

  it("hides a 0/0 bucket and returns an empty model with no AI sessions", () => {
    const model = aggregate([]);
    expect(model.segments).toEqual([]);
    expect(model.all).toBe(null);
    const single = aggregate([s({ bucket: "codex" })]);
    expect(single.segments.map((x) => x.bucket)).toEqual(["codex"]);
  });

  it("the numerator is EXACTLY the lit-activity-bar count (the trmx-191 invariant)", () => {
    const model = aggregate([
      s({ bucket: "claude", paneId: 1, active: true }),
      s({ bucket: "claude", paneId: 2, active: false }),
      s({ bucket: "claude", paneId: 3, active: true }),
    ]);
    expect(model.segments).toEqual([{ bucket: "claude", active: 2, total: 3 }]);
  });

  it("flags All redundant with a single visible bucket, not with two", () => {
    expect(aggregate([s({ bucket: "claude" })]).all?.redundant).toBe(true);
    expect(
      aggregate([s({ bucket: "claude" }), s({ bucket: "codex", paneId: 2 })]).all?.redundant,
    ).toBe(false);
  });

  it("allIdle is true only when every numerator is 0", () => {
    expect(aggregate([s({ bucket: "claude" })]).allIdle).toBe(true);
    expect(aggregate([s({ bucket: "claude", active: true })]).allIdle).toBe(false);
    expect(aggregate([]).allIdle).toBe(true);
  });
});

describe("nextAiSession (trmx-190)", () => {
  const a1 = s({ bucket: "claude", tabId: 1, paneId: 1, active: true });
  const i2 = s({ bucket: "claude", tabId: 1, paneId: 2, active: false });
  const a3 = s({ bucket: "codex", tabId: 2, paneId: 3, active: true });

  it("cycles the ACTIVE subset in order with wrap-around", () => {
    const sessions = [a1, i2, a3];
    const first = nextAiSession(sessions, null);
    expect(first && sessionKey(first)).toBe(sessionKey(a1));
    const second = nextAiSession(sessions, sessionKey(a1));
    expect(second && sessionKey(second)).toBe(sessionKey(a3));
    const wrapped = nextAiSession(sessions, sessionKey(a3));
    expect(wrapped && sessionKey(wrapped)).toBe(sessionKey(a1));
  });

  it("falls back to cycling ALL AI sessions when none are active", () => {
    const sessions = [i2, s({ bucket: "codex", tabId: 2, paneId: 3, active: false })];
    const first = nextAiSession(sessions, null);
    expect(first && sessionKey(first)).toBe(sessionKey(i2));
    const second = nextAiSession(sessions, sessionKey(i2));
    expect(second?.paneId).toBe(3);
  });

  it("an unknown last key restarts at the first; empty sessions yield null", () => {
    expect(nextAiSession([], null)).toBe(null);
    const found = nextAiSession([a1, a3], "9:9");
    expect(found && sessionKey(found)).toBe(sessionKey(a1));
  });
});
