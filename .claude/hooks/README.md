# Git hooks

Installed by `scripts/install-hooks.sh` (sets `git config core.hooksPath .claude/hooks`).

Every load-bearing check is **also** a required CI step (E-1), so a `--no-verify` bypass cannot
defeat a gate — the hooks are the fast local copy, not the enforcement.

- **pre-commit** — `scripts/secret-scan.sh`, `scripts/check-core-seam.sh`,
  `scripts/check-isc-headers.sh`, `cargo fmt --all --check`, `pnpm --filter app lint`.
- **pre-push** — `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo test --workspace`, `pnpm --filter app test`.
- **commit-msg** — Conventional Commits (`<type>(<scope>): <subject>`) + the R9 `trmx-N` branch check.

**Clippy runs at pre-push, not pre-commit.** A cold clippy is minutes, and a commit hook slow enough
to get bypassed protects nothing.

This list is not a promise — it is **pinned by `.claude/hooks/hooks.test.sh`**, which traces each
hook and asserts the exact command lines it invokes. That test **runs in CI** (the
`shell integration` job), so the claim on this page is itself gated rather than merely written. That test exists because this file previously
described three checks (`cargo fmt --check`, clippy, `pnpm lint`) that no hook ran (trmx-239, M24).
If you change a hook, the test fails until you change it too — and this file should change with both.
