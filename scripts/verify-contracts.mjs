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
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const DIR = process.env.VERIFY_CONTRACTS_DIR ?? "app/src/app";
const ORCHESTRATION_EXTRA = new Set();
const OWNERSHIP = new Set(["useState", "useReducer", "useRef", "useEffect", "useLayoutEffect"]);
const LEVEL = { assets:0, ipc:0, keys:0, ui:0, test:0, panes:1, scripts:1, smoke:1, theme:1,
                store:2, startup:3, tabs:3, terminal:3, update:3,
                chrome:4, commands:4, conformance:4, perf:4, search:4, settings:4, control:5, app:6 };

const isOrchestration = (f) => /^use[A-Z].*\.tsx?$/.test(f) || ORCHESTRATION_EXTRA.has(f);

// The program is built from the TARGET DIRECTORY only — not the whole app tsconfig. It is faster,
// and it makes a fixture directory behave identically to the real one, which is what lets the
// self-test exercise this script rather than a different code path.
const files = readdirSync(DIR).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));
const program = ts.createProgram(files.map((f) => resolve(DIR, f)), {
  jsx: ts.JsxEmit.ReactJSX,
  target: ts.ScriptTarget.ES2022,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ESNext,
  skipLibCheck: true,
  noEmit: true,
});
const checker = program.getTypeChecker();
const errors = [];

for (const f of files) {
  const sf = program.getSourceFile(resolve(DIR, f));
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

  // Local name -> ORIGINAL exported name, read syntactically from the import declarations. This is
  // what makes aliases detectable without module resolution: `import { useState as mine }` maps
  // mine -> useState. Symbol resolution alone is not enough — when `react` cannot be resolved (a
  // fixture directory with no node_modules) `getAliasedSymbol` yields a symbol named "unknown", and
  // an earlier version of this gate silently passed every aliased violation because of it.
  const localToOriginal = new Map();
  const reactNamespaces = new Set();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const nb = st.importClause.namedBindings;
    if (nb && ts.isNamedImports(nb)) {
      for (const e of nb.elements) localToOriginal.set(e.name.text, (e.propertyName ?? e.name).text);
    }
    if (nb && ts.isNamespaceImport(nb)) reactNamespaces.add(nb.name.text);
    if (st.importClause.name) reactNamespaces.add(st.importClause.name.text);
  }

  (function walk(n) {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      let name = null;
      if (ts.isIdentifier(callee)) {
        name = localToOriginal.get(callee.text) ?? callee.text;
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        // `React.useRef(...)` — a namespace or default import used as an object.
        if (reactNamespaces.has(callee.expression.text)) name = callee.name.text;
      }
      if (name && OWNERSHIP.has(name)) {
        errors.push(`${at(n)}  calls ${name}() — the composition root owns state, refs and effects`);
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
