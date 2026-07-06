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
  /** Run a command by id. Returns true if it ran (found + guard passed), false (inert) otherwise. */
  dispatch(id: string, arg?: string): boolean;
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
    dispatch(id, arg) {
      const cmd = byId.get(id);
      if (!cmd) {
        console.warn(`[termixion] dispatch: unknown command "${id}"`);
        return false;
      }
      if (cmd.when && !cmd.when(ctx)) {
        // A guarded-off command (e.g. tab.select-9 with only 3 tabs) is inert, not an error.
        return false;
      }
      cmd.run(ctx, arg);
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
