// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-101 (FR-9.4): the frontend half of the control channel. A control request arrives from the Rust
// socket over `control:request`; this PURE router dispatches it through the SAME trmx-94 command path as a
// keypress (so there is no second implementation), builds the `ls` snapshot, or routes `send-text` to a
// pane's PTY — returning the `{ok, result?, error?}` payload the Rust side replies with. External input is
// untrusted, so every branch validates and never throws.

import { leaves, type LayoutNode } from "../panes/layoutTree";

/** The `ls` protocol version; pinned by the Rust↔TS golden fixture so the two sides can't drift. */
export const CONTROL_PROTOCOL_VERSION = 1;

export interface LsPane {
  id: number;
  sessionId: number | null;
  title: string;
  cwd: string | null;
  busy: boolean;
  focused: boolean;
}
export interface LsTab {
  id: number;
  active: boolean;
  panes: LsPane[];
}
export interface LsSnapshot {
  protocol: number;
  tabs: LsTab[];
}

/** The minimal per-tab shape the snapshot needs (a subset of the App reducer's Tab). */
export interface LsTabInput {
  tabId: number;
  focusedPaneId: number;
  panes: Record<number, { sessionId: number | null; title: string } | undefined>;
  tree: LayoutNode;
}

/** Build the tabs/panes tree snapshot (leaf order), reading cwd/busy per pane from App-owned state. */
export function buildLsSnapshot(
  tabs: LsTabInput[],
  activeTabId: number | null,
  cwdFor: (paneId: number) => string | null,
  busyFor: (paneId: number) => boolean,
): LsSnapshot {
  return {
    protocol: CONTROL_PROTOCOL_VERSION,
    tabs: tabs.map((tab) => ({
      id: tab.tabId,
      active: tab.tabId === activeTabId,
      panes: leaves(tab.tree).map((paneId) => ({
        id: paneId,
        sessionId: tab.panes[paneId]?.sessionId ?? null,
        title: tab.panes[paneId]?.title ?? "",
        cwd: cwdFor(paneId),
        busy: busyFor(paneId),
        focused: paneId === tab.focusedPaneId,
      })),
    })),
  };
}

/** The reply payload for a control request. */
export interface ControlReply {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** The seams a control request drives — all App-owned, injected so the router is pure + testable. */
export interface ControlDeps {
  /** Dispatch a registry command by id (the SAME path as a keypress); returns whether it ran. */
  dispatch: (id: string, arg?: string) => boolean;
  /** Whether a command id exists in the registry (distinguishes unknown from `when`-refused). */
  hasCommand: (id: string) => boolean;
  /** Build the `ls` snapshot. */
  buildLs: () => LsSnapshot;
  /** Type text into a pane (`"focused"` or a pane id); false if no such pane. */
  sendText: (pane: string, text: string) => boolean;
}

/** Route one parsed control request (`{cmd, args?}`) to its reply. Untrusted → validate, never throw. */
export function routeControlRequest(
  request: { cmd?: unknown; args?: unknown } | null | undefined,
  deps: ControlDeps,
): ControlReply {
  const cmd = request && typeof request.cmd === "string" ? request.cmd : "";
  if (!cmd) return { ok: false, error: "missing-cmd" };
  const args = (request?.args ?? {}) as Record<string, unknown>;

  if (cmd === "ls") return { ok: true, result: deps.buildLs() };
  if (cmd === "send-text") {
    const text = args.text;
    if (typeof text !== "string") return { ok: false, error: "send-text requires args.text" };
    const pane = args.pane === undefined ? "focused" : String(args.pane);
    return deps.sendText(pane, text) ? { ok: true } : { ok: false, error: "no-such-pane" };
  }
  // A registry command. `get(id) === undefined` ⇒ unknown; ran=false with a known id ⇒ when-refused.
  if (!deps.hasCommand(cmd)) return { ok: false, error: "unknown-command" };
  const arg = typeof args.arg === "string" ? args.arg : undefined;
  return deps.dispatch(cmd, arg) ? { ok: true } : { ok: false, error: "not-applicable" };
}
