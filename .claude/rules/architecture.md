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
