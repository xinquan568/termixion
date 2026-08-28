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
cd crates/termixion-tauri && cargo tauri build --debug   # debug (sidecar-free)
cd crates/termixion-tauri && cargo tauri build            # release (sidecar-free)
# Bundling WITH the Starship sidecar (trmx-207): fetch once, then pass the overlay —
#   bash scripts/fetch-starship.sh
#   cd crates/termixion-tauri && cargo tauri build --debug --config tauri.sidecar.conf.json
# `cargo tauri dev` and plain cargo build/test are deliberately sidecar-free (PATH fallback).
```

Or use the helper **`scripts/rebuild.sh`** (`[--release] [--no-launch] [--dev]`) — it builds from the
right directory and, by default, quits any running instance and relaunches the fresh `.app`:

```sh
scripts/rebuild.sh             # debug build + relaunch
scripts/rebuild.sh --release   # release build + relaunch
scripts/rebuild.sh --dev       # cargo tauri dev (hot reload)
```

(Frontend wiring lives in `tauri.conf.json`: `frontendDist: ../../app/dist`,
`beforeBuildCommand: pnpm --filter app build`.)

## Git hooks (A-4)

Install once after cloning:

```sh
bash scripts/install-hooks.sh   # sets core.hooksPath = .claude/hooks; makes the hooks executable
```

The hooks enforce the §2.2 guardrails locally (see `.claude/rules/architecture.md`):

- **pre-commit** → `scripts/secret-scan.sh` + `scripts/check-core-seam.sh` +
  `scripts/check-isc-headers.sh` + `cargo fmt --all --check` + `pnpm --filter app lint`.
- **commit-msg** → Conventional Commits (`<type>(<scope>): <subject>`).
- **pre-push** → `cargo clippy --workspace --all-targets -- -D warnings` + `cargo test --workspace`
  + `pnpm --filter app test`.

Clippy sits at pre-push rather than pre-commit: a cold run is minutes, and a commit hook slow enough
to get bypassed protects nothing.

They are the fast local copy; **CI (E-1) mirrors every load-bearing check**, so a `--no-verify` bypass
still fails the gate. The list above is pinned by `.claude/hooks/hooks.test.sh` — see
[Claims and gates](#claims-and-gates-trmx-239).

## Claims and gates (trmx-239)

The 2026-08-26 review found **five** places where a document said something was checked and nothing
checked it. One is a slip; five is a pattern — **claims get written faster than gates.**

The five, as the worked example:

| Claim | Reality | Closed by |
| ----- | ------- | --------- |
| `.claude/hooks/README.md`: pre-commit runs `cargo fmt --check`, clippy, `pnpm lint` | it ran none of them | trmx-239 |
| CI runs a secret scan over the diff | it did not | trmx-234 |
| R1: only `termixion-platform` may use platform crates | `termixion-tauri` declared `libc` and called `geteuid` | trmx-239 |
| `themeSpecGolden.test.ts`: the app fixture "MUST NOT drift" from core's | it had already drifted; the test only checked required keys | trmx-239 |
| R3: no panics in core | true, but enforced by review alone | trmx-239 |

So, when you write that something is checked:

**Either add the check in the same PR, or write the sentence as an intention.** "Should", not "is
enforced in CI". An unenforced rule stated as enforced is worse than an unstated one — it buys false
confidence and it decays silently, because nothing fails when it stops being true.

Two habits follow:

- Every R-rule in `.claude/rules/architecture.md` names **which gate enforces it**, or says
  `review rule` outright. An unenforced rule should be visibly unenforced.
- If your PR adds a claim about enforcement, it adds the enforcement. There is a line for this in
  the PR checklist (`.github/pull_request_template.md`).

There is deliberately **no CI job checking for ungated claims** — a gate that checks for missing
gates would be its own joke. This is a documentation and review habit, and the count going 5 → 0 is
the evidence it worked.

## Dependency updates (trmx-234, trmx-266)

Dependabot opens one grouped PR per ecosystem weekly (`.github/dependabot.yml`). They carry no
`trmx-N`, so `scripts/check-issue-link.sh` grants bot PRs an explicit allowance — see the note at the
top of that config before renaming any branch prefix.

**Some majors are held.** A grouped PR fails as a unit, so one package that breaks a gate blocks
every other update in the group indefinitely. The `ignore:` list holds those, and **every entry names
the condition that lifts it** — a hold without an exit becomes a permanent pin nobody dares touch.
Currently held: `typescript` (typescript-eslint 8.x refuses TS >= 7), `@types/node` (must track
`.nvmrc` / the workflows' `node-version`), and `@xterm/*` (xterm 6 rebuilt the viewport, which
`app/src/terminal/scrollbar.ts` depends on — tracked as trmx-279; **major and minor**, because the
addons are 0.x and their breaking changes land in the minor position).

**To lift a hold:** bump the package *and its partners* in one PR — a TypeScript major goes with
`typescript-eslint`, an `@types/node` major with `.nvmrc` and both workflows, an xterm major with
every `@xterm/*` addon — verify `pnpm --filter app lint`, `test`, `build` **and** `exec playwright
test`, then delete the `ignore:` entry in the same PR. Leaving the entry behind silently re-pins the
package you just upgraded.

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

## Logging (trmx-236)

A Finder-launched `.app` has no stderr, so runtime diagnostics go through the `log` facade
(`log::info!` / `warn!` / `error!`) into `tauri-plugin-log`: **stdout** (dev console / CI log) and the
file **`~/Library/Logs/dev.termixion.terminal/termixion.log`** (rotates at 2 MiB; the current file plus
one dated archive are kept). Settings → About → Logs → "Open log folder" opens it. The binary's own
records log at `Info`+, third-party crates at `Warn`+. The sink is installed at the top of `setup` from a
caught path: if the directory cannot be used, the app still launches with stdout only and says so at
`warn`; `TERMIXION_LOG_NO_FILE=1` makes that deliberate.

- **Never log** PTY input/output, environment values, clipboard contents, or `send-text` payloads.
  Settings keys/values and error messages are fine.
- The webview forwards `console.error/warn/info` through `app/src/ipc/logSink.ts` (`log.error(ctx, err)`)
  → the app-owned, bounded (64 KiB) `log_message` command; `debug` stays local.
- `println!`/`eprintln!` are for **stdio contracts only** (the `ctl` JSON reply, `--version`/`--help`,
  the pre-builder usage errors, the fatal's stderr branch). The shell crate denies
  `clippy::print_stdout` / `print_stderr`; only `run_ctl` and `main` carry an allowance, each with a
  `stdio-contract` comment — use `log::*` anywhere else.
- Unified logging (`os_log` / Console.app streaming) is a follow-up: the plugin has no such target and it
  belongs behind a `termixion-platform` seam (R1).

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
