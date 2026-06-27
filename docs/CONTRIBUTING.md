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

## Workflow

- **Hooks (A-4):** install with `git config core.hooksPath .claude/hooks`.
- **One PR per task**, conventional-commits messages.
- **`A-1` and `P0-5` are done directly; `A-2` through `E` are driven through the `issue2pr` skill**
  (manifest mode + the `termixion` profile, `--reviewer-backend codex`). *(A-2 itself was done directly
  because P0-5 — the issue2pr adaptation — was not yet validated; R-6 fallback.)*
