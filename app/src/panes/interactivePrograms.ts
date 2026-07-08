// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-159: membership lists + the invocation-shape classifier for the interactive-aware activity
// indicator. A busy epoch is `interactive` (its light gates on submit-armed output recency) only
// when its foreground program is a listed AI CLI or REPL invoked in an INTERACTIVE shape; every
// other case is `plain` — today's always-lit behavior, so a misclassification can never leave a
// running job DARK, only lit. Pure (no React/DOM, no wall clock): name-in / class-out, so the whole
// rule table is unit-testable headless. The three inputs come from the poller's rise metadata
// (foreground leader NAME, its argv TAIL with argv[0] already excluded, and whether its stdin is a
// tty); each is independently optional, and the partial-metadata fail-safes below keep a program
// classifiable (never stuck dark) even when argv/stdin could not be resolved.

/** AI coding CLIs — a bare/interactive invocation is a chat session that idles at its prompt. */
export const AI_CLI_PROGRAMS = [
  "claude",
  "codex",
  "gemini",
  "copilot",
  "github-copilot",
  "aider",
  "goose",
  "amp",
  "opencode",
  "cursor-agent",
  "q",
] as const;

/** Generic REPLs / interactive shells — same idle-at-prompt problem as the AI CLIs. */
export const REPL_PROGRAMS = [
  "python",
  "python3",
  "ipython",
  "node",
  "deno",
  "irb",
  "pry",
  "psql",
  "mysql",
  "sqlite3",
  "redis-cli",
  "mongosh",
  "ssh",
  "julia",
  "R",
  "ghci",
  "iex",
  "erl",
  "lua",
] as const;

/**
 * ssh flags whose FOLLOWING argv token is a value, not a positional — so `ssh -p 2222 host` has
 * exactly one positional (the host) and reads interactive. An ssh value flag OUTSIDE this table
 * degrades safely: its value is counted as a positional, pushing the count off "exactly one" so a
 * one-shot / exotic form lands on `plain` rather than being wrongly called interactive.
 */
export const SSH_VALUE_FLAGS = ["-p", "-i", "-l", "-o", "-J", "-F", "-c", "-e", "-b"] as const;

/** The class of a foreground invocation for the activity light (the `unknown` state is upstream). */
export type InvocationClass = "plain" | "interactive";

/** Case-insensitive basename of a program name/path (`/usr/bin/Python3` → `python3`). */
function basename(name: string): string {
  const stripped = name.split("/").pop() ?? name;
  return stripped.toLowerCase();
}

/** Whether `base` (already lowercased) is in a program list (list entries compared case-insensitively). */
function inList(list: readonly string[], base: string): boolean {
  return list.some((p) => p.toLowerCase() === base);
}

/** Count POSITIONALS in the default shape: an argv-tail token that does not start with `-`. */
function countDefaultPositionals(args: readonly string[]): number {
  return args.reduce((n, a) => (a.startsWith("-") ? n : n + 1), 0);
}

/** Whether any of `flags` (exact, or a `--long=value` prefix) appears in the argv tail. */
function hasAnyFlag(args: readonly string[], flags: readonly string[]): boolean {
  return args.some((a) =>
    flags.some((f) => a === f || (f.startsWith("--") && a.startsWith(`${f}=`))),
  );
}

/**
 * ssh arity: skip each value flag's following value, count the rest of the non-`-` tokens as
 * positionals. Exactly ONE positional (the destination host) ⇒ interactive; 0 or ≥2 ⇒ plain.
 */
function classifySsh(args: readonly string[]): InvocationClass {
  let positionals = 0;
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a.startsWith("-")) {
      // A known value flag consumes the next token as its value (not a positional).
      i += (SSH_VALUE_FLAGS as readonly string[]).includes(a) ? 2 : 1;
      continue;
    }
    positionals += 1;
    i += 1;
  }
  return positionals === 1 ? "interactive" : "plain";
}

/**
 * Classify a foreground program invocation. `name` = the program name (path allowed; basename taken,
 * case-insensitive). `args` = the argv TAIL (argv[0] already excluded), or `undefined` when unknown.
 * `stdinTty` = whether the program's stdin is a tty, or `undefined` when unknown.
 *
 * Returns `interactive` only for a listed program in interactive shape; EVERYTHING else — an unlisted
 * name, a redirected stdin, a positional/one-shot spelling — is `plain` (today's always-lit behavior),
 * so the light is never wrongly dark. Rules (in order):
 *  - unlisted name ⇒ plain;
 *  - stdinTty === false ⇒ plain (a redirect like `mysql < dump.sql` is never an interactive session);
 *  - args unknown (partial metadata) ⇒ AI-CLI ⇒ interactive, REPL ⇒ plain (the fail-safe direction);
 *  - ssh ⇒ arity table; psql ⇒ plain iff -c/--command/-f/--file; mysql ⇒ plain iff -e/--execute;
 *    sqlite3 ⇒ plain iff ≥2 positionals (a 2nd positional is an execute-and-exit SQL string);
 *  - otherwise (AI CLIs, other REPLs, redis-cli, mongosh) ⇒ default shape: 0 positionals interactive,
 *    ≥1 positional plain.
 */
export function classifyInvocation(
  name: string | undefined,
  args: string[] | undefined,
  stdinTty: boolean | undefined,
): InvocationClass {
  if (name === undefined) return "plain";
  const base = basename(name);
  const isAi = inList(AI_CLI_PROGRAMS, base);
  const isRepl = inList(REPL_PROGRAMS, base);
  if (!isAi && !isRepl) return "plain"; // an unlisted tool keeps today's always-lit behavior

  // A non-tty stdin (file/pipe/heredoc) is never an interactive session, for any listed program.
  if (stdinTty === false) return "plain";

  // Partial metadata: no argv to shape-check ⇒ lean on the family (AI CLIs default interactive;
  // REPLs default plain — a REPL far more often runs a one-shot than an AI CLI does).
  if (args === undefined) return isAi ? "interactive" : "plain";

  switch (base) {
    case "ssh":
      return classifySsh(args);
    case "psql":
      return hasAnyFlag(args, ["-c", "--command", "-f", "--file"]) ? "plain" : "interactive";
    case "mysql":
      return hasAnyFlag(args, ["-e", "--execute"]) ? "plain" : "interactive";
    case "sqlite3":
      return countDefaultPositionals(args) >= 2 ? "plain" : "interactive";
    default:
      return countDefaultPositionals(args) === 0 ? "interactive" : "plain";
  }
}
