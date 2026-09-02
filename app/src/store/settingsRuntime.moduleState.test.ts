// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//
// trmx-253 (T3.2, test 6 of the plan's strategy table) — THE SOURCE GUARD: settingsStore.ts holds
// no operational module-scoped mutable state.
//
// Why this cannot be a symbol-absence check. `expect(source).not.toContain("let configPath")`
// passes while the other nine pieces are still module-global; a check that a partial extraction
// satisfies is not a guard, it is decoration. This one PARSES the file (the TypeScript compiler's
// own AST — never a line-oriented text scan, per the run's counting rule) and asks two structural
// questions instead:
//
//   A. Is any module-scoped binding mutable? `let`/`var` at module scope, or a `const` that is
//      assigned to or mutated through a container method anywhere in the file. That is what
//      "operational state" means in a module that also legitimately holds a big enumerable
//      REGISTRY of frozen-in-practice constants — SETTING_DEFAULTS and STORAGE_KEYS are values
//      the module never writes; `snapshot` and `configPath` were values it wrote on every keystroke.
//   B. Is each of the ten named pieces declared INSIDE createSettingsRuntime? A negative check
//      alone would pass if a piece were simply deleted or smuggled into another module, so the
//      guard also asserts where each one now lives.
//
// The audit is proved non-vacuous below against a fixture holding the pre-refactor declarations
// verbatim: it must report all ten.
//
// trmx-253 (T3.5): the companion block that bounded the TRANSITIONAL ambient holder
// (settingsRuntimeAmbient.ts — one mutable binding, in the one file named for it) went with that
// file. "Move the global to a neighbouring file" is now blocked by construction rather than by a
// second audit: there is no ambient holder, `useSettingsRuntime()` throws without a provider, and
// nothing but `createSettingsRuntime()` can produce a runtime.
import { describe, expect, it } from "vitest";
import * as ts from "typescript";
import storeSource from "./settingsStore.ts?raw";

/** The ten pieces of module state trmx-253 (T3.2) had to move, named in the frozen plan. */
const TEN_PIECES = [
  "snapshot",
  "clientWarnings",
  "configPath",
  "fileWarnings",
  "writeSeq",
  "writeFailedKeys",
  "configWarningsListeners",
  "configInvoke",
  "busSubscribed",
  "busUnlistens",
] as const;

/** Methods that mutate the container they are called on — how a `const` Map/Set/Array holds state. */
const MUTATORS = new Set([
  "set",
  "delete",
  "clear",
  "add",
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
]);

interface ModuleStateAudit {
  /** Every name bound by a module-scoped variable statement. */
  moduleScopedNames: string[];
  /** Those declared with `let`/`var` — mutable by declaration. */
  letOrVar: string[];
  /** Module-scoped names written to (assignment, ++/--) or mutated through a container method. */
  mutated: string[];
  /** Names declared directly in the body of the named function (here: createSettingsRuntime). */
  namesDeclaredIn(functionName: string): string[];
}

/**
 * Parse `source` and report its module-scoped mutable state. Name-based rather than
 * symbol-resolved: an inner binding that shadows a module name is counted against the module. That
 * is the SAFE direction for a guard — it can over-report, never under-report — and this file has no
 * such shadowing (the ten pieces are no longer module names at all).
 */
function auditModuleState(source: string, fileName = "module.ts"): ModuleStateAudit {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const moduleScopedNames: string[] = [];
  const letOrVar: string[] = [];
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      moduleScopedNames.push(decl.name.text);
      if (!isConst) letOrVar.push(decl.name.text);
    }
  }

  const owned = new Set(moduleScopedNames);
  const mutated = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left) &&
      owned.has(node.left.text)
    ) {
      mutated.add(node.left.text);
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand) &&
      owned.has(node.operand.text)
    ) {
      mutated.add(node.operand.text);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      owned.has(node.expression.expression.text) &&
      MUTATORS.has(node.expression.name.text)
    ) {
      mutated.add(node.expression.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);

  const namesDeclaredIn = (functionName: string): string[] => {
    const fn = sf.statements.find(
      (s): s is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(s) && s.name?.text === functionName,
    );
    if (!fn?.body) return [];
    const names: string[] = [];
    for (const statement of fn.body.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.push(decl.name.text);
      }
    }
    return names;
  };

  return { moduleScopedNames, letOrVar, mutated: [...mutated], namesDeclaredIn };
}

// The pre-refactor block, copied verbatim from settingsStore.ts before T3.2 (comments stripped),
// plus one mutation site per piece. If the audit cannot see state HERE it cannot see it anywhere,
// and the assertions above it would be worthless.
const PRE_REFACTOR_FIXTURE = `
const snapshot = new Map<SettingKey, SettingsValues[SettingKey]>();
let configPath: string | null = null;
let fileWarnings: ConfigWarningItem[] = [];
const clientWarnings = new Map<SettingKey, ConfigWarningItem>();
const writeSeq = new Map<SettingKey, number>();
const writeFailedKeys = new Set<SettingKey>();
const configWarningsListeners = new Set<(items: ConfigWarningItem[]) => void>();
let configInvoke: InvokeFn = realInvoke;
let busSubscribed = false;
const busUnlistens: Array<() => void> = [];

export function __resetSettingsForTest(): void {
  snapshot.clear();
  configPath = null;
  fileWarnings = [];
  clientWarnings.clear();
  writeSeq.clear();
  writeFailedKeys.clear();
  configWarningsListeners.clear();
  configInvoke = realInvoke;
  busSubscribed = false;
  for (const unlisten of busUnlistens.splice(0)) unlisten();
}
`;

describe("trmx-253: the module-state audit itself has teeth", () => {
  it("reports ALL TEN pieces on the pre-refactor source shape", () => {
    const audit = auditModuleState(PRE_REFACTOR_FIXTURE, "settingsStore.pre.ts");
    // Every piece is either mutable by declaration or written through — none is a mere constant.
    const flagged = new Set([...audit.letOrVar, ...audit.mutated]);
    for (const piece of TEN_PIECES) {
      expect(flagged.has(piece), `audit missed module state: ${piece}`).toBe(true);
    }
    expect(audit.letOrVar.sort()).toEqual(
      ["busSubscribed", "configInvoke", "configPath", "fileWarnings"].sort(),
    );
  });

  it("does NOT flag an immutable registry constant (the audit is not just 'any module const')", () => {
    // settingsStore.ts legitimately keeps big module-scope tables. The audit must let those be, or
    // it would be unsatisfiable and would get weakened rather than obeyed.
    const audit = auditModuleState(
      `const SETTING_DEFAULTS = { "a.b": true };\n` +
        `const KEYS = Object.keys(SETTING_DEFAULTS);\n` +
        `export function read(k: string) { return SETTING_DEFAULTS[k] ?? KEYS.length; }\n`,
    );
    expect(audit.letOrVar).toEqual([]);
    expect(audit.mutated).toEqual([]);
  });
});

describe("trmx-253 (T3.2): settingsStore.ts keeps no operational module-scoped mutable state", () => {
  const audit = auditModuleState(storeSource, "settingsStore.ts");

  it("declares no module-scoped `let`/`var` at all", () => {
    expect(audit.letOrVar).toEqual([]);
  });

  it("never writes to, or mutates a container held by, a module-scoped binding", () => {
    // The registry constants stay; what is gone is any module binding the module itself writes.
    expect(audit.mutated).toEqual([]);
  });

  it.each(TEN_PIECES)("no longer holds `%s` at module scope", (piece) => {
    expect(audit.moduleScopedNames).not.toContain(piece);
  });

  it.each(TEN_PIECES)("declares `%s` inside createSettingsRuntime()", (piece) => {
    // The positive half: a piece that was merely deleted, or pushed into a different module, would
    // pass the negative check above. It must be HERE, in the factory's own body.
    expect(audit.namesDeclaredIn("createSettingsRuntime")).toContain(piece);
  });
});

// ------------------------------------------------------------------------------------------------
// trmx-253 (T3.5): the deletions, and the escape hatch they close.
// ------------------------------------------------------------------------------------------------
describe("trmx-253 (T3.5): the pre-M8 facade is gone, and no neighbour holds settings state", () => {
  // Every non-test source file in this directory, read through Vite's raw loader. The old guard
  // bounded ONE named neighbour (settingsRuntimeAmbient.ts) because that file was known to exist;
  // now that it is deleted, the invariant generalises: NOTHING beside settingsStore.ts may hold
  // settings state at module scope either, or the ten pieces could simply move next door.
  const neighbours = import.meta.glob("./*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const sources = Object.entries(neighbours).filter(([path]) => !path.includes(".test."));

  it("no longer ships settingsRuntimeAmbient.ts", () => {
    expect(Object.keys(neighbours)).not.toContain("./settingsRuntimeAmbient.ts");
  });

  it.each(sources.map(([path]) => path))("%s keeps no module-scoped mutable state", (path) => {
    const audit = auditModuleState(neighbours[path], path);
    expect(audit.letOrVar).toEqual([]);
    expect(audit.mutated).toEqual([]);
  });

  it.each([
    "makeLegacyStorageStore",
    "makeSettingsStore",
    "__resetSettingsForTest",
    "hydrateSettings",
    "ambientSettingsRuntime",
    "adoptSettingsRuntime",
  ])("settingsStore.ts declares no `%s`", (name) => {
    // A declaration check, not a text search: the names appear in this file's own prose and in
    // settingsStore.ts's header comment explaining what T3.5 removed, and prose must not be able
    // to fail — or pass — a guard about code.
    const sf = ts.createSourceFile(
      "settingsStore.ts",
      storeSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const declared = sf.statements.flatMap((statement) => {
      if (ts.isFunctionDeclaration(statement)) return statement.name ? [statement.name.text] : [];
      if (ts.isVariableStatement(statement)) {
        return statement.declarationList.declarations.flatMap((d) =>
          ts.isIdentifier(d.name) ? [d.name.text] : [],
        );
      }
      return [];
    });
    expect(declared).not.toContain(name);
  });
});
