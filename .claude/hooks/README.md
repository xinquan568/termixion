# Git hooks (filled in by task A-4)

A-1 skeleton placeholder. **A-4** adds executable hooks here and installs them via
`git config core.hooksPath .claude/hooks` (or an equivalent runner). Every load-bearing check is also
mirrored in CI (E-1) so a `--no-verify` bypass cannot defeat the gate (plan §2.2):

- **pre-commit** — `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
  `pnpm lint`, secret scan, `scripts/check-core-seam.sh`, ISC-header check.
- **pre-push** — tests.
- **commit-msg** — conventional-commits format.
