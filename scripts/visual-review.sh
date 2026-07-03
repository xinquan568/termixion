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
#   scripts/visual-review.sh capture [out-dir] [app-path]
#       Guided capture of all six themes. Resolves + opens the packaged app (default
#       target/debug/bundle/macos/Termixion.app), then for each theme the operator switches
#       Termixion's theme (Settings → Appearance) and clicks the Termixion window; the shot lands
#       in <out-dir>/<theme>.png (default docs/design/visual-baseline/). macOS-only; interactive
#       (needs a TTY); needs the Screen Recording permission for the invoking terminal.
#       Capture is by window CLICK (`screencapture -w`), deliberately: the Tauri app is not
#       AppleScript-scriptable, so there is no reliable CGWindowID to feed `screencapture -l`;
#       the click IS the window selection. Keep the window at the REFERENCE SIZE — 1280×800
#       logical points (docs/design/visual-baseline.md §5) — for all six shots (resize once
#       before the first capture; the script reminds you and verifies shot dimensions match).
#
# The packaged app to review is the debug bundle:
#   (cd crates/termixion-tauri && cargo tauri build --debug)
#   open target/debug/bundle/macos/Termixion.app
# No pixel-diff CI gate on purpose — font rendering makes it flaky (see the issue); the gate is
# this documented protocol plus the PR screenshot set.
set -euo pipefail

THEMES=(white paper mint sepia night solarized)
# The reference window size (logical points) every shot must share — doc §5. Shots are compared
# across themes and releases; a drifting size invalidates the set.
REF_W=1280
REF_H=800

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
  local app="${2:-target/debug/bundle/macos/Termixion.app}"
  if [[ "$(uname)" != "Darwin" ]]; then
    echo "visual-review: capture needs macOS (screencapture). Run the manual protocol from" >&2
    echo "docs/design/visual-baseline.md §5 instead." >&2
    exit 1
  fi
  command -v screencapture >/dev/null || { echo "visual-review: screencapture not found" >&2; exit 1; }
  if [[ ! -e /dev/tty ]] || ! { true </dev/tty; } 2>/dev/null; then
    echo "visual-review: no interactive TTY — capture is operator-guided by design (window" >&2
    echo "click selects the non-scriptable Tauri window). Re-run from a real terminal session," >&2
    echo "or follow the manual protocol in docs/design/visual-baseline.md §5." >&2
    exit 1
  fi
  if [[ ! -e "$app" ]]; then
    echo "visual-review: app not found at '$app' — build it first:" >&2
    echo "  (cd crates/termixion-tauri && cargo tauri build --debug)" >&2
    exit 1
  fi
  open "$app"
  mkdir -p "$out_dir"
  echo "Capture protocol (docs/design/visual-baseline.md §5):"
  echo "  1. Resize the Termixion window ONCE to the reference ${REF_W}x${REF_H} (logical points)"
  echo "     and keep it for all shots."
  echo "  2. Inside Termixion run: scripts/visual-review.sh content"
  echo "  3. For each theme below: switch it in Settings → Appearance, then click the window."
  echo
  local theme shot dims first_dims=""
  for theme in "${THEMES[@]}"; do
    shot="$out_dir/$theme.png"
    read -r -p "Theme '$theme' active? Press Enter, then CLICK the Termixion window… " _ </dev/tty
    if ! screencapture -wo "$shot"; then
      echo "visual-review: capture failed for '$theme' — check the Screen Recording permission" >&2
      exit 1
    fi
    [[ -s "$shot" ]] || { echo "visual-review: empty capture for '$theme' (permission denied?)" >&2; exit 1; }
    # Same-size check: pixel dims are REF × backing scale (2x retina → 2560x1600); what must not
    # drift is shot-to-shot consistency, so pin every shot to the first one's dimensions.
    dims="$(sips -g pixelWidth -g pixelHeight "$shot" 2>/dev/null | awk '/pixel/ {printf "%sx", $2}')"
    if [[ -z "$first_dims" ]]; then
      first_dims="$dims"
      echo "  captured $shot ($dims — the set's reference; target window ${REF_W}x${REF_H} pt)"
    elif [[ "$dims" != "$first_dims" ]]; then
      echo "visual-review: '$theme' shot is $dims but the set started at $first_dims —" >&2
      echo "the window was resized mid-run; redo the set at one fixed size (doc §5)." >&2
      exit 1
    else
      echo "  captured $shot ($dims)"
    fi
  done
  echo "Done: ${#THEMES[@]} captures in $out_dir/"
}

case "${1:-}" in
  content) content ;;
  capture) shift; capture "$@" ;;
  *) grep '^#' "$0" | sed -n '3,25p' | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
