// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu

// trmx-254: the application-level close contracts — orchestration shapes, so L6 (app/).

import type { PaneId } from "../panes/layoutTree";

// trmx-144: one close's options, threaded pane → tab so a close that already passed (or bypassed)
// the confirm gate is never re-gated downstream.
export type CloseOpts = {
  /** The session already exited on its own (pty:exited) — nothing left to protect, no close_pty. */
  alreadyExited?: boolean;
  /** Who asked: "remote" (control channel) never prompts — a dialog would deadlock a headless caller. */
  origin?: "user" | "remote";
  /** The user just confirmed THIS close in the dialog — proceed without re-prompting. */
  confirmed?: boolean;
};

// trmx-144: the pending confirm-before-close dialog's target (null = no dialog). `tabId`/`paneId`
// pin the target by id so a confirm re-resolves it (a dead target makes confirm a safe no-op).
export type PendingClose = {
  kind: "pane" | "tab" | "quit";
  tabId?: number;
  paneId?: PaneId;
  names: string[];
  /** Quit only: how many tabs have running programs — the dialog's summary line. */
  busyTabCount?: number;
};
