# Termixion architecture rules (A-4)

Load-bearing invariants for the codebase, modeled on ClauDepot's `.claude/rules/` (authority §7.4).
The git hooks in `.claude/hooks/` (install: `scripts/install-hooks.sh`) and CI (E-1) enforce the
machine-checkable ones; the rest are review guidance.

**Every rule below names its enforcement in the heading** — a script, a lint, or `review rule`. That
convention exists because five rules once claimed enforcement they did not have (trmx-239); an
unenforced rule should be *visibly* unenforced rather than ambiguously stated. See
[Claims and gates](../../docs/CONTRIBUTING.md#claims-and-gates-trmx-239).

## R1 — Pure-core / thin-shell (partly enforced: `scripts/check-core-seam.sh` gates (a) + (c); the domain-vs-presentation boundary is a review rule)
`termixion-core` is **platform-agnostic**: the domain model + the PTY/session seam (traits only).
Logic lives there so it is unit-testable headless on Linux CI.

**`termixion-platform` owns platform DOMAIN code** — the PTY backend, clipboard, foreground-process
resolution, and uid/mode/socket primitives — and is the only crate that may DECLARE a platform crate
(`libc`, `nix`, `objc*`, `cocoa*`) as a normal dependency.

**`termixion-tauri` and `app/` are thin presentation.** The shell MAY use `std::os` and
platform-gated *presentation* APIs behind `#[cfg(target_os = …)]` — window chrome, Services
registration — because that is what a presentation layer for one platform is. What it may NOT do is
carry platform domain logic or declare a platform crate to reach it; that belongs behind the seam.

trmx-239 (M12) narrowed this rule and made part of it checkable: the shell used to declare `libc`
and call `geteuid` for socket hardening, which the old wording forbade in text and nothing caught.
Gate (c) of `check-core-seam.sh` now scans `termixion-tauri`'s DIRECT normal dependency
DECLARATIONS (dev/build excluded — a test-only platform crate is fine; optional and target-gated
ones are still caught), self-tested by `scripts/check-core-seam.test.sh`.

**What is NOT machine-checked, and is a review rule:** the domain-versus-presentation judgement
itself. No gate can tell window chrome from security policy, `app/`'s dependencies are not scanned,
and nothing stops the shell writing domain logic through `std::os` without any platform crate. Gate
(c) closes the cheapest and most common form of the violation; the rest is what review is for. Saying
so is the point — see [Claims and gates](../../docs/CONTRIBUTING.md#claims-and-gates-trmx-239).

## R2 — The core seam (enforced: `scripts/check-core-seam.sh`)
In `termixion-core` non-test code: **no platform `cfg` selectors** (`cfg(target_os|target_family|
target_env|target_arch|target_vendor|target_pointer_width)`, bare `cfg(unix)`/`cfg(windows)`) and **no
`std::os::`**. `cfg(test)` is allowed. (D-1 adds a cargo-metadata forbidden-dependency scan: no
`tauri`, `portable-pty`, `cocoa`/`objc`/`core-foundation`, `libc`, `nix`, `windows*` in core.)

## R3 — No panics in core (enforced: `deny(clippy::unwrap_used, clippy::expect_used)`)
No `unwrap()` / `expect()` in `termixion-core` non-test code — return `Result`/`Option`. Machine-checked
since trmx-239 (L8) by `#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]` in
`crates/termixion-core/src/lib.rs`, caught by `cargo clippy --workspace --all-targets -- -D warnings`
(pre-push + CI). `cfg_attr(not(test), …)` leaves the test modules free, which they need. The deny cost
nothing to add — core had zero non-test violations at the time — which is the ideal moment to ratchet.

## R4 — ISC headers (enforced: `scripts/check-isc-headers.sh`)
Every new `.rs` / `.ts` / `.tsx` source file starts with `// SPDX-License-Identifier: ISC`. Config
files (`*.json`, `*.js`, `*.toml`, `*.yaml`) are exempt.

## R5 — No secrets (enforced: `scripts/secret-scan.sh`)
Never commit credentials. `.gitignore` blocks `*.p12`/`*.p8`/`*.pem`/`*.key`; the secret-scan also
refuses AWS keys, private-key blocks, and GitHub/Slack tokens in staged content. Signing/notarization
secrets live only as GitHub Actions secrets (P0-2).

## R6 — Conventional commits (enforced: `.claude/hooks/commit-msg`)
`<type>(<scope>): <subject>`, `type ∈ feat|fix|chore|docs|test|refactor|perf|build|ci|style`.

## R7 — One PR per task (review rule)
Short-lived branch per Execution-Plan task; merge only on green gates + review (the `issue2pr` loop).

## R8 — Test-driven development (fundamental) (partly enforced: CI `lint + test + build`; test-FIRST is a review rule)
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

## R9 — Every change traces to a GitHub issue (`trmx-N`) (enforced: `scripts/check-issue-link.sh` via the `r9-issue-link` required CI check)
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

**The one allowance (trmx-261): Dependabot.** A dependency bump has no design intent to recover from an
issue — its provenance is the lockfile diff and the upstream release notes — and it carries no `trmx-<N>`
by construction, so the gate would fail every bump. `scripts/check-issue-link.sh` exempts a PR only when
the author login is exactly `dependabot[bot]` **and** the head branch is a `dependabot/…` branch; the
exemption is logged, never silent. The login is authoritative (GitHub reserves the `[bot]` suffix for
Apps), the branch shape keeps it narrow, and a human PR on a `dependabot/…`-shaped branch still faces the
full gate. `scripts/check-issue-link.test.sh` pins both the allowance and the refusals. **No other
exemption exists** — every human change still traces to an issue.

## R10 — Changelog: curated, user-facing, auto-generated (release-process + review rule: generated by `git-cliff` from `cliff.toml`, but no CI check verifies the committed file was not hand-edited)
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
