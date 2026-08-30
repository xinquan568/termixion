#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# trmx-254: self-test for verify-contracts.mjs. A gate nobody has watched FAIL is a gate that might
# be checking nothing — this repo has shipped four of those. Each case builds a fixture zone that
# SHOULD be rejected and asserts a non-zero exit; the last asserts the clean case still passes.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fixture() { mkdir -p "$TMP/zone"; printf '%s' "$2" > "$TMP/zone/$1"; }
run()     { VERIFY_CONTRACTS_DIR="$TMP/zone" node scripts/verify-contracts.mjs >"$TMP/out" 2>&1; }
expect_fail() {
  if run; then echo "FAIL: $1 — the gate PASSED something it must reject"; cat "$TMP/out"; exit 1; fi
  grep -q "$2" "$TMP/out" || { echo "FAIL: $1 — wrong reason:"; cat "$TMP/out"; exit 1; }
  echo "ok: $1"; rm -rf "$TMP/zone"
}

fixture useProbe.ts 'import { App } from "../App";
export function useProbe() { return App; }
'
expect_fail "(i) a hook importing a ROOT file is rejected" "imports a ROOT file"

fixture useProbe.ts 'import { useState } from "react";
export function useProbe() { const [n, setN] = useState(0); return { n, setN }; }
'
expect_fail "(ii) a hook declaring its own state is rejected" "imports useState from react"

fixture useProbe.ts 'import { useState as mine } from "react";
export function useProbe() { const [n] = mine(0); return n; }
'
expect_fail "(iii) an ALIASED import is rejected (text matching would miss this)" "imports useState from react"

fixture useProbe.ts 'import * as React from "react";
export function useProbe() { return React.useRef(null); }
'
expect_fail "(iv) a NAMESPACE react import is rejected" "value-imports React as a namespace"

fixture useProbe.ts 'import { useReducer } from "react";
export function useProbe() { return useReducer((s: number) => s, 0); }
'
expect_fail "(v) useReducer counts as ownership, not just useState" "imports useReducer from react"

fixture useProbe.ts 'let cached = 0;
export function useProbe() { return cached + 1; }
'
expect_fail "(vi) capturing a MUTABLE module-scope binding is rejected" "mutable module-scope binding"

fixture useProbe.ts 'export async function useProbe() { const R = await import("react"); return R.useRef(null); }
'
expect_fail "(vii) a DYNAMIC import of react is rejected (it hides the ownership call)" "dynamically imports"

fixture useProbe.ts 'export { useState as useProbe } from "react";
'
expect_fail "(viii) RE-EXPORTING an ownership API is rejected" "re-exports useState"

fixture helpers.ts 'import { useState } from "react";
export function makeThing() { return useState(0); }
'
expect_fail "(ix) default-DENY: a module not named use* is still constrained" "imports useState from react"

fixture useProbe.ts 'import React from "react";
const { useState: mine } = React;
export function useProbe() { return mine(0); }
'
expect_fail "(x) MODULE-LEVEL aliased destructuring off a React namespace is rejected" "value-imports React as a default"

fixture useProbe.ts 'import { useState } from "../store/settingsStore";
export function useProbe() { return useState(); }
'
if ! run; then echo "FAIL: (xii) a same-named import from a NON-React module must NOT be flagged"; cat "$TMP/out"; exit 1; fi
echo "ok: (xi) a same-named helper from a non-React module is NOT a false positive"
rm -rf "$TMP/zone"

fixture useProbe.ts 'import React from "react";
export function useProbe() { const { useState: mine } = React; return mine(0); }
'
expect_fail "(xii) FUNCTION-LOCAL aliased destructuring is rejected" "value-imports React as a default"

fixture useProbe.ts 'import { useState } from "react";
export function useProbe() { const mine = useState; return mine(0); }
'
expect_fail "(xii) indirect assignment (const mine = useState) is rejected" "imports useState from react"

fixture useProbe.ts 'import * as React from "react";
export function useProbe() { return React["useState"](0); }
'
expect_fail "(xiii) element access React[\"useState\"] is rejected" "value-imports React as a namespace"

fixture useProbe.ts 'import { useState as mine } from "react";
export { mine };
'
expect_fail "(xiv) import-then-re-export alias is rejected" "imports useState from react"

fixture useProbe.ts 'import type { Dispatch, SetStateAction } from "react";
export function useProbe(deps: { set: Dispatch<SetStateAction<number>> }) { deps.set(1); }
'
if ! run; then echo "FAIL: (xv) (xvi) a TYPE-ONLY react import must pass — every hook types its setters that way"; cat "$TMP/out"; exit 1; fi
echo "ok: (xvi) a type-only react import passes"
rm -rf "$TMP/zone"

fixture useProbe.ts 'const RATE = 3;
import type { PaneId } from "../panes/layoutTree";
export function useProbe(deps: { paneId: PaneId }) { return deps.paneId * RATE; }
'
if ! run; then echo "FAIL: (vii) the CLEAN case must pass"; cat "$TMP/out"; exit 1; fi
echo "ok: (xvii) a pure hook over injected values, a const and a type-only import passes"

echo "verify-contracts.test: OK (17 cases)."
