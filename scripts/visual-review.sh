#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Termixion visual-review runner (trmx-77 / FR-3.6). Reproduces the locked-baseline screenshot set
# on the reference Mac so the review is re-runnable when new surfaces land (splits v0.0.6, theming
# v0.0.7). Protocol + evidence contract: docs/design/visual-baseline.md §5. Two subcommands:
#
#   scripts/visual-review.sh content
#       Print the checklist content INSIDE the terminal under review (Termixion or iTerm2): an
#       ANSI 16-color table on the theme background, a truecolor gradient, and the attribute row
#       (bold/italic/underline). Pure ANSI escapes — no dependencies.
#
#   scripts/visual-review.sh capture [out-dir]
#       Guided capture of all six themes. For each theme the operator switches Termixion's theme
#       (Settings → Appearance), then clicks the Termixion window; the shot lands in
#       <out-dir>/<theme>.png (default docs/design/visual-baseline/). macOS-only; needs the
#       Screen Recording permission for the invoking terminal (System Settings → Privacy).
#
# The packaged app to review is the debug bundle:
#   (cd crates/termixion-tauri && cargo tauri build --debug)
#   open target/debug/bundle/macos/Termixion.app
# No pixel-diff CI gate on purpose — font rendering makes it flaky (see the issue); the gate is
# this documented protocol plus the PR screenshot set.
set -euo pipefail

THEMES=(white paper mint sepia night solarized)

content() {
  printf '\n== Termixion visual-review checklist content (trmx-77) ==\n\n'
  printf -- '-- 16-color ANSI table (normal / bright) --\n'
  for base in 30 90; do
    for i in 0 1 2 3 4 5 6 7; do
      printf '\033[%dm%s\033[0m ' "$((base + i))" "col$((base + i))"
    done
    printf '\n'
  done
  printf -- '\n-- background row --\n'
  for i in 0 1 2 3 4 5 6 7; do
    printf '\033[%dm  bg%d  \033[0m ' "$((40 + i))" "$i"
  done
  printf '\n\n-- attributes --\n'
  printf '\033[1mbold\033[0m \033[3mitalic\033[0m \033[4munderline\033[0m \033[1;4mbold+underline\033[0m \033[7mreverse\033[0m\n'
  printf -- '\n-- truecolor gradient --\n'
  local col
  for col in $(seq 0 5 255); do
    printf '\033[48;2;%d;%d;%dm \033[0m' "$col" "$((255 - col))" "128"
  done
  printf '\n\n-- prompt + listing (run manually for scrollback realism) --\n'
  printf 'now run:  ls -la && printf "done\\n"\n\n'
}

capture() {
  local out_dir="${1:-docs/design/visual-baseline}"
  if [[ "$(uname)" != "Darwin" ]]; then
    echo "visual-review: capture needs macOS (screencapture). Run the manual protocol from" >&2
    echo "docs/design/visual-baseline.md §5 instead." >&2
    exit 1
  fi
  command -v screencapture >/dev/null || { echo "visual-review: screencapture not found" >&2; exit 1; }
  mkdir -p "$out_dir"
  echo "Capture protocol (docs/design/visual-baseline.md §5):"
  echo "  1. Launch the packaged debug app and run: scripts/visual-review.sh content"
  echo "  2. For each theme below: switch it in Settings → Appearance, then click the window."
  echo
  local theme shot
  for theme in "${THEMES[@]}"; do
    shot="$out_dir/$theme.png"
    read -r -p "Theme '$theme' active? Press Enter, then CLICK the Termixion window… " _ </dev/tty
    if ! screencapture -wo "$shot"; then
      echo "visual-review: capture failed for '$theme' — check the Screen Recording permission" >&2
      exit 1
    fi
    [[ -s "$shot" ]] || { echo "visual-review: empty capture for '$theme' (permission denied?)" >&2; exit 1; }
    echo "  captured $shot"
  done
  echo "Done: ${#THEMES[@]} captures in $out_dir/"
}

case "${1:-}" in
  content) content ;;
  capture) shift; capture "$@" ;;
  *) grep '^#' "$0" | sed -n '3,20p' | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
