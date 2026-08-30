#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# trmx-254: no absolute filesystem paths in committed source.
#
# This exists because of a real escape. Generating prop types with the TypeScript checker's
# `typeToString` emitted 34 fully-qualified references of the form
# `import("/Users/<me>/.../node_modules/.pnpm/@types+react@19.2.18/.../index").RefObject`.
# They typechecked PERFECTLY on the machine that produced them — the paths existed — and failed on
# every other machine with TS2307. `tsc --noEmit` locally is structurally unable to catch this: the
# thing that makes it wrong is the absence of that path everywhere else.
#
# The check is deliberately NARROW: an absolute path inside a MODULE SPECIFIER or an `import("...")`
# type reference. A flat prohibition on `/Users/...` was the first attempt and it flagged ~50
# legitimate test fixtures (`"/Users/me/project"` as OSC 7 input, config-path literals in Rust unit
# tests). Those are correct code, and a gate that fails correct code is one people learn to skip.
set -euo pipefail
ROOT="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

# /Users/... (macOS), /home/... (Linux), C:\... (Windows) inside TS/TSX/JS/Rust sources.
# `from "/abs"`, `import("/abs")`, `require("/abs")` — and the Windows drive-letter forms.
PATTERN='(from[[:space:]]+"[/]|from[[:space:]]+'"'"'[/]|import\("[/]|import\('"'"'[/]|require\("[/]|from[[:space:]]+"[A-Za-z]:|import\("[A-Za-z]:)'
hits="$(grep -rInE "$PATTERN" \
  --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.js' \
  app/src 2>/dev/null || true)"

if [ -n "$hits" ]; then
  echo "check-no-abs-paths: FAILED — absolute machine paths in committed source:"
  printf '    %s\n' "${hits//$'\n'/$'\n'    }"
  echo "    A path that exists only on one machine typechecks there and nowhere else."
  exit 1
fi
echo "check-no-abs-paths: OK — no absolute module specifiers in app/src."
