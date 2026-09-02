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

  // Review finding 3: the first version matched only a bare Identifier on the left of an assignment
  // and a bare Identifier as a mutating call's receiver. That is evadable by one indirection — a
  // module-level `const shared = { snapshot: new Map(), configPath: null }` survives it, because
  // `shared.configPath = x` has a PropertyAccessExpression on the left and `shared.snapshot.set(x)`
  // has a PropertyAccessExpression as its receiver. Ten factory-local aliases would then satisfy
  // the structural half while every piece stayed global: a guard passing on appearances, which is
  // exactly what this file exists to prevent.
  //
  // So resolve the ROOT identifier of any access chain and test that instead. `a.b.c[d] = x` and
  // `a.b.c.set(x)` both root at `a`.
  const rootIdentifier = (node: ts.Node): ts.Identifier | undefined => {
    let current: ts.Node = node;
    for (;;) {
      if (ts.isIdentifier(current)) return current;
      if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
        current = current.expression;
        continue;
      }
      if (ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current)) {
        current = current.expression;
        continue;
      }
      return undefined;
    }
  };
  // Second evasion (Step-9 verify): root-resolution alone still misses an ALIAS —
  // `const s = shared; s.snapshot.set(...)` roots at `s`, which is not module-scoped. So first
  // taint every local initialised from a module-scoped root, transitively, and treat a tainted
  // local as the module binding it came from.
  const aliasOf = new Map<string, string>();
  const resolveOwner = (name: string): string | undefined => {
    const seen = new Set<string>();
    let current: string | undefined = name;
    while (current && !seen.has(current)) {
      if (owned.has(current)) return current;
      seen.add(current);
      current = aliasOf.get(current);
    }
    return undefined;
  };
  const collectAliases = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const from = rootIdentifier(node.initializer);
      if (from && from.text !== node.name.text) aliasOf.set(node.name.text, from.text);
    }
    ts.forEachChild(node, collectAliases);
  };
  ts.forEachChild(sf, collectAliases);

  const markIfOwned = (node: ts.Node): void => {
    const root = rootIdentifier(node);
    if (!root) return;
    const owner = resolveOwner(root.text);
    if (owner) mutated.add(owner);
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      // Covers `x = v`, `x.y = v`, `x.y.z += v`, `x[k] = v`.
      markIfOwned(node.left);
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      markIfOwned(node.operand);
    }
    if (ts.isDeleteExpression(node)) {
      markIfOwned(node.expression);
    }
    if (ts.isCallExpression(node)) {
      // The receiver, rooted AND alias-resolved: catches `shared.snapshot.set(...)` and
      // `const s = shared; s.snapshot.set(...)`, not just `snapshot.set(...)`.
      if (ts.isPropertyAccessExpression(node.expression) && MUTATORS.has(node.expression.name.text)) {
        markIfOwned(node.expression.expression);
      }
      // ...and the COMPUTED form `x.snapshot["set"](...)`, which a property-access-only check missed.
      if (
        ts.isElementAccessExpression(node.expression) &&
        node.expression.argumentExpression &&
        ts.isStringLiteralLike(node.expression.argumentExpression) &&
        MUTATORS.has(node.expression.argumentExpression.text)
      ) {
        markIfOwned(node.expression.expression);
      }
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

  // Review finding 3: the audit's first version matched only a bare Identifier on the left of an
  // assignment, and a bare Identifier as a mutating call's receiver — so ONE indirection defeated
  // it. This fixture is that evasion, written to look like a clean extraction: every one of the ten
  // names is a factory-local alias (the structural half passes), while the state itself lives in a
  // module-scoped object mutated through property access.
  const SHARED_STATE_EVASION = [
    "const shared = {",
    "  snapshot: new Map(),",
    "  configPath: null as string | null,",
    "  writeSeq: 0,",
    "};",
    "export function createSettingsRuntime() {",
    "  const snapshot = shared.snapshot;",
    "  const configPath = shared.configPath;",
    "  const writeSeq = shared.writeSeq;",
    "  function set(k: string, v: string) {",
    "    shared.snapshot.set(k, v);",   // mutating call, PropertyAccess receiver
    "    shared.configPath = k;",       // assignment, PropertyAccess LHS
    "    shared.writeSeq += 1;",        // compound assignment through a property
    "    delete (shared as Record<string, unknown>).configPath;",
    "  }",
    "  return { snapshot, configPath, writeSeq, set };",
    "}",
  ].join("\n");

  it("CATCHES the one-indirection evasion: state in a module object, aliased inside the factory", () => {
    const audit = auditModuleState(SHARED_STATE_EVASION, "evasion.ts");
    // `shared` is const and its declaration is module-scoped, so a `let`/`var` check sees nothing
    // and the ten names all appear factory-local. Only root-resolution catches it.
    expect(audit.mutated).toContain("shared");
  });

  it("CATCHES the alias evasion: a factory-local binding that points at the module object", () => {
    // The second evasion the Step-9 verify found. Root-resolution alone misses it, because the
    // chain roots at `s` — a factory-local name.
    const audit = auditModuleState(
      [
        "const shared = { snapshot: new Map(), configPath: null as string | null };",
        "export function createSettingsRuntime() {",
        "  const s = shared;",
        "  const alsoS = s;",           // transitive
        "  const m = shared.snapshot;", // alias of a PROPERTY of the module object
        "  function touch() {",
        "    s.snapshot.set('k', 'v');",
        "    alsoS.configPath = 'x';",
        "    m.clear();",
        "  }",
        "  return { touch };",
        "}",
      ].join("\n"),
      "alias.ts",
    );
    expect(audit.mutated).toContain("shared");
  });

  it("CATCHES a computed mutator call", () => {
    const audit = auditModuleState(
      [
        "const shared = { snapshot: new Map() };",
        "function touch() {",
        "  shared.snapshot['set']('k', 'v');",
        "}",
      ].join("\n"),
      "computed.ts",
    );
    expect(audit.mutated).toContain("shared");
  });

  // WHAT THIS GUARD IS AND IS NOT. It is alias- and root-aware, and the three evasions found in
  // review are pinned above. It is NOT adversary-proof, and claiming otherwise would be the same
  // overstatement it exists to catch: a source-level audit living in the same repo as its subject
  // cannot beat someone editing the file to defeat it — an indirection through a function return,
  // a dynamic property name, or a re-export would all escape. Defeating it now takes DELIBERATE
  // effort, which is the achievable goal: this guards against drift and accident, not sabotage.

  it("roots each mutation form back to the module binding", () => {
    for (const line of [
      "shared.snapshot.set('k', 'v');",           // mutating call via property receiver
      "shared.configPath = 'x';",                 // property assignment
      "shared.writeSeq += 1;",                    // compound property assignment
      "shared.nested.deep.value = 1;",            // deep chain
      "shared.byKey['k'] = 1;",                   // element access
      "delete shared.configPath;",                // delete
    ]) {
      const audit = auditModuleState(
        ["const shared = { snapshot: new Map() };", "function touch() {", "  " + line, "}"].join("\n"),
        "form.ts",
      );
      expect(audit.mutated, line).toContain("shared");
    }
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
