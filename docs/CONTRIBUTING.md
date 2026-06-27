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

## Workflow

- **One PR per task**, conventional-commits messages.
- **`A-1` and `P0-5` are done directly; `A-2` through `E` are driven through the `issue2pr` skill**
  (manifest mode + the `termixion` profile, `--reviewer-backend codex`). *(A-2 itself was done directly
  because P0-5 — the issue2pr adaptation — was not yet validated; R-6 fallback.)*
