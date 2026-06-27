#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Regenerate CHANGELOG.md from Conventional Commits via git-cliff (cliff.toml), trimming the
# trailing blank line git-cliff leaves so `git diff --staged --check` stays happy.
# Install git-cliff: `cargo install git-cliff --version 2.13.1 --locked`.
# Usage: scripts/gen-changelog.sh [git-cliff args...]   e.g. --tag v0.0.1 at release.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
# Capture first so a git-cliff failure aborts the script (set -e); writing via printf afterwards
# would otherwise mask git-cliff's exit status and could overwrite CHANGELOG.md with empty output.
changelog="$(git cliff "$@")"
printf '%s\n' "$changelog" > CHANGELOG.md
echo "CHANGELOG.md regenerated$([ $# -gt 0 ] && echo " (args: $*)")."
