// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-94 (FR-9.1): the single dispatch point. Menu clicks, keymap hits, palette selections (and,
// later, the FR-9.4 control channel) ALL call `dispatch(commandId, arg?)` — one place a command is
// looked up, `when`-guarded, run against the injected ctx, and recorded in the session MRU. Pure
// over the injected registry + ctx (unit-testable, no DOM). Unknown ids / failed guards are inert +
// warned, never thrown.
import type { Command, CommandContext } from "./registry";

export interface Dispatcher {
  /** Run a command by id. Returns true if it ran (found + guard passed), false (inert) otherwise.
   * `source` (trmx-144) tags the dispatch origin — "user" (default) for user gestures, "remote" for
   * control-channel requests — surfaced to `run`/`when` as `ctx.origin`. */
  dispatch(id: string, arg?: string, source?: "user" | "remote"): boolean;
  /** Session MRU: the command ids run this session, most-recent first, deduped. */
  recentCommandIds(): string[];
  /** The command for an id (for the palette's binding hints + param lookup), or undefined. */
  get(id: string): Command | undefined;
}

export function createDispatcher(commands: Command[], ctx: CommandContext): Dispatcher {
  const byId = new Map(commands.map((cmd) => [cmd.id, cmd]));
  const mru: string[] = [];

  const record = (id: string) => {
    const existing = mru.indexOf(id);
    if (existing !== -1) mru.splice(existing, 1);
    mru.unshift(id);
  };

  return {
    dispatch(id, arg, source = "user") {
      const cmd = byId.get(id);
      if (!cmd) {
        console.warn(`[termixion] dispatch: unknown command "${id}"`);
        return false;
      }
      // trmx-144: inject the per-dispatch origin. App's ctx is a forwarding Proxy over an EMPTY
      // object (its get-trap returns forwarding functions), so it must NOT be spread — this
      // delegating wrapper answers `origin` itself and Reflect.gets everything else, which still
      // fires the underlying proxy's trap so every command method keeps forwarding.
      const callCtx = new Proxy(ctx, {
        get: (t, p) => (p === "origin" ? source : Reflect.get(t, p)),
      });
      if (cmd.when && !cmd.when(callCtx)) {
        // A guarded-off command (e.g. tab.select-9 with only 3 tabs) is inert, not an error.
        return false;
      }
      cmd.run(callCtx, arg);
      record(id);
      return true;
    },
    recentCommandIds() {
      return [...mru];
    },
    get(id) {
      return byId.get(id);
    },
  };
}
