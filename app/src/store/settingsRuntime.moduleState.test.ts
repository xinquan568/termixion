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
      if (
        ts.isNonNullExpression(current) ||
        ts.isParenthesizedExpression(current) ||
        // Casts are routine maintenance, not sabotage: `shared as typeof shared` must not hide the
        // root. Covers `as`, `satisfies`, and the angle-bracket form.
        ts.isAsExpression(current) ||
        ts.isSatisfiesExpression(current) ||
        ts.isTypeAssertionExpression(current)
      ) {
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
  // A name can be bound more than once. Keeping ONE origin — first or last — makes the result
  // order-dependent, and order-dependence is how this analysis under-reported twice: `last wins`
  // let an unrelated shadow erase a real alias, and `first wins` let an unrelated EARLIER binding
  // block one. Keep every origin instead and resolve if ANY of them reaches module scope. That is
  // what makes "can only over-report" a property of the construction rather than of the ordering.
  const aliasOf = new Map<string, Set<string>>();
  const resolveOwner = (name: string): string | undefined => {
    const seen = new Set<string>();
    const queue = [name];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      if (owned.has(current)) return current;
      for (const origin of aliasOf.get(current) ?? []) queue.push(origin);
    }
    return undefined;
  };
  // The alias map is keyed by NAME, which is an approximation — so it must be built to err toward
  // OVER-reporting. An earlier version let a later `const s = somethingLocal` overwrite an existing
  // entry for `s`, which made the audit UNDER-report: a real alias mutation vanished because an
  // unrelated shadow reused the name. That contradicted the whole premise of a name-based analysis.
  // A name that is ever bound to a module-scoped root keeps that origin; a conflicting later
  // binding is ignored rather than allowed to clear it.
  // Four review rounds were spent ENUMERATING binding forms — identifier declarations, then
  // shadowing order, then casts — and each round the next ordinary form escaped: destructuring,
  // reassignment, for-of, catch. Enumerating shapes is the wrong technique for the same reason
  // grepping was the wrong technique for counting: the list is never finished.
  //
  // So stop enumerating. Taint STRUCTURALLY: for any binding or assignment, if a module-scoped
  // root appears ANYWHERE in the right-hand side, every name introduced on the left inherits it.
  // That over-approximates by construction — `const { a } = shared` taints `a` even if `a` is not
  // itself state — which is the safe direction and is what "can only over-report" has to mean.
  const namesBoundBy = (name: ts.BindingName, into: string[]): void => {
    if (ts.isIdentifier(name)) {
      into.push(name.text);
      return;
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) namesBoundBy(element.name, into);
    }
  };
  /**
   * The roots an expression can PROPAGATE A REFERENCE from — not every identifier it mentions.
   * That distinction is the whole difference between a usable guard and a useless one: walking the
   * entire subtree flagged `Object.keys(SETTING_KEYS)` as aliasing SETTING_KEYS, so the audit
   * reported the real settingsStore.ts as dirty. So calls are treated as OPAQUE. That is a stated
   * precision boundary, not a claim about semantics: a call can perfectly well return an existing
   * reference (a getter, an identity helper, `array.at(0)`), and following that would need
   * return-value tracking this guard does not do. Aliasing is followed through a direct reference,
   * a literal that wraps one (including shorthand and spread), or a choice between them — and
   * nothing else here.
   */
  const rootsWithin = (node: ts.Node): string[] => {
    const direct = rootIdentifier(node);
    if (direct) {
      if (owned.has(direct.text) || aliasOf.has(direct.text)) return [direct.text];
      return [];
    }
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.flatMap((element) =>
        ts.isSpreadElement(element) ? rootsWithin(element.expression) : rootsWithin(element),
      );
    }
    if (ts.isObjectLiteralExpression(node)) {
      // `{ shared }` is `{ shared: shared }`; `{ ...shared }` copies every nested reference.
      return node.properties.flatMap((property) => {
        if (ts.isPropertyAssignment(property)) return rootsWithin(property.initializer);
        if (ts.isShorthandPropertyAssignment(property)) return rootsWithin(property.name);
        if (ts.isSpreadAssignment(property)) return rootsWithin(property.expression);
        return [];
      });
    }
    if (ts.isConditionalExpression(node)) {
      return [...rootsWithin(node.whenTrue), ...rootsWithin(node.whenFalse)];
    }
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    ) {
      return [...rootsWithin(node.left), ...rootsWithin(node.right)];
    }
    return [];
  };
  const taint = (targets: string[], from: ts.Node): void => {
    const origins = rootsWithin(from);
    if (origins.length === 0) return;
    for (const target of targets) {
      if (origins.includes(target) && origins.length === 1) continue; // self-reference
      const set = aliasOf.get(target) ?? new Set<string>();
      for (const origin of origins) if (origin !== target) set.add(origin);
      if (set.size > 0) aliasOf.set(target, set);
    }
  };
  // Aliases can be introduced after their use site, and a chain can be built in any order, so
  // alias collection runs to a fixed point (below) rather than assuming source order.
  const collectAliases = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const names: string[] = [];
      namesBoundBy(node.name, names);
      taint(names, node.initializer);
    }
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsToken ||
        // `s ??= shared`, `s ||= shared`, `s &&= shared` bind a reference exactly as `=` does.
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken)
    ) {
      const names: string[] = [];
      if (ts.isIdentifier(node.left)) names.push(node.left.text);
      else if (ts.isObjectLiteralExpression(node.left) || ts.isArrayLiteralExpression(node.left)) {
        // destructuring ASSIGNMENT: ({ snapshot } = shared)
        const walk = (n: ts.Node): void => {
          if (ts.isIdentifier(n)) names.push(n.text);
          ts.forEachChild(n, walk);
        };
        walk(node.left);
      }
      if (names.length > 0) taint(names, node.right);
    }
    if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      const names: string[] = [];
      if (ts.isVariableDeclarationList(node.initializer)) {
        for (const decl of node.initializer.declarations) namesBoundBy(decl.name, names);
      } else if (ts.isIdentifier(node.initializer)) {
        names.push(node.initializer.text);
      }
      taint(names, node.expression);
    }
    if (ts.isTryStatement(node) && node.catchClause?.variableDeclaration) {
      // `try { throw shared } catch (s)`: the catch binding IS whatever the block threw. Every
      // `throw` in the block is a candidate origin — over-approximate, as everywhere here.
      const names: string[] = [];
      namesBoundBy(node.catchClause.variableDeclaration.name, names);
      const throws = (n: ts.Node): void => {
        if (ts.isThrowStatement(n)) taint(names, n.expression);
        ts.forEachChild(n, throws);
      };
      throws(node.tryBlock);
    }
    ts.forEachChild(node, collectAliases);
  };
  // A TRUE fixed point. `taint` only ever ADDS (name, origin) pairs and the set of possible pairs
  // is finite, so the first pass that adds nothing is the fixed point and the loop needs no cap.
  // The previous version stopped after six passes and called that a fixed point; a chain built in
  // reverse source order needs one pass per link, so its seventh link escaped. Progress is
  // measured in pairs because pairs are the quantity `taint` grows; a key count happened to
  // suffice, but only by an argument about which passes can add keys.
  const pairCount = (): number => {
    let n = 0;
    for (const origins of aliasOf.values()) n += origins.size;
    return n;
  };
  for (;;) {
    const before = pairCount();
    ts.forEachChild(sf, collectAliases);
    if (pairCount() === before) break;
  }

  const markIfOwned = (node: ts.Node): void => {
    const root = rootIdentifier(node);
    if (!root) return;
    const owner = resolveOwner(root.text);
    if (owner) mutated.add(owner);
  };

  /** Parameter indices of a file-local function whose body mutates that parameter. */
  const mutatingParamsOf = (fnName: string): Set<number> | undefined => {
    // Helpers are not always top-level function declarations: `const wipe = (m) => m.clear()` and
    // nested declarations are ordinary. Search the whole file for any function-like bound to this
    // name, rather than only the top-level statement list.
    let fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined;
    const findFn = (n: ts.Node): void => {
      if (fn) return;
      if (ts.isFunctionDeclaration(n) && n.name?.text === fnName) fn = n;
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === fnName &&
        n.initializer &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
      ) {
        fn = n.initializer;
      }
      ts.forEachChild(n, findFn);
    };
    ts.forEachChild(sf, findFn);
    // A concise arrow body (`(m) => m.clear()`) is an expression, not a block; scan either.
    if (!fn?.body) return undefined;
    const params = fn.parameters.map((param) =>
      ts.isIdentifier(param.name) ? param.name.text : undefined,
    );
    const hit = new Set<number>();
    const scan = (n: ts.Node): void => {
      const flag = (target: ts.Node) => {
        const r = rootIdentifier(target);
        const i = r ? params.indexOf(r.text) : -1;
        if (i >= 0) hit.add(i);
      };
      if (
        ts.isBinaryExpression(n) &&
        n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        n.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      ) {
        flag(n.left);
      }
      if (
        (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
        (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
      ) {
        flag(n.operand);
      }
      if (ts.isDeleteExpression(n)) {
        flag(n.expression);
      }
      if (ts.isCallExpression(n)) {
        if (ts.isPropertyAccessExpression(n.expression) && MUTATORS.has(n.expression.name.text)) {
          flag(n.expression.expression);
        }
        if (
          ts.isElementAccessExpression(n.expression) &&
          n.expression.argumentExpression &&
          ts.isStringLiteralLike(n.expression.argumentExpression) &&
          MUTATORS.has(n.expression.argumentExpression.text)
        ) {
          flag(n.expression.expression);
        }
      }
      ts.forEachChild(n, scan);
    };
    scan(fn.body);
    return hit.size > 0 ? hit : undefined;
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
    // A module-rooted value handed to a helper ESCAPES: `clearMap(shared.snapshot)` mutates it just
    // as surely as `shared.snapshot.clear()`, and extracting a helper is ordinary maintenance. One
    // level is tracked — the callee must be a function declared in this file whose body mutates the
    // matching parameter. Deeper chains are not followed; that limit is stated below.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = mutatingParamsOf(node.expression.text);
      if (callee) {
        node.arguments.forEach((arg, index) => {
          if (callee.has(index)) markIfOwned(arg);
        });
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

  // Step-9 verify, iteration 2: three forms that arise in ORDINARY maintenance, not sabotage — so
  // the adversary-resistance disclaimer below never covered them.
  it.each([
    [
      "a cast alias",
      [
        "const shared = { snapshot: new Map() };",
        "function touch() {",
        "  const s = shared as typeof shared;",
        "  s.snapshot.clear();",
        "}",
      ],
    ],
    [
      "an unrelated later binding that SHADOWS the alias name",
      [
        "const shared = { snapshot: new Map() };",
        "function first() {",
        "  const s = shared;",
        "  s.snapshot.clear();",
        "}",
        "function second() {",
        "  const local = { snapshot: new Map() };",
        "  const s = local;",          // must NOT erase `s -> shared`
        "  s.snapshot.clear();",
        "}",
      ],
    ],
    [
      "a helper that mutates its parameter",
      [
        "const shared = { snapshot: new Map() };",
        "function clearMap(m: Map<string, string>) {",
        "  m.clear();",
        "}",
        "function touch() {",
        "  clearMap(shared.snapshot);",
        "}",
      ],
    ],
  ])("CATCHES %s", (_label, lines) => {
    const audit = auditModuleState((lines as string[]).join("\n"), "maintenance.ts");
    expect(audit.mutated).toContain("shared");
  });

  // Step-9 verify iteration 3. The previous over-reporting fixture tested only ONE ordering — the
  // one I expected to work — so "first wins" passed it while still under-reporting the reverse.
  // Both orderings are pinned now, because the property must hold regardless of source order.
  // Step-9 verify iteration 4. Enumerating binding FORMS failed four rounds running, so alias
  // collection is now structural: any binding or assignment whose right-hand side propagates a
  // reference taints every name it introduces. These are the forms that escaped the enumeration.
  it.each([
    ["destructuring", "const { snapshot } = shared;", "snapshot.clear();"],
    ["nested destructuring", "const { inner: { m } } = shared;", "m.clear();"],
    ["array destructuring", "const [first] = [shared];", "first.snapshot.clear();"],
    ["reassignment", "let s; s = shared;", "s.snapshot.clear();"],
    ["destructuring assignment", "let snapshot; ({ snapshot } = shared);", "snapshot.clear();"],
    ["for-of over a literal", "for (const s of [shared]) {", "s.snapshot.clear(); }"],
    ["nullish choice", "const s = shared ?? shared;", "s.snapshot.clear();"],
    ["conditional choice", "const s = 1 > 0 ? shared : shared;", "s.snapshot.clear();"],
  ])("CATCHES an alias introduced by %s", (_label, bind, use) => {
    const audit = auditModuleState(
      [
        "const shared = { snapshot: new Map<string, string>(), inner: { m: new Map<string, string>() } };",
        "function touch() {",
        "  " + bind,
        "  " + use,
        "}",
      ].join("\n"),
      "binding-forms.ts",
    );
    expect(audit.mutated).toContain("shared");
  });

  it("CATCHES a helper that is an arrow function, not a declaration", () => {
    const audit = auditModuleState(
      [
        "const shared = { snapshot: new Map<string, string>() };",
        "const wipe = (m: Map<string, string>) => { m.clear(); };",
        "function touch() { wipe(shared.snapshot); }",
      ].join("\n"),
      "arrow-helper.ts",
    );
    expect(audit.mutated).toContain("shared");
  });

  it("treats a CALL as OPAQUE — a stated precision boundary, not a claim that calls return something new", () => {
    // The over-approximation has to stop somewhere or the guard reports the real file as dirty:
    // walking whole subtrees flagged `Object.keys(SETTING_KEYS)` as aliasing SETTING_KEYS. A call
    // CAN return an existing reference; this guard simply does not follow return values.
    const audit = auditModuleState(
      [
        "const registry = { a: 1 };",
        "function touch() {",
        "  const copy = Object.keys(registry);",
        "  copy.push('x');",
        "}",
      ].join("\n"),
      "no-call-taint.ts",
    );
    expect(audit.mutated).not.toContain("registry");
  });

  it.each([
    ["module origin SECOND", ["function a(input: { snapshot: Map<string, string> }) { const s = input; s.snapshot.clear(); }", "function b() { const s = shared; s.snapshot.clear(); }"]],
    ["module origin FIRST", ["function b() { const s = shared; s.snapshot.clear(); }", "function a(input: { snapshot: Map<string, string> }) { const s = input; s.snapshot.clear(); }"]],
  ])("over-reports regardless of binding order (%s)", (_label, body) => {
    const audit = auditModuleState(
      ["const shared = { snapshot: new Map<string, string>() };", ...(body as string[])].join("\n"),
      "order.ts",
    );
    expect(audit.mutated).toContain("shared");
  });

  // The helper scanner must recognise the SAME mutation forms as the outer visitor. It previously
  // saw only assignments and dot-form mutator calls, so these three ordinary forms escaped — a
  // narrower coverage than the "one level" the file claimed.
  it.each([
    ["increment", "function bump(x: { n: number }) { x.n++; }", "bump(shared.counter);"],
    ["delete", "function drop(x: Record<string, unknown>) { delete x.k; }", "drop(shared.bag);"],
    ["computed mutator", "function wipe(x: Map<string, string>) { x['clear'](); }", "wipe(shared.snapshot);"],
  ])("CATCHES a helper that mutates its parameter by %s", (_label, helper, call) => {
    const audit = auditModuleState(
      [
        "const shared = { snapshot: new Map<string, string>(), counter: { n: 0 }, bag: {} as Record<string, unknown> };",
        helper as string,
        "function touch() {",
        "  " + (call as string),
        "}",
      ].join("\n"),
      "helper-forms.ts",
    );
    expect(audit.mutated).toContain("shared");
  });

  it("errs toward OVER-reporting: shadowing never erases a known alias", () => {
    // The failure the verify found was UNDER-reporting, which a name-keyed analysis must never do.
    const audit = auditModuleState(
      [
        "const shared = { snapshot: new Map() };",
        "function a() { const s = shared; s.snapshot.clear(); }",
        "function b() { const other = { snapshot: new Map() }; const s = other; s.snapshot.clear(); }",
      ].join("\n"),
      "shadow.ts",
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

  // Step-9 verify iteration 5 (the loop cap). Four more ORDINARY forms, plus one structural defect
  // in the alias loop itself. Each fixture below fails with ONLY its own fix reverted — checked by
  // neutering the fixes one at a time — so none of them rides on another's.
  it.each([
    ["object shorthand", "const box = { shared };", "box.shared.snapshot.clear();"],
    ["object spread", "const box = { ...shared };", "box.snapshot.clear();"],
    ["array spread", "const arr = [...[shared]];", "arr[0].snapshot.clear();"],
    ["nullish assignment", "let s; s ??= shared;", "s.snapshot.clear();"],
    ["or-assignment", "let s; s ||= shared;", "s.snapshot.clear();"],
    ["and-assignment", "let s = 1 as unknown; s &&= shared;", "s.snapshot.clear();"],
    ["a catch binding", "try { throw shared; } catch (s) {", "s.snapshot.clear(); }"],
  ])("CATCHES an alias introduced by %s", (_label, bind, use) => {
    const audit = auditModuleState(
      [
        "const shared = { snapshot: new Map<string, string>() };",
        "function touch() {",
        "  " + bind,
        "  " + use,
        "}",
      ].join("\n"),
      "binding-forms-2.ts",
    );
    expect(audit.mutated).toContain("shared");
  });

  it("CATCHES a concise-body arrow helper — the form the helper scanner's own comment used as its example", () => {
    const audit = auditModuleState(
      [
        "const shared = { snapshot: new Map<string, string>() };",
        "const wipe = (m: Map<string, string>) => m.clear();",
        "function touch() { wipe(shared.snapshot); }",
      ].join("\n"),
      "concise-arrow-helper.ts",
    );
    expect(audit.mutated).toContain("shared");
  });

  it("runs alias collection to a TRUE fixed point: an out-of-order chain longer than any pass cap", () => {
    // The previous loop stopped after six passes and called that a fixed point. A chain built in
    // reverse source order needs one pass per link, so a seven-link chain escaped. Twelve links
    // here, so no "big enough" constant can pass this by accident.
    //
    // The chain is built from DECLARATIONS, deliberately. Written as `let` + assignments it passed
    // against the capped loop for an incidental reason: the mutation visitor treats an assignment
    // whose left side is an alias as a write to the module binding, so `l0 = shared` alone flagged
    // `shared` and the chain never had to resolve. Reverse-order `const`s (a parse-only fixture —
    // at runtime that order is a temporal-dead-zone error) leave the alias loop as the only path.
    const links = 12;
    const names = Array.from({ length: links }, (_, i) => `l${i}`);
    const lines = [
      "const shared = { snapshot: new Map<string, string>() };",
      "function touch() {",
    ];
    for (let i = links - 1; i >= 1; i -= 1) lines.push(`  const ${names[i]} = ${names[i - 1]};`);
    lines.push(`  const ${names[0]} = shared;`);
    lines.push(`  ${names[links - 1]}.snapshot.clear();`);
    lines.push("}");
    const audit = auditModuleState(lines.join("\n"), "long-chain.ts");
    expect(audit.mutated).toContain("shared");
  });

  // WHAT THIS GUARD IS AND IS NOT. It is alias- and root-aware, and the three evasions found in
  // review are pinned above — including the CAST, SHADOWING and HELPER-PARAMETER forms, which are
  // ordinary maintenance rather than sabotage and were NOT covered by the disclaimer below when it
  // was first written. It is NOT adversary-proof, and claiming otherwise would be the same
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
