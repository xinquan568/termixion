// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-101 (FR-9.4, test-first): the control-request router + the ls snapshot builder.
import { describe, it, expect, vi } from "vitest";
import {
  routeControlRequest,
  buildLsSnapshot,
  CONTROL_PROTOCOL_VERSION,
  type ControlDeps,
  type LsTabInput,
} from "./controlBridge";
import { leafNode, splitLeaf, type LayoutNode } from "../panes/layoutTree";
import lsShapeGolden from "./__fixtures__/ls-shape.json";

function deps(over: Partial<ControlDeps> = {}): ControlDeps {
  return {
    dispatch: vi.fn(() => true),
    hasCommand: vi.fn((id: string) => id.startsWith("pane.") || id === "theme.select"),
    buildLs: vi.fn(() => ({ protocol: CONTROL_PROTOCOL_VERSION, tabs: [] })),
    sendText: vi.fn(() => true),
    ...over,
  };
}

describe("routeControlRequest", () => {
  it("dispatches a registry command by id (the same path as a keypress) → ok:true", () => {
    const d = deps();
    expect(routeControlRequest({ cmd: "pane.split-right" }, d)).toEqual({ ok: true });
    expect(d.dispatch).toHaveBeenCalledWith("pane.split-right", undefined);
  });
  it("passes a string arg (theme.select) through", () => {
    const d = deps();
    routeControlRequest({ cmd: "theme.select", args: { arg: "night" } }, d);
    expect(d.dispatch).toHaveBeenCalledWith("theme.select", "night");
  });
  it("unknown id → unknown-command; a known but refused command → not-applicable", () => {
    expect(routeControlRequest({ cmd: "nope.nope" }, deps())).toEqual({
      ok: false,
      error: "unknown-command",
    });
    expect(
      routeControlRequest({ cmd: "pane.close" }, deps({ dispatch: vi.fn(() => false) })),
    ).toEqual({ ok: false, error: "not-applicable" });
  });
  it("ls returns the snapshot", () => {
    const snap = { protocol: 1, tabs: [] };
    expect(routeControlRequest({ cmd: "ls" }, deps({ buildLs: () => snap }))).toEqual({
      ok: true,
      result: snap,
    });
  });
  it("send-text routes to the pane; missing text or no-such-pane → ok:false", () => {
    const sendText = vi.fn(() => true);
    expect(routeControlRequest({ cmd: "send-text", args: { pane: "3", text: "make\n" } }, deps({ sendText }))).toEqual({ ok: true });
    expect(sendText).toHaveBeenCalledWith("3", "make\n");
    // pane defaults to focused
    routeControlRequest({ cmd: "send-text", args: { text: "hi" } }, deps({ sendText }));
    expect(sendText).toHaveBeenLastCalledWith("focused", "hi");
    expect(routeControlRequest({ cmd: "send-text", args: {} }, deps())).toEqual({
      ok: false,
      error: "send-text requires args.text",
    });
    expect(
      routeControlRequest({ cmd: "send-text", args: { text: "x" } }, deps({ sendText: () => false })),
    ).toEqual({ ok: false, error: "no-such-pane" });
  });
  it("junk (missing cmd) → ok:false, never throws", () => {
    expect(routeControlRequest({}, deps())).toEqual({ ok: false, error: "missing-cmd" });
    expect(routeControlRequest(null, deps())).toEqual({ ok: false, error: "missing-cmd" });
  });
});

describe("buildLsSnapshot", () => {
  it("emits the tabs/panes tree in leaf order with ids/sessionId/title/cwd/busy/focused", () => {
    const tree: LayoutNode = splitLeaf(leafNode(1), 1, "row", 2); // panes 1 | 2
    const tabs: LsTabInput[] = [
      {
        tabId: 10,
        focusedPaneId: 2,
        panes: { 1: { sessionId: 100, title: "zsh" }, 2: { sessionId: 101, title: "vim" } },
        tree,
      },
    ];
    const snap = buildLsSnapshot(
      tabs,
      10,
      (id) => (id === 1 ? "/home" : null),
      (id) => id === 2,
    );
    expect(snap.protocol).toBe(CONTROL_PROTOCOL_VERSION);
    expect(snap.tabs[0]).toMatchObject({ id: 10, active: true });
    expect(snap.tabs[0].panes).toEqual([
      { id: 1, sessionId: 100, title: "zsh", cwd: "/home", busy: false, focused: false },
      { id: 2, sessionId: 101, title: "vim", cwd: null, busy: true, focused: true },
    ]);
    // The `ls` wire shape is a PUBLIC contract (docs/remote-control.md); pin it to a committed golden so a
    // change to the snapshot is a conscious, reviewed protocol change.
    expect(snap).toEqual(lsShapeGolden);
  });
});
