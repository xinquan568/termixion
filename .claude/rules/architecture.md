# Termixion architecture rules (A-4)

Load-bearing invariants for the codebase, modeled on ClauDepot's `.claude/rules/` (authority §7.4).
The git hooks in `.claude/hooks/` (install: `scripts/install-hooks.sh`) and CI (E-1) enforce the
machine-checkable ones; the rest are review guidance.

## R1 — Pure-core / thin-shell
`termixion-core` is **platform-agnostic**: the domain model + the PTY/session seam (traits only).
`termixion-platform` holds the platform traits + macOS impls (the only crate allowed `cfg(target_os)`
/ platform crates). `termixion-tauri` and `app/` are thin presentation. Logic lives in the core so it
is unit-testable headless on Linux CI.

## R2 — The core seam (enforced: `scripts/check-core-seam.sh`)
In `termixion-core` non-test code: **no platform `cfg` selectors** (`cfg(target_os|target_family|
target_env|target_arch|target_vendor|target_pointer_width)`, bare `cfg(unix)`/`cfg(windows)`) and **no
`std::os::`**. `cfg(test)` is allowed. (D-1 adds a cargo-metadata forbidden-dependency scan: no
`tauri`, `portable-pty`, `cocoa`/`objc`/`core-foundation`, `libc`, `nix`, `windows*` in core.)

## R3 — No panics in core
No `unwrap()` / `expect()` in `termixion-core` non-test code — return `Result`/`Option`. (Review rule
for now; a clippy lint gate can enforce it later.)

## R4 — ISC headers (enforced: `scripts/check-isc-headers.sh`)
Every new `.rs` / `.ts` / `.tsx` source file starts with `// SPDX-License-Identifier: ISC`. Config
files (`*.json`, `*.js`, `*.toml`, `*.yaml`) are exempt.

## R5 — No secrets (enforced: `scripts/secret-scan.sh`)
Never commit credentials. `.gitignore` blocks `*.p12`/`*.p8`/`*.pem`/`*.key`; the secret-scan also
refuses AWS keys, private-key blocks, and GitHub/Slack tokens in staged content. Signing/notarization
secrets live only as GitHub Actions secrets (P0-2).

## R6 — Conventional commits (enforced: `.claude/hooks/commit-msg`)
`<type>(<scope>): <subject>`, `type ∈ feat|fix|chore|docs|test|refactor|perf|build|ci|style`.

## R7 — One PR per task
Short-lived branch per Execution-Plan task; merge only on green gates + review (the `issue2pr` loop).

## R8 — Test-driven development (fundamental)
We **write tests first**. For every behavioral change follow **RED → GREEN → REFACTOR**:

1. **RED** — write a failing test that specifies the new/changed behavior; run it and confirm it fails
   for the right reason.
2. **GREEN** — implement the minimum to make it pass.
3. **REFACTOR** — clean up with the tests green.

- **No behavioral change merges without a test** that exercises it. Rust: unit `#[cfg(test)]` +
  integration tests; **cross-platform / seam behavior gets golden tests** (e.g. the `termixion-platform`
  real-PTY tests). Frontend: Vitest. Pure data/UI tweaks with no behavior change are exempt; doc/config
  changes are exempt.
- **Enforcement** (modeled on ClauDepot's `tdd-guardian` + rules-flagged-at-review): the **pre-push
  `cargo test`** hook + **CI** (`lint + test + build` must be green) gate test *passage*; the **`issue2pr`
  review loop** verifies a behavioral diff ships with a covering test and flags one that does not.
  "The test was written first" can't be proven from a diff, so the worker's **test-first discipline** is
  the load-bearing part, backed by test-presence + review.

> Enforcement is two-layer: the hooks are the fast local copy; **every load-bearing check is also a
> required CI step (E-1)** so a `--no-verify` bypass still fails the gate.

## R9 — Every change traces to a GitHub issue (`trmx-N`)
Every change ships against a **GitHub issue**, so the what / why / how of each modification is always
recoverable from the issue. Reference an issue by the repo-local id **`trmx-<N>`**, where `<N>` is the
GitHub issue number (e.g. issue #1 → `trmx-1`). Use `trmx-<N>` consistently wherever a change is tracked:

- **branch:** `xinquan568/ai/trmx-<N>-<slug>`
- **run folder:** `runs/trmx-<N>-<slug>/`
- **PR title:** ends with `(trmx-<N>)`
- **PR body:** links the issue with `Closes #<N>` (the real `#N` form is what actually closes the issue;
  `trmx-<N>` is the human-facing label)
- **SUMMARY / docs** for the change reference `trmx-<N>`

One issue per task — pairs with R7 (one PR per task). GitHub shares a single number space for issues and
PRs, so `<N>` accounts for existing PRs too (e.g. after PRs through #24, the next issue is #25 =
`trmx-25`).

**Ownership.** The **maintainer creates the issue up-front** and hands the `<N>` to the implementer; the
implementer works against that number (does not invent issues mid-change).

**Enforcement (machine-checked: `scripts/check-issue-link.sh`).** The `r9-issue-link` CI check
(`.github/workflows/r9-issue-link.yml`) is the authoritative gate — it fails unless the **head branch**,
**PR title**, and **PR body** carry a consistent `trmx-<N>` that links a real issue (`#<N>` must exist and
be an issue, not a PR). It runs on `pull_request_target` from the **protected base branch**, so a PR can't
weaken the gate by editing the script/workflow on its own branch (it never executes PR code — only reads
PR title/body/branch as data). Mark **`R9 trmx-N issue link (required)`** as a required status check in
branch protection for it to gate merges. The `commit-msg` hook runs the same branch check locally for fast
feedback; like every R8/E-1 hook it can be `--no-verify`'d, which is exactly why the CI gate — not the
hook — is the real enforcement.

## R10 — Changelog: curated, user-facing, auto-generated
`CHANGELOG.md` records **user-facing** changes only — `feat` → **Added**, `fix` → **Fixed**, `perf` →
**Changed**, and security fixes (a `fix(security):` / `feat(security):` scope) → **Security** — in
[Keep a Changelog](https://keepachangelog.com) form. A breaking change among those types is flagged
**(breaking)**; **the commit `type` is the in/out decision**, so type a breaking *user-facing* change as
`feat!`/`fix!` to surface it (a breaking change buried in a skipped type like `refactor!` won't appear).
Internal types (`chore`, `ci`, `build`, `test`, `style`, `refactor`, **and `docs`**) are **omitted**;
their full record lives in git history + the linked `trmx-N` issues. It is **auto-generated by git-cliff**
from Conventional Commits (`cliff.toml`) — never hand-edited — so the changelog is a deterministic function
of commit `type` (no manual upkeep, no drift); entries carry their `(trmx-N)` / `(#PR)` from the
squash-merge subject. Regenerate with `git cliff -o CHANGELOG.md`; the release pipeline rolls `Unreleased`
into the tagged version. Curated from the start (alpha).
