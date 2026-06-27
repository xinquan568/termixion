#!/usr/bin/env bash
# SPDX-License-Identifier: ISC
# Install Termixion git hooks (A-4): point git at .claude/hooks. Run once after cloning.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
git -C "$ROOT" config core.hooksPath .claude/hooks
chmod +x "$ROOT"/.claude/hooks/pre-commit "$ROOT"/.claude/hooks/pre-push "$ROOT"/.claude/hooks/commit-msg
echo "Installed: core.hooksPath = $(git -C "$ROOT" config --get core.hooksPath)"
