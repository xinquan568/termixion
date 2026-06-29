# Contributing

## Toolchain (A-2 — pinned)

| Tool | Pin | Where |
|---|---|---|
| Rust | **1.94.1** + `rustfmt`, `clippy` | `rust-toolchain.toml` (auto-selected by rustup) |
| Node | **24.12.0** | `.nvmrc` (`nvm use`) |
| pnpm | **11.6.0** | `package.json#packageManager` (Corepack) |
| Tauri CLI | **2.11.3** | bootstrap below |

### Bootstrap `cargo tauri` (load-bearing — §2.4)

`cargo tauri` is a **separately installed binary**; a workspace/toolchain pin alone does **not** provide
the subcommand. Install it once (dev) — and every CI job that calls `cargo tauri` runs the same:

```sh
cargo install tauri-cli --version 2.11.3 --locked
```

Verify: `cd crates/termixion-tauri && cargo tauri --version` → `tauri-cli 2.11.3`.

## Build (§2.4)

The Tauri project root is `crates/termixion-tauri/`. Build from there:

```sh
cd crates/termixion-tauri && cargo tauri build --debug   # debug
cd crates/termixion-tauri && cargo tauri build            # release
```

(Frontend wiring lives in `tauri.conf.json`: `frontendDist: ../../app/dist`,
`beforeBuildCommand: pnpm --filter app build`.)

## Git hooks (A-4)

Install once after cloning:

```sh
bash scripts/install-hooks.sh   # sets core.hooksPath = .claude/hooks; makes the hooks executable
```

The hooks enforce the §2.2 guardrails locally (see `.claude/rules/architecture.md`):

- **pre-commit** → `scripts/secret-scan.sh` + `scripts/check-core-seam.sh` + `scripts/check-isc-headers.sh`.
- **commit-msg** → Conventional Commits (`<type>(<scope>): <subject>`).
- **pre-push** → `cargo test --workspace`.

They are the fast local copy; **CI (E-1) mirrors every load-bearing check**, so a `--no-verify` bypass
still fails the gate.

## Changelog (A-5)

`CHANGELOG.md` is generated from Conventional Commits by [git-cliff](https://git-cliff.org)
(config: `cliff.toml`). Install + regenerate:

```sh
cargo install git-cliff --version 2.13.1 --locked   # once
bash scripts/gen-changelog.sh                        # regenerate from the commit history
bash scripts/gen-changelog.sh --tag v0.0.1           # at release: stamp the version
```

(`gen-changelog.sh` runs `git cliff` and trims the trailing blank line so the EOF stays clean.)

This is why the `commit-msg` hook (R6) is load-bearing — well-formed commits produce a clean changelog.

## License & headers (A-5)

- The repo is **ISC** (`LICENSE`, © Eric Y. Liu). Any incorporated third-party code/asset is recorded
  in `THIRD_PARTY.md` per the authority §7.5 format (none copied yet).
- **ISC header snippet** — every new `.rs` / `.ts` / `.tsx` source file starts with (enforced by
  `scripts/check-isc-headers.sh`, R4):

  ```text
  // SPDX-License-Identifier: ISC
  // Copyright (c) 2026 Eric Y. Liu
  ```

## Test-driven development (R8 — fundamental)

**Write tests first.** Every behavioral change follows **RED → GREEN → REFACTOR**:

1. **RED** — write a failing test for the new behavior; confirm it fails for the right reason.
2. **GREEN** — implement the minimum to pass.
3. **REFACTOR** — tidy up with tests green.

No behavioral change merges without a covering test (Rust unit/integration; **golden tests** for
cross-platform/seam behavior; Vitest for the frontend). The pre-push `cargo test` hook + CI gate test
*passage*; the `issue2pr` review verifies the diff is covered. See `.claude/rules/architecture.md` R8.

## Workflow

- **Every change traces to a GitHub issue (R9).** The **maintainer creates the issue up-front** and
  hands you the number. Reference it as **`trmx-<N>`** (`<N>` = the issue number) in the branch
  (`xinquan568/ai/trmx-<N>-<slug>`), the run folder (`runs/trmx-<N>-<slug>/`), and the PR title
  (`… (trmx-<N>)`); link it in the PR body with `Closes #<N>`. **Machine-enforced** by the
  `r9-issue-link` CI check (the `commit-msg` hook gives fast local feedback). See
  `.claude/rules/architecture.md` R9.
- **Adding a *new* required check?** A status check must **run once on a PR** before GitHub will let you
  add it to branch protection — neither the Settings search box nor the API accepts a check name it has
  never seen report. So: land the workflow on the default branch, **open a PR to trigger the check once**,
  then mark it required. (Doubly so for `r9-issue-link`: it runs on `pull_request_target`, so it only
  fires for PRs opened *after* it's on the default branch.)
- **One PR per task**, conventional-commits messages.
- **Changelog (R10) is auto-generated, curated, user-facing.** `CHANGELOG.md` comes from git-cliff
  (`git cliff -o CHANGELOG.md`) — never hand-edited. Only `feat`/`fix`/`perf` and `(security)`-scoped
  fixes reach it (a breaking one is flagged **(breaking)**); internal types (incl. `docs`) are omitted. So
  your **commit `type` is the in/out decision** — pick it deliberately. See
  `.claude/rules/architecture.md` R10.
- **`A-1` and `P0-5` are done directly; `A-2` through `E` are driven through the `issue2pr` skill**
  (manifest mode + the `termixion` profile, `--reviewer-backend codex`). *(A-2 itself was done directly
  because P0-5 — the issue2pr adaptation — was not yet validated; R-6 fallback.)*
