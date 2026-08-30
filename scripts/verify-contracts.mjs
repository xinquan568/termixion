#!/usr/bin/env node
// SPDX-License-Identifier: ISC
// trmx-254: prove the orchestration hooks in app/src/app/ own nothing they were not given.
//
// The rule the refactor rests on is "the composition root owns every useState, every useRef and
// every useEffect; the hooks are pure logic over values passed in". That rule is invisible to the
// type checker: a hook could import App.tsx, or reach for a mutable module-scope value, and still
// compile. This gate makes those two things fail.
//
// Reference CLASSES — only the last two are errors. An earlier spec failed on "every free reference
// not in the parameter list", which would have fired on every legitimately imported helper.
//
//   parameter bindings, locals, same-file module constants ....... pass
//   type-only references ......................................... pass
//   standard-library / platform globals .......................... pass
//   declared imports resolving to a legal lower zone .............. pass
//   import resolving to a ROOT file or an illegal upward zone ..... FAIL   (every module)
//   useState / useRef / useEffect declared in a use*.ts HOOK ...... FAIL   (hooks only)
//
// The React-ownership check is scoped to `use*.ts` deliberately. §0's rule is about the
// orchestration HOOKS; a leaf view component may legitimately own local state — `PaneBadgeInput` in
// AppView.tsx is a controlled input and held its own `value` long before this refactor. Applying the
// rule to every file in app/ would flag correct React and teach people to disable the gate.
import { createRequire } from "node:module";
// Resolved from app/, where TypeScript is a devDependency — the repo root has no direct copy.
const ts = createRequire(new URL("../app/package.json", import.meta.url))("typescript");
import { readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "app/src/app";
const LEVEL = { assets:0, ipc:0, keys:0, ui:0, test:0, panes:1, scripts:1, smoke:1, theme:1,
                store:2, startup:3, tabs:3, terminal:3, update:3,
                chrome:4, commands:4, conformance:4, perf:4, search:4, settings:4, control:5, app:6 };

const files = readdirSync(DIR).filter((f) => /\.tsx?$/.test(f) && !f.endsWith(".test.ts"));
const program = ts.createProgram(files.map((f) => join(DIR, f)),
  { jsx: ts.JsxEmit.ReactJSX, allowJs: true, noResolve: true, target: ts.ScriptTarget.ES2022 });
const errors = [];

for (const f of files) {
  const sf = program.getSourceFile(join(DIR, f));
  if (!sf) continue;
  const line = (p) => sf.getLineAndCharacterOfPosition(p).line + 1;

  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    if (!spec.startsWith(".")) continue;                       // package import — fine
    const rootFile = /^\.\.\/[A-Za-z][\w.]*$/.test(spec);      // ../App, ../surface, ../main
    const zone = /^\.\.\/([a-z]+)\//.exec(spec)?.[1];
    if (rootFile) {
      errors.push(`${f}:${line(st.getStart(sf))}  imports a ROOT file (${spec}) — app/ is L6; the gate forbids directory->root`);
    } else if (zone && zone in LEVEL && LEVEL[zone] > LEVEL.app) {
      errors.push(`${f}:${line(st.getStart(sf))}  imports UP into ${zone}/ (L${LEVEL[zone]}) from app/ (L6)`);
    }
  }

  // React ownership — HOOK modules only (see the header note).
  if (!/^use[A-Z].*\.ts$/.test(f)) continue;
  (function walk(n) {
    if (ts.isCallExpression(n)) {
      const callee = n.expression.getText(sf);
      if (callee === "useState" || callee === "useRef" || callee === "useEffect") {
        errors.push(`${f}:${line(n.getStart(sf))}  declares ${callee}() — the composition root owns state, refs and effects`);
      }
    }
    ts.forEachChild(n, walk);
  })(sf);
}

if (errors.length) {
  console.error("verify-contracts: FAILED\n" + errors.map((e) => "    " + e).join("\n"));
  process.exit(1);
}
const hooks = files.filter((f) => /^use[A-Z].*\.ts$/.test(f));
console.log(
  `verify-contracts: OK — ${files.length} modules in ${DIR}/ import only downward; ` +
    `${hooks.length} use*.ts hooks own no state, refs or effects.`,
);
