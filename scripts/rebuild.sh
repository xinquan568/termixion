#!/usr/bin/env bash
# rebuild.sh (trmx-39) — build the Termixion app bundle and (re)launch it.
#
# Usage: scripts/rebuild.sh [--release] [--no-launch] [--dev]
#   (default)     debug build -> quit any running instance -> launch the fresh .app
#   --release     optimized release build (slower, smaller) instead of debug
#   --no-launch   build only; don't quit/relaunch
#   --dev         run `cargo tauri dev` (hot-reload) instead of building a bundle
#
# Runs `cargo tauri build` from crates/termixion-tauri (where tauri.conf.json lives); the build's
# beforeBuildCommand builds the frontend. Resolves the repo root from the script's own location, so it
# works from any working directory. Requires the `cargo tauri` subcommand (see docs/CONTRIBUTING.md).
set -euo pipefail

# Resolve this script's PHYSICAL directory (following symlinks) so the repo root is found correctly even
# when rebuild.sh is invoked via a symlink from outside the checkout.
src="${BASH_SOURCE[0]}"
while [ -h "$src" ]; do
  dir="$(cd -P "$(dirname "$src")" && pwd)"
  src="$(readlink "$src")"
  [[ "$src" != /* ]] && src="$dir/$src"
done
script_dir="$(cd -P "$(dirname "$src")" && pwd)"
root="$(git -C "$script_dir" rev-parse --show-toplevel)"
profile="debug"
launch=1
dev=0

for arg in "$@"; do
  case "$arg" in
    --release) profile="release" ;;
    --no-launch) launch=0 ;;
    --dev) dev=1 ;;
    -h | --help)
      sed -n '3,8p' "$0"
      exit 0
      ;;
    *)
      echo "rebuild: unknown option '$arg' (try --release | --no-launch | --dev | --help)" >&2
      exit 2
      ;;
  esac
done

cd "$root/crates/termixion-tauri"

# Hot-reload dev server (long-running) — replaces this process, ignores --release/--no-launch.
if [ "$dev" -eq 1 ]; then
  echo "rebuild: cargo tauri dev (hot reload; Ctrl-C to stop)"
  exec cargo tauri dev
fi

if [ "$profile" = "release" ]; then
  cargo tauri build
else
  cargo tauri build --debug
fi

app="$root/target/$profile/bundle/macos/Termixion.app"
[ -d "$app" ] || {
  echo "rebuild: expected bundle not found at $app" >&2
  exit 1
}
echo "rebuild: built $app"

if [ "$launch" -eq 1 ]; then
  # Quit a running instance first (pkill exits non-zero when none match — not an error here).
  if pkill -f 'Termixion.app/Contents/MacOS/termixion' 2>/dev/null; then
    echo "rebuild: quit running instance"
    sleep 1
  fi
  touch "$app" # nudge macOS's icon cache so an updated icon shows
  open "$app"
  echo "rebuild: launched"
fi
