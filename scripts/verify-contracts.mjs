#!/usr/bin/env node
// SPDX-License-Identifier: ISC
// trmx-254: prove the orchestration modules under app/src/app/ own nothing they were not given.
//
// The rule the refactor rests on — the composition root owns every useState/useReducer/useRef/
// useEffect, and the hooks are pure logic over values passed in — is invisible to the type checker.
// A hook can import App.tsx, alias `useState`, call `React.useRef`, or close over a mutable
// module-scope binding, and still compile and still pass the whole suite. This makes those fail.
//
// Reference CLASSES. Only the last three are errors; an earlier draft failed on "every free
// reference not in the parameter list", which fires on every legitimately imported helper.
//
//   parameter bindings, locals, same-file CONST module values ...... pass
//   type-only references .......................................... pass
//   standard-library / platform globals ........................... pass
//   declared imports resolving to a legal lower zone ............... pass
//   import resolving to a ROOT file or an upward zone .............. FAIL  (every module)
//   React ownership API called in an ORCHESTRATION module .......... FAIL
//   mutable module-scope binding (`let`/`var`) read by a hook ...... FAIL
//
// Ownership APIs are matched by RESOLVED SYMBOL, not by callee text: `useState`, a renamed import,
// and `React.useState` all resolve to the same declaration in @types/react, so all three are caught.
//
// Orchestration modules are `use*.ts` / `use*.tsx` plus anything listed in ORCHESTRATION_EXTRA.
// AppView.tsx is deliberately NOT one: it is a view module, and `PaneBadgeInput` inside it is a leaf
// controlled input that has owned its local `value` since trmx-90. Flagging correct React would
// teach people to disable the gate.
import { createRequire } from "node:module";
const require_ = createRequire(new URL("../app/package.json", import.meta.url));
const ts = require_("typescript");
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DIR = process.env.VERIFY_CONTRACTS_DIR ?? "app/src/app";
// DEFAULT-DENY. Every module in the zone is orchestration unless it is listed here as a VIEW.
// The first version allowlisted `use*` prefixes, which meant a new file called anything else was
// silently unconstrained — I defeated my own gate with a five-line `helpers.ts`. Inverting it means
// a new module is constrained by default and someone must consciously declare it a view.
const VIEW_MODULES = new Set(["AppView.tsx"]);
const OWNERSHIP = new Set(["useState", "useReducer", "useRef", "useEffect", "useLayoutEffect"]);
const LEVEL = { assets:0, ipc:0, keys:0, ui:0, test:0, panes:1, scripts:1, smoke:1, theme:1,
                store:2, startup:3, tabs:3, terminal:3, update:3,
                chrome:4, commands:4, conformance:4, perf:4, search:4, settings:4, control:5, app:6 };

const isOrchestration = (f) => !VIEW_MODULES.has(f);

// The program is built from the TARGET DIRECTORY only — not the whole app tsconfig. It is faster,
// and it makes a fixture directory behave identically to the real one, which is what lets the
// self-test exercise this script rather than a different code path.
const files = readdirSync(DIR).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
// Parsed, not type-checked. The analysis below is purely syntactic and says so — an earlier version
// created a TypeChecker, never used it, and described itself as "compiler-resolved". Worse, symbol
// resolution actively MISLED here: with `react` unresolvable, `getAliasedSymbol` returns a symbol
// named "unknown", so a resolution-based check silently passed every aliased violation.
const sources = new Map(
  files.map((f) => [f, ts.createSourceFile(
    resolve(DIR, f), readFileSync(resolve(DIR, f), "utf8"), ts.ScriptTarget.ES2022, true,
    f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)]));
const errors = [];

for (const f of files) {
  const sf = sources.get(f);
  if (!sf) { errors.push(`${f}  could not be loaded into the program`); continue; }
  const at = (n) => `${f}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;

  // (a) import direction — every module in the zone
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    if (!spec.startsWith(".")) continue;
    if (/^\.\.\/[A-Za-z][\w.]*$/.test(spec)) {
      errors.push(`${at(st)}  imports a ROOT file (${spec}) — app/ is L6 and may not import root files`);
      continue;
    }
    const zone = /^\.\.\/([a-z]+)\//.exec(spec)?.[1];
    if (zone && zone in LEVEL && LEVEL[zone] > LEVEL.app) {
      errors.push(`${at(st)}  imports UP into ${zone}/ (L${LEVEL[zone]}) from app/ (L6)`);
    }
  }

  if (!isOrchestration(f)) continue;

  // (b) React ownership APIs, matched by resolved symbol (catches aliases and React.useState)
  // (c) mutable module-scope bindings read anywhere in the module
  const mutableModuleScope = new Map();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    const kind = st.declarationList.flags;
    if (kind & ts.NodeFlags.Const) continue;              // const is fine — immutable binding
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name)) mutableModuleScope.set(d.name.text, at(st));
    }
  }

  // FAIL-CLOSED at the IMPORT, not at the call site.
  //
  // Chasing call sites was a losing game: I fixed module-level destructuring and review immediately
  // defeated it with FUNCTION-LOCAL `const { useState: mine } = React`, then `const mine = useState`,
  // then `React["useState"](0)`. Each fix invited the next variant, and a gate that is one clever
  // alias away from silent is worse than no gate, because it is quoted as proof.
  //
  // An orchestration module cannot call a React ownership API without importing it somehow. So the
  // IMPORT is the violation: a value import of `useState`/`useReducer`/`useRef`/`useEffect`/
  // `useLayoutEffect` from react, or a value default/namespace import of react (which hands over the
  // whole surface). TYPE-ONLY imports stay legal — `import type { Dispatch } from "react"` is how
  // these hooks type the setters they receive, and every one of them does it.
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      const from = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : "";
      if (/^react(\/|$)/.test(from)) {
        for (const e of st.exportClause.elements) {
          const orig = (e.propertyName ?? e.name).text;
          if (OWNERSHIP.has(orig)) {
            errors.push(`${at(e)}  re-exports ${orig} from react — an orchestration module may not re-expose a React ownership API`);
          }
        }
      }
    }
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    if (!ts.isStringLiteral(st.moduleSpecifier) || !/^react(\/|$)/.test(st.moduleSpecifier.text)) continue;
    if (st.importClause.isTypeOnly) continue;                       // `import type { ... }` is fine
    const nb = st.importClause.namedBindings;
    if (st.importClause.name) {
      errors.push(`${at(st)}  value-imports React as a default binding — that hands the module every ownership API`);
    }
    if (nb && ts.isNamespaceImport(nb)) {
      errors.push(`${at(st)}  value-imports React as a namespace — that hands the module every ownership API`);
    }
    if (nb && ts.isNamedImports(nb)) {
      for (const e of nb.elements) {
        if (e.isTypeOnly) continue;                                 // `import { type Dispatch }`
        const orig = (e.propertyName ?? e.name).text;
        if (OWNERSHIP.has(orig)) {
          errors.push(`${at(e)}  imports ${orig} from react — the composition root owns state, refs and effects`);
        }
      }
    }
  }

  (function walk(n) {
    // `await import("react")` bypasses the import declarations entirely; the gate cannot see through
    // it, so the dynamic import IS the violation.
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = n.arguments[0];
      if (arg && ts.isStringLiteral(arg) && /^react(\/|$)/.test(arg.text)) {
        errors.push(`${at(n)}  dynamically imports "${arg.text}" — that hides ownership calls from this gate`);
      }
    }
    if (ts.isIdentifier(n) && mutableModuleScope.has(n.text)) {
      const p = n.parent;
      const isDecl = ts.isVariableDeclaration(p) && p.name === n;
      if (!isDecl) {
        errors.push(`${at(n)}  reads the mutable module-scope binding '${n.text}' (declared ${mutableModuleScope.get(n.text)}) — hooks must receive state, not capture it`);
      }
    }
    ts.forEachChild(n, walk);
  })(sf);
}

const hooks = files.filter(isOrchestration);
if (errors.length) {
  console.error("verify-contracts: FAILED\n" + [...new Set(errors)].map((e) => "    " + e).join("\n"));
  process.exit(1);
}
console.log(
  `verify-contracts: OK — ${files.length} modules in ${DIR}/ import only downward; ` +
    `${hooks.length} orchestration modules own no state, refs or effects and capture no mutable module state.`,
);
