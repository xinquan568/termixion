# Contributing

A-1 skeleton placeholder. Filled in by A-2/A-4 (plan §2.4, §2.2):

- **Toolchain bootstrap (A-2):** Rust stable + `rustfmt`/`clippy`; Node LTS + pnpm; then
  `cargo install tauri-cli --version <pin> --locked` so `cargo tauri` is available (it is a separately
  installed subcommand — a workspace pin alone does not provide it).
- **Build (§2.4):** the Tauri project root is `crates/termixion-tauri/`; build with
  `cd crates/termixion-tauri && cargo tauri build [--debug]`.
- **Hooks (A-4):** install with `git config core.hooksPath .claude/hooks`.
- **One PR per task**, conventional-commits messages; from `A-2` onward each task is driven through the
  `issue2pr` skill (manifest mode + the `termixion` profile, `--reviewer-backend codex`).
