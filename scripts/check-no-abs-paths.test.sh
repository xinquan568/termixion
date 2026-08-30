#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# trmx-254: self-test for check-no-abs-paths.sh. The gate exists because a generated absolute-path
# type reference typechecked locally and failed everywhere else; a gate for that must be watched
# failing, and must NOT fail the many legitimate absolute-path STRING fixtures the suite uses.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
probe="app/src/__abs_probe__"
cleanup_probe() { rm -rf "$probe"; }
trap 'cleanup_probe; rm -rf "$TMP"' EXIT

case_fail() { # case_fail <label> <content>
  mkdir -p "$probe"; printf '%s' "$2" > "$probe/p.ts"
  if bash scripts/check-no-abs-paths.sh >"$TMP/out" 2>&1; then
    echo "FAIL: $1 — the gate PASSED something it must reject"; cat "$TMP/out"; exit 1
  fi
  echo "ok: $1"; cleanup_probe
}
case_pass() { # case_pass <label> <content>
  mkdir -p "$probe"; printf '%s' "$2" > "$probe/p.ts"
  if ! bash scripts/check-no-abs-paths.sh >"$TMP/out" 2>&1; then
    echo "FAIL: $1 — the gate REJECTED correct code"; cat "$TMP/out"; exit 1
  fi
  echo "ok: $1"; cleanup_probe
}

case_fail "(i) an absolute import() TYPE reference is rejected (the real trmx-254 escape)" \
  'export type P = import("/Users/x/node_modules/@types/react/index").RefObject<number>;
'
case_fail "(ii) an absolute module specifier is rejected" \
  'import { a } from "/Users/x/pkg";
export const b = a;
'
case_pass "(iii) an absolute path STRING FIXTURE is not flagged (osc7 tests use these)" \
  'export const cwd = "/Users/me/project";
'
case_pass "(iv) a normal relative import is not flagged" \
  'import type { PaneId } from "../panes/layoutTree";
export type P = PaneId;
'
echo "check-no-abs-paths.test: OK (4 cases)."
