// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-159 (test-first): the pure membership + invocation-shape classifier. Every listed program in
// interactive shape is `interactive`; every miss (unlisted name, redirected stdin, a positional /
// one-shot spelling) lands on `plain` = today's always-lit behavior, so a misclassification is never
// dark. No time, no DOM — plain string-in / class-out.
import { describe, it, expect } from "vitest";
import {
  AI_CLI_PROGRAMS,
  REPL_PROGRAMS,
  SSH_VALUE_FLAGS,
  classifyInvocation,
} from "./interactivePrograms";

describe("interactivePrograms membership (trmx-159)", () => {
  it("keeps the AI CLI + REPL lists as documented", () => {
    expect(AI_CLI_PROGRAMS).toContain("claude");
    expect(AI_CLI_PROGRAMS).toContain("cursor-agent");
    expect(REPL_PROGRAMS).toContain("python3");
    expect(REPL_PROGRAMS).toContain("psql");
    expect(SSH_VALUE_FLAGS).toEqual(["-p", "-i", "-l", "-o", "-J", "-F", "-c", "-e", "-b"]);
  });

  it("matches case-insensitively and path-stripped", () => {
    expect(classifyInvocation("/usr/bin/Python3", [], true)).toBe("interactive");
    expect(classifyInvocation("/opt/homebrew/bin/CLAUDE", [], true)).toBe("interactive");
    // `R` is listed capitalized; a lowercase invocation still matches.
    expect(classifyInvocation("R", [], true)).toBe("interactive");
  });

  it("classifies any unlisted program as plain", () => {
    expect(classifyInvocation("sleep", [], true)).toBe("plain");
    expect(classifyInvocation("vim", [], true)).toBe("plain");
    expect(classifyInvocation("/bin/cat", ["file"], true)).toBe("plain");
  });
});

describe("interactivePrograms default argv shape (trmx-159)", () => {
  it("is interactive with zero positionals, plain with any positional", () => {
    expect(classifyInvocation("claude", [], true)).toBe("interactive");
    expect(classifyInvocation("python", [], true)).toBe("interactive");
    expect(classifyInvocation("node", [], true)).toBe("interactive");
    // A positional (the script / prompt) ⇒ a one-shot ⇒ plain.
    expect(classifyInvocation("python", ["script.py"], true)).toBe("plain");
    expect(classifyInvocation("node", ["build.js"], true)).toBe("plain");
    // `claude -p "x"`: the default rule counts `x` (non-`-`) as a positional ⇒ plain.
    expect(classifyInvocation("claude", ["-p", "x"], true)).toBe("plain");
    // Pure-flag invocations keep zero positionals ⇒ interactive.
    expect(classifyInvocation("claude", ["--resume"], true)).toBe("interactive");
    expect(classifyInvocation("python", ["-q"], true)).toBe("interactive");
  });
});

describe("interactivePrograms ssh arity (trmx-159)", () => {
  it("is interactive iff exactly one positional (the host)", () => {
    expect(classifyInvocation("ssh", ["host"], true)).toBe("interactive");
    expect(classifyInvocation("ssh", ["user@host"], true)).toBe("interactive");
    // `-p` is a value flag: 2222 is its value, `user@host` is the sole positional.
    expect(classifyInvocation("ssh", ["-p", "2222", "user@host"], true)).toBe("interactive");
    expect(classifyInvocation("ssh", ["-i", "key.pem", "host"], true)).toBe("interactive");
    // A remote command is a 2nd positional ⇒ plain.
    expect(classifyInvocation("ssh", ["host", "uptime"], true)).toBe("plain");
    // No host at all ⇒ zero positionals ⇒ plain.
    expect(classifyInvocation("ssh", ["-v"], true)).toBe("plain");
  });

  it("degrades an exotic (untabled) value flag to plain", () => {
    // `-W` is a real ssh value flag but NOT in SSH_VALUE_FLAGS: its value `dst:port` is counted as a
    // positional, so with a real host that is 2 positionals ⇒ plain (never wrongly interactive).
    expect(classifyInvocation("ssh", ["-W", "dst:port", "host"], true)).toBe("plain");
  });
});

describe("interactivePrograms stdin signal (trmx-159)", () => {
  it("forces plain for every listed spelling when stdin is not a tty", () => {
    expect(classifyInvocation("claude", [], false)).toBe("plain");
    expect(classifyInvocation("python", [], false)).toBe("plain");
    expect(classifyInvocation("ssh", ["host"], false)).toBe("plain");
    expect(classifyInvocation("psql", ["mydb"], false)).toBe("plain");
    // Even undefined args ⇒ a false stdin still forces plain.
    expect(classifyInvocation("claude", undefined, false)).toBe("plain");
  });
});

describe("interactivePrograms DB shells (trmx-159)", () => {
  it("psql is interactive unless -c/-f", () => {
    expect(classifyInvocation("psql", ["mydb"], true)).toBe("interactive");
    expect(classifyInvocation("psql", ["-c", "SELECT 1"], true)).toBe("plain");
    expect(classifyInvocation("psql", ["mydb", "-f", "x.sql"], true)).toBe("plain");
    expect(classifyInvocation("psql", ["--command=SELECT 1"], true)).toBe("plain");
  });

  it("mysql is interactive unless -e/--execute", () => {
    expect(classifyInvocation("mysql", ["mydb"], true)).toBe("interactive");
    expect(classifyInvocation("mysql", ["-e", "SELECT 1"], true)).toBe("plain");
    expect(classifyInvocation("mysql", ["--execute=SELECT 1"], true)).toBe("plain");
  });

  it("sqlite3 is interactive with <=1 positional, plain with an SQL 2nd positional", () => {
    expect(classifyInvocation("sqlite3", ["app.db"], true)).toBe("interactive");
    expect(classifyInvocation("sqlite3", [], true)).toBe("interactive");
    expect(classifyInvocation("sqlite3", ["app.db", "SELECT 1"], true)).toBe("plain");
  });

  it("redis-cli / mongosh use the default shape rule", () => {
    expect(classifyInvocation("redis-cli", [], true)).toBe("interactive");
    expect(classifyInvocation("redis-cli", ["GET", "key"], true)).toBe("plain");
    expect(classifyInvocation("mongosh", [], true)).toBe("interactive");
    expect(classifyInvocation("mongosh", ["script.js"], true)).toBe("plain");
  });
});

describe("interactivePrograms partial-metadata fail-safes (trmx-159)", () => {
  it("with args unknown, an AI CLI is interactive and a REPL is plain", () => {
    expect(classifyInvocation("claude", undefined, true)).toBe("interactive");
    expect(classifyInvocation("claude", undefined, undefined)).toBe("interactive");
    expect(classifyInvocation("python", undefined, true)).toBe("plain");
    expect(classifyInvocation("psql", undefined, undefined)).toBe("plain");
  });

  it("with an unknown name, always plain", () => {
    expect(classifyInvocation(undefined, undefined, true)).toBe("plain");
    expect(classifyInvocation("totally-unknown", undefined, true)).toBe("plain");
  });
});
