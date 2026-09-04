---
plugin: grill
version: 1.3.0
date: 2026-08-26
target: /Users/xqliu/opt/aispace/claude-projects/eric-tech/008-Termixion/codes/termixion
style: Hard-Nosed Critique + Roadmap
addons: [scale-stress, hidden-costs, principle-violations, strangler-fig, success-metrics, before-vs-after, assumptions-audit, compact-and-optimize]
agents: [recon, architecture, error-handling, security, testing]
---

# Termixion — Codebase Grill (Hard-Nosed Critique + Roadmap)

**Target**: `codes/termixion` @ `main` `e018593` (tag `v0.1.1`) — Tauri v2 terminal emulator, Rust 1.94 (3-crate workspace, 15.3k lines) + React 19 / xterm.js 5.5 (18k source / 26k test lines), macOS-only.
**Method**: recon + 4 parallel deep-dive agents (architecture, error-handling, security, testing); every finding was file-anchored by the agent and the 16 highest-consequence claims were re-verified by direct grep before this report was written. Paths are relative to the target root. All agents completed; none timed out.
**Severity tally**: CRITICAL 0 · HIGH 8 · MEDIUM 24 · LOW 16 · GOOD 18.

Repo facts used below: 66 days old, 133 commits, 131 by one author; 11 tags (a release every ~6 days); churn hotspots are `App.tsx` (38 commits), `main.rs` (32), `TerminalView.tsx`/`settingsStore.ts` (22 each), `config.rs` (17); 13 commits touched `config.rs` + `config_io.rs` + `settingsStore.ts` together.

---

## A. Critical flaws (with specific examples)

There are **no `[CRITICAL]`** findings: no exploitable security hole, no data-loss path, no correctness bug in the PTY data plane. The eight `[HIGH]` findings cluster into three flaws.

### Flaw 1 — The packaged app is blind and, in the worst case, unquittable

- **`[HIGH] H1` No logging sink exists.** `crates/termixion-tauri/Cargo.toml` has no `log`/`tracing`/`tauri-plugin-log`; 32 `eprintln!` sites (`main.rs:1312,1336,1344,1425`, `config_io.rs:517,612,618,640,645,668`, `control.rs:188-200`, `enhancements_io.rs:226`, `themes_io.rs:167,231,250,255`, `scripts_io.rs:172,189,194`) and ~40 frontend `console.*` sites write to a stderr/WKWebView console that a Finder-launched `.app` discards. Every degraded-mode branch in this report ("watcher disabled", "remote control not started", "shell enhancements unavailable", "could not read theme") already has a good message — and none of it reaches a user or a bug report. Fix: `tauri-plugin-log` → `~/Library/Logs/Termixion/` + `os_log`, replace `eprintln!` with `log::*`, forward webview errors via a `log_message` command, add "Open log folder" to `AboutSettings.tsx`. `[< 1 week]`
- **`[HIGH] H2` Quit depends entirely on a live webview.** `main.rs:1394-1397`:
  ```rust
  CloseAction::PreventAndAsk => {
      api.prevent_close();
      let _ = window.emit_to(window.label(), "close:requested", ());
  }
  ```
  `⌘Q` is a custom menu item (`menu.rs:228-234`) routed to JS, not `PredefinedMenuItem::quit`. If the JS thread is hung (output flood), the WebContent process crashed, or the app is still in its boot chain, the close is vetoed, the emit error discarded, and nothing retries — the only exit is Force Quit, which skips `registry.kill_all()` and `control::shutdown()`. Fix: JS acks `close:requested` immediately; a second close gesture after ~3 s without ack authorizes teardown; `emit_to` `Err` authorizes immediately; route `RunEvent::ExitRequested` through the same gate. `[< 1 day]`
- **`[HIGH] H3` No React error boundary or global error handler** (`grep -rlE 'ErrorBoundary|componentDidCatch|unhandledrejection' app/src` → 0 files). `main.tsx:85-96` renders `<App/>` bare and `void boot()` has no `.catch`; `App.tsx:301` casts `payload as ControlRequest` without validation. React 19 unmounts the root on any render error → blank window, PTY children alive in Rust, unreachable, and (per H2) unquittable. Fix: class error boundary with "your shells are still running — [Reload] [Quit]", `window.onerror`/`unhandledrejection`, `boot().catch`. `[< 1 day]`
- **`[HIGH] H4` PTY spawn failure produces a silent dead pane.** `App.tsx:790-795` catches the attach rejection with `console.error` only; `unix.rs:136-140` rejects a non-directory cwd. Realistic trigger: a new tab inherits the active tab's OSC-7 cwd after that directory was deleted. Fix: write the error into the pane, mark it dead, retry once with `cwd = None`. `[< 1 day]`

### Flaw 2 — Two god files own the churn

- **`[HIGH] H5` `main.rs` is a five-concern file.** Non-test body (~1430 lines, tests start at `:1431`) interleaves PTY state + flow control (`:49-65`, `:501-855`), the foreground poller (`:66-410`), smoke/perf/CLI launch (`:857-1125`), quit gating with two process globals (`QUIT_AUTHORIZED :1126`, `MAIN_TEARDOWN_DONE :1128`), and the builder (`:1172-1429`). 15 of the last 15 commits to it are distinct issues. The `*_io.rs` convention at `:31-41` already exists — PTY, poller, and launch simply never got a module. Fix: extract `pty_io.rs`, `poller.rs`, `launch.rs`. `[< 1 week]`
- **`[HIGH] H6` `App.tsx` holds per-pane runtime state in 15 parallel `useRef(new Map<PaneId,…>())` tables** (`:553-598`), 22 injection props (`:363-408`), ~475 lines of per-pane closures (`:715-1189`), 20 `useEffect`s; `disposePaneResources` (`:947-985`) must remember to clear each map. 38 commits — every pane feature adds a map and a dispose line. Fix: one `Map<PaneId, PaneRuntime>` with `create`/`dispose` as the only lifecycle entry points, then extract `useCommandContext`/`useCloseGuard`/`usePaneActivity`. `[< 1 week]` for the map consolidation; `[< 1 month]` in full.

### Flaw 3 — The thing that ships is the thing that is least tested

- **`[HIGH] H7` The 28 Tauri command handlers and all `AppHandle`-bound orchestration have zero tests.** `open_pty` (`main.rs:676-780`) resolves the shell, emits the fallback warning, layers `enhancement_env`, and inserts the credit cell *before* spawning threads (`:734-738`) — move that insert after the spawn (ack before insert = lost credit) and every current test still passes. Same for `config_write`'s latch-vs-`apply_remote_control` ordering (`config_io.rs:533-580`), `on_config_file_event` (`:664-712`), the three `notify` watchers, `control.rs:219-330` accept→bridge→`control_response` (only path helpers at `:415-500` are tested), and `window_manager.rs:70-103`. `scripts/smoke.sh` exercises exactly `pwd/cd/pwd/ls` → 4 of 28 commands. Fix: `tauri = { features = ["test"] }` dev-dep + `mock_builder()`/`get_ipc_response`; refactor `open_pty` body into a testable `open_session(...)`; make `bridge_to_webview` generic over an `emit` closure; temp-dir rename-replace tests per watcher. `[< 1 week]`
- **`[HIGH] H8` The release binary is never executed before publish, releases are not gated on CI, and there is no rollback.** `--smoke` runs in CI only against `cargo tauri build --debug`; `release.yml:129-140` verifies only that a `.dmg` exists; `release.yml` triggers on any `v*` tag with no dependency on the `ci` workflow (the "wait for CI green before tagging" rule is a human convention); `Cargo.toml:20-25`'s `panic = "abort"`/`lto`/`strip` profile is therefore untested; `docs/RELEASE.md` has zero mentions of rollback while `useUpdateAuthority.ts:74` auto-downloads. Fix: run `scripts/smoke.sh` on the release `.app` (the script already accepts one); a first job asserting the tagged SHA has a green `full gate (macos)` check; a written rollback procedure ("N+1 hotfix from the N-1 tag + delete release"). `[< 1 week]`

---

## B. 80/20 rewrite plan

No rewrite is warranted. The core (`termixion-core`), the PTY data plane, the config round-trip, the socket hygiene, and the input-sanitization edges are well-designed and tested — see the `[GOOD]` ledger in §F. 20% of the effort that removes ~80% of the risk:

| # | Change | Removes | Effort |
|---|---|---|---|
| 1 | **Observability bundle** — H1 logging sink + H2 quit fallback + H3 error boundary + H4 visible spawn failure + M14 surface `config_write` failures + M19 config warnings in main window | The entire "packaged app is blind" flaw; makes every other bug diagnosable from a user report | ~4 days |
| 2 | **Supply-chain + release gate** — M1 SHA-pin actions, M2 `cargo deny`/`pnpm audit`/Dependabot, H8 release smoke + CI-green precondition + rollback doc, L15 `ref_name` env, L16 secret-scan in CI | The only plausible path to the updater signing key; every release stops being a bet | ~4 days |
| 3 | **Decompose `main.rs` and push pure logic down** — H5 split into `pty_io`/`poller`/`launch`, then M5 move credits/batching, control codec, and config-apply decision into core; M12 move `libc` use into the platform crate and gate it | Shotgun surgery on the shell; ~700 pure lines gain Linux CI coverage; R1 matches its gate | ~8 days |
| 4 | **Single config schema** — M6 declarative `SCHEMA` table in core, derived `toml_path_for`/`value_kind_for`/`diff_configs`/`walk_*`, golden JSON asserted by `settingsStore.test.ts` | 13-commits-touch-3-files tax; a new setting becomes one edit + one fixture | ~4 days |
| 5 | **`App.tsx` PaneRuntime (step 1 only)** — H6 map consolidation | The leak-by-omission hazard; sets up the hook extraction later | ~5 days |
| 6 | **Handler tests** — H7 MockRuntime harness for the 28 commands | The largest untested surface in the repo | ~4 days |

≈ 29 working days. Everything else in this report is incremental.

---

## C. Prioritized backlog (15 items, ranked by impact × risk ÷ effort)

Impact/Risk on 1–5; Effort in developer-days.

| Rank | ID | Item | Impact | Risk | Effort | Why this rank |
|---|---|---|---|---|---|---|
| 1 | M1 | SHA-pin all GitHub Actions; `tauri-action@v0` holds `TAURI_SIGNING_PRIVATE_KEY` + 6 `APPLE_*` secrets (`release.yml:101,117`) | 4 | 5 | 0.5 | Highest risk per hour: a tag-retarget (tj-actions, Mar 2025) exfiltrates the updater key; no revocation path exists |
| 2 | H2 | Rust-side quit fallback (`main.rs:1394-1397`, `menu.rs:228-234`) | 4 | 4 | 0.5 | Unquittable app = orphaned PTYs + stale socket; half a day |
| 3 | H3 | React error boundary + global handlers (`main.tsx:85-96`) | 4 | 4 | 0.5 | Blank-window failure mode; half a day |
| 4 | H1 | `tauri-plugin-log` sink; replace 32 `eprintln!` | 5 | 4 | 3 | Unblocks diagnosing every other item from a user report |
| 5 | H8 | Release: smoke on release bundle + CI-green gate + rollback doc (`release.yml`) | 5 | 4 | 3 | A release every 6 days with autoDownload and no rollback |
| 6 | M2 | `cargo deny` + `pnpm audit` + `dependabot.yml` | 3 | 4 | 0.5 | Nothing surfaces a `wry`/`tauri` advisory today |
| 7 | H4 | Visible PTY spawn failure + cwd fallback (`App.tsx:790-795`) | 3 | 3 | 0.5 | Common deleted-cwd case; half a day |
| 8 | H7 | MockRuntime tests for the 28 handlers | 4 | 4 | 4 | Largest untested surface; pins `open_pty` ordering |
| 9 | H5+M5 | Split `main.rs`; move pure seams to core | 4 | 3 | 8 | Removes the churn magnet; Linux CI covers ~700 more lines |
| 10 | M6 | Single declarative config schema | 4 | 3 | 4 | 6 declaration sites → 1 + golden |
| 11 | M4 | PTY frames as raw bytes instead of JSON `number[]` (`backend.ts:47,98`) | 3 | 2 | 0.5 | ~3.5x IPC inflation on the hot path; the first thing to break under load (see Scale stress) |
| 12 | M3 | Real CSP instead of `"csp": null` (`tauri.conf.json:23`) | 3 | 3 | 3 | Turns any future injection from PTY-write RCE into defacement |
| 13 | H6 | `App.tsx` PaneRuntime consolidation (step 1) | 4 | 3 | 5 | Leak-by-omission hazard; every pane feature adds a map |
| 14 | M22 | Kill wall-clock timing asserts (`main.rs:2536` `< 8 ms`) and sleep-based negatives | 3 | 3 | 3 | The known CI flake; re-runs erode trust in red |
| 15 | M23 | Playwright with a fake `__TAURI_INTERNALS__`; grow `--smoke` scenarios; upload traces, `retries: 0` | 3 | 3 | 4 | 18/19 e2e specs test the degraded UI, not the app |

Not ranked but bundled as a single half-day PR: **M9** (`ctl` Latin-1 decode, `control.rs:385`), **M10** (remote-control command allowlist), **M11** (socket path in `config.rs:196,492`, `docs/remote-control.md:30,34`), **M16** (acceptor silent death, thread/line caps).

---

## D. Red flags

1. **"Documented, not enforced" — five independent instances.** `.claude/hooks/README.md:7-9` claims fmt/clippy/lint run in pre-commit; `pre-commit:10-12` runs three other scripts. `scripts/secret-scan.sh:4` and `pre-commit:5` say "CI runs the same script"; `ci.yml` never does. `.claude/rules/architecture.md` R1 says the platform crate is the only `cfg(target_os)` home; `main.rs:1298`, `window_manager.rs:44,53`, `control.rs:111` (`unsafe { libc::geteuid() }`) disagree and `check-core-seam.sh:24,49` only scans core. `app/src/theme/themeSpecGolden.test.ts:4-7` says the fixture "MUST NOT drift"; it already has (core `theme-golden.json:57-60` has a `search` block the app copy lacks) and the test is green. `config.rs:492` (the template written into every user's config) and `docs/remote-control.md:30,34` name a socket path the code (`control.rs:84`) does not use. One divergence is a slip; five is a pattern: claims are written faster than gates.
2. **Bus factor of one.** 131 of 133 commits by one author in 66 days. Every process that lives in a human's head (tag-after-green, rollback, key rotation, "run e2e before push") is one bad week from being lost. Prioritize automation over process documents.
3. **Release cadence outpaces release verification.** 11 releases in 66 days; the release-profile binary has never been smoke-tested; the updater auto-downloads.
4. **Churn concentrates exactly where tests are thinnest.** `App.tsx` (38 commits, god component) and `main.rs` (32 commits, handlers untested) are simultaneously the most-changed and least-guarded files.
5. **Test volume is not coverage.** 26k test lines and a 121:121 source:test file parity, yet coverage is unmeasured, `PaletteOverlay.tsx` (117 lines) has zero test references, and `conformance/driver.ts` (215 lines) is untested. The parity number will keep reassuring until it doesn't.
6. **Eight opaque binaries execute in every zsh session.** 8 committed `.zwc` wordcode blobs (`resources/shell-enhancements/powerlevel10k/internal/p10k.zsh.zwc` = 815,952 B) are not upstream artifacts; zsh prefers `.zwc` over the reviewable `.zsh` beside it.

---

## E. Quick wins

### `[< 1 day]` each (≈ 8 days total if all done)
- M1 SHA-pin every `uses:` in `ci.yml`/`release.yml`/`r9-issue-link.yml` + `dependabot.yml` for github-actions.
- M2 `cargo deny check advisories` (+`deny.toml`) and `pnpm audit --prod --audit-level=high` job.
- H2 quit fallback; H3 error boundary; H4 visible spawn failure.
- M14 route `config_write` rejections into the existing `clientWarnings` ledger (`settingsStore.ts:494-510`).
- M15 `config_io.rs:665` — on `NotFound` re-read once after ~100 ms before applying defaults; on other errors skip; add `ConfigWarning::Unreadable`.
- M16 `control.rs:243-245` — log accept errors, retry `Interrupted`, `dead` flag, cap workers (~16), `Read::take(64 KiB)` before `lines()`.
- M9 `control.rs:385` — `read_line` instead of `byte[0] as char`.
- M10 `CONTROL_COMMANDS` allowlist in `controlBridge.ts` + test tying it to `PROTOCOL_VERSION`.
- M11 fix the four socket-path text sites + core test asserting `DEFAULT_TEMPLATE` matches `socket_path_from(None)`.
- M12 move `ensure_private_dir`/`create_socket` to the platform crate; add a `cargo tree -p termixion-tauri --depth 1` gate for `libc`/`nix`/`objc2*`; reword R1.
- M4 `tauri::ipc::Response::new(batch)` + `Channel<ArrayBuffer>`; re-run `--perf`.
- M21 import the core golden JSON directly in `themeSpecGolden.test.ts`.
- M24 pre-commit += `cargo fmt --check` + `pnpm --filter app lint`; pre-push += `pnpm --filter app test` + clippy; fix README.
- M18 emit enhancement-materialization failures on `config:warnings` (pattern at `config_io.rs:476-489`).
- M19 subscribe to `config:warnings` in the main window; badge in the title bar.
- L8 `#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]` in `termixion-core/src/lib.rs` — R3 is already true, lock it.
- L14 delete the 8 `.zwc` files; CI assert none; sha256 per plugin in `THIRD_PARTY.md`.
- L15 `env: TAG: ${{ github.ref_name }}` in `release.yml:178,200,204`.
- L16 `secret-scan.sh --range` mode in CI (or SHA-pinned gitleaks).
- L9 `timeout-minutes: 60`, `permissions: contents: read`, cache Playwright + tauri-cli binary.
- L7 one `fs_watch::run_debounced` for the three watcher loops.

### `[< 1 week]` each
- H1 logging sink; H5 split `main.rs`; H7 handler tests; H8 release gate; M5 pure seams → core; M6 config schema; M7 frontend layering + eslint `no-restricted-paths`; M8 `settingsStore` test backend out of production; M13 typed `IpcError`; M3 CSP; M22 timing flakes; M23 e2e fake runtime; H6 step 1.

---

## F. Findings ledger (deduplicated, attributed)

Duplicates merged: actions pinning (security + testing → M1), dependency audit (security + testing → M2), control-socket resource caps (error-handling + security → M16), `config_write` divergence (architecture handoff + error-handling → M14).

### HIGH
| ID | Agent | File | Finding | Effort |
|---|---|---|---|---|
| H1 | error-handling | `crates/termixion-tauri/Cargo.toml`; 32 `eprintln!` sites | No logging framework; packaged-app diagnostics are discarded | < 1 week |
| H2 | error-handling | `main.rs:1394-1397`, `menu.rs:228-234` | Quit depends solely on a live webview; no Rust fallback | < 1 day |
| H3 | error-handling | `app/src/main.tsx:85-96`, `App.tsx:301` | No error boundary / global handlers; render error = blank window | < 1 day |
| H4 | error-handling | `App.tsx:790-795`, `platform/src/unix.rs:136-140` | PTY spawn failure = silent dead pane | < 1 day |
| H5 | architecture (F-3) | `main.rs:49-1429` | Five-concern god file; 15/15 recent commits distinct issues | < 1 week |
| H6 | architecture (F-15) | `App.tsx:553-598, 363-408, 715-1189, 947-985` | 15 parallel ref-maps keyed by `PaneId`; dispose-by-memory | < 1 week (step 1) / < 1 month |
| H7 | testing (T4) | `main.rs:676-780`, `config_io.rs:533-712`, `control.rs:219-330`, `window_manager.rs:70-103` | 28 handlers + orchestration untested; `--smoke` covers 4 | < 1 week |
| H8 | testing (T5) | `release.yml:17-19,99-140,189-205`, `docs/RELEASE.md` | Release binary never executed; no CI gate on tag; no rollback | < 1 week |

### MEDIUM
| ID | Agent | File | Finding | Effort |
|---|---|---|---|---|
| M1 | security (§11) + testing (T10) | `release.yml:35,73-77,101,117,150,162`, `ci.yml:26-74` | All actions on mutable tags; `tauri-action@v0` holds signing secrets | < 1 day |
| M2 | security (§12) + testing (T10) | `.github/` (no audit, no dependabot) | No `cargo deny`/`pnpm audit`/Dependabot | < 1 day |
| M3 | security (§5) | `tauri.conf.json:23` `"csp": null` | No CSP; app commands unscoped → future injection = `pty_write` RCE | < 1 week |
| M4 | architecture (F-8) | `main.rs:677,765`, `backend.ts:47,53,98` | PTY frames serialized as JSON `number[]` (~3.5x inflation, per-byte parse) | < 1 day |
| M5 | architecture (F-2) | `main.rs:501-673`, `control_io.rs:1-303`, `config_io.rs:79-118` | ~700 lines of Tauri-free logic live in the shell → only macOS CI tests them | < 1 week |
| M6 | architecture (F-11) | `config.rs:172-380,529-700,773-1043`, `config_io.rs:137-166`, `settingsStore.ts:75-131,159-200,270-385` | Config schema declared in 6 places across 3 languages | < 1 week |
| M7 | architecture (F-5) | `App.tsx:226`, `backend.ts:18`, `TabStrip.tsx:70`↔`keymapDispatch.ts:16`, `ScriptPicker.tsx:12`/`PaletteOverlay.tsx:10`↔`CommandPalette.tsx:14`, `applyStartupTheme.ts:14`/`themeHotReload.ts:22`↔`settings/` | 8 files import `@tauri-apps/*` outside `ipc/`; `ipc/`→`panes/`; 3 directory cycles | < 1 week |
| M8 | architecture (F-16) | `settingsStore.ts:20-23,443-452,524-539,658-733` | ~75-line test-only storage backend in production + module singleton | < 1 week |
| M9 | architecture (F-18) | `control.rs:376-389` (`:385 byte[0] as char`) | `ctl` decodes responses as Latin-1 → mojibake | < 1 day |
| M10 | architecture (F-19) | `control_io.rs:13,59-70`, `controlBridge.ts:13` | Any unknown `cmd` forwarded to the whole registry; `PROTOCOL_VERSION=1` means nothing | < 1 day |
| M11 | architecture (F-20) | `config.rs:196,492`, `docs/remote-control.md:30,34`, `docs/config.md:83` vs `control.rs:84` | Template + docs name the wrong socket path | < 1 day |
| M12 | architecture (F-4) | `tauri/Cargo.toml:27`, `control.rs:111`, `main.rs:1298`, `window_manager.rs:44,53`, `check-core-seam.sh:24,49` | R1 wider than its gate; `libc` in the shell crate | < 1 day |
| M13 | error-handling | `main.rs:785-856`, `backend.ts:138-168`, `useBackend.ts:141-149` | IPC errors flattened to `String`; benign post-exit races logged as errors | < 1 week |
| M14 | error-handling | `settingsStore.ts:614-618,846-850,916-919`, `config_io.rs:213-215` | `config_write` fire-and-forget; unsaved changes look saved | < 1 day |
| M15 | error-handling | `config_io.rs:664-666,498-502` | Transient missing file on watcher wake applies ALL defaults live; EACCES → `exists:false` → migration | < 1 day |
| M16 | error-handling + security (§4) | `control.rs:231-245,263` | Acceptor thread exits silently; listener handle stays `Some`; unbounded threads; no line cap | < 1 day |
| M17 | error-handling | `control.rs:33,321-324` | 2 s bridge timeout → at-least-once for mutating commands; late responses dropped silently | < 1 day |
| M18 | error-handling | `enhancements_io.rs:222-229`, `zdotdir.rs:98-104,137-141` | Enhancement failures degrade silently while Settings toggles show "on" | < 1 day |
| M19 | error-handling | `settingsStore.ts:931-937`, `SettingsApp.tsx:144`; no `App.tsx` subscriber | `config:warnings` only visible in the Settings window | < 1 day |
| M20 | testing (T6) | `vite.config.ts:20-26`, `ci.yml:90-93` | No coverage measurement; `PaletteOverlay.tsx`, `conformance/driver.ts` untested | < 1 day measure / < 1 week ratchet |
| M21 | testing (T7) | `core/tests/fixtures/theme-golden.json:57-60` vs `app/src/theme/__fixtures__/theme-golden.json`, `themeSpecGolden.test.ts:4-7` | Golden already drifted; the "drift gate" cannot detect it | < 1 day |
| M22 | testing (T8) | `main.rs:2515-2540,2343-2360,2396-2411,2477-2510`, `useUpdateAuthority.test.tsx:77-264`, `runPerf.test.ts:196-211` | Wall-clock asserts (`< 8 ms`) and sleep-based negatives = the known CI flakes | < 1 week |
| M23 | testing (T9) | `playwright.config.ts:4-27`, `shell.spec.ts:4-8`, `app.spec.ts:62-66`, `ci.yml:105-108` | e2e runs without a Tauri runtime; `retries:1`; no trace upload | < 1 week |
| M24 | testing (T11) | `.claude/hooks/README.md:7-9`, `pre-commit:10-12`, `pre-push:7` | Hooks skip fmt/clippy/lint/frontend tests despite README | < 1 day |

### LOW
| ID | Agent | File | Finding | Effort |
|---|---|---|---|---|
| L1 | error-handling | `config_io.rs:629-636`, `themes_io.rs:242-247`, `scripts_io.rs:181-185` | `notify` error/rescan events dropped | < 1 day |
| L2 | error-handling | `control.rs:72-74` vs `main.rs:336-340` vs `config_io.rs:666-669` | Inconsistent poisoned-mutex policy | < 1 day |
| L3 | architecture (F-6) | `app/package.json` (`@types/node ^26`) vs `.nvmrc` 24; `toml 1.1.2` read vs `toml_edit 0.25.12` write | Type/runtime mismatch; two parsers over one document | < 1 day |
| L4 | architecture (F-9) | `main.rs:764` | `ConsumeOutcome` always discarded | < 1 day |
| L5 | architecture (F-10) | `config_io.rs:455-472,497-529`, `main.rs:1318-1332` | Rust config state hydrated by JS boot order; 3 read paths | < 1 day |
| L6 | architecture (F-12) | `main.rs:841-855`, `registry.rs:122-130`, `App.tsx:580` | `set_session_title` mirror has no reader | < 1 day |
| L7 | architecture (F-17) | `config_io.rs:607-662`, `themes_io.rs:224-275`, `scripts_io.rs:167-210` | Three copy-pasted watcher loops | < 1 day |
| L8 | architecture (F-21) | `termixion-core/src/lib.rs:1-12` | R3 "no panics" is true but review-only | < 1 day |
| L9 | testing (T12) | `ci.yml:63-112`, `release.yml:83-84`, `scripts/repo-stats.test.py` | No `timeout-minutes`/`permissions`; tauri-cli from source; orphan test | < 1 day |
| L10 | testing (T13) | `app/src/main.order.test.ts:15-40` | Asserts on `main.tsx?raw` source text | < 1 day |
| L11 | security (§1) | `osc52.ts:31-40`, `config.rs` | OSC 52 writes silent and unconditional; no toggle/toast | < 1 day |
| L12 | security (§4) | `control.rs:88-95,101-130`, `config.rs:197` | Custom `socket_path` chmods its arbitrary parent to 0700 | < 1 day |
| L13 | security (§6) | `build.rs:5-7`, `main.rs:1350-1379` | All 28 app commands callable from both windows; `smoke_done` calls `exit(1)` unconditionally | < 1 week |
| L14 | security (§8) | 8 `*.zwc` under `resources/shell-enhancements/`; `THIRD_PARTY.md` | Opaque compiled zsh blobs committed and executed; provenance unrecorded | < 1 day |
| L15 | security (§11) | `release.yml:178,200,204` | `${{ github.ref_name }}` interpolated into `run:` | < 1 day |
| L16 | security (§13) | `secret-scan.sh:4`, `pre-commit:5`, `ci.yml:22-31` | Secret scan claims CI parity; CI never runs it | < 1 day |

### GOOD (keep these — they are the reason no rewrite is warranted)
- Zero `unwrap`/`expect`/`panic!` in non-test code across all three crates (R2 holds even under `panic = "abort"`).
- PTY lifecycle: `DoneGuard` exactly-once reap + `pty:exited` (`main.rs:620-673`), idempotent close, never-reused ids, bounded hand-off queue, credit overdraw floor, `Drop` kills and waits (`unix.rs:105-115`).
- Config round-trip: tolerant parse → typed `ConfigWarning`; atomic temp+rename; comment-preserving `toml_edit`; refuses to clobber non-editable TOML; content-hash self-echo latch cleared after external apply (`config_io.rs:90-92, 687`).
- Remote-control socket hygiene: probe-before-unlink, 0700 dir with euid/symlink/non-socket refusal, 0600 socket, 5 s idle timeout, never opened in smoke/perf.
- Input edges: OSC 52 write-only with 1 MiB cap and `?` never answered; OSC 7 `file:` only + `is_dir` re-check at spawn; OSC 1337 badge-only with C0 strip; titles C0/C1-stripped and capped; no `innerHTML`/`eval` anywhere in `app/src`; links ⌘-click + http(s) only + `opener:allow-default-urls`; paste strips `ESC[201~` in capture phase.
- Enhancement materialization: staging + nonce + `.complete` marker + single `rename`, GC, retention; symlinks not followed; p10k gitstatus network pinned off.
- Themes/scripts paths: stem rejects `/ \ .`; scripts depth-capped, symlinks skipped, POSIX-quoted `source` only.
- Updater: HTTPS, genuine minisign pubkey, signing key mandatory in all release modes, `.sig` asserted non-empty.
- `pull_request_target` in `r9-issue-link.yml` is used safely (read perms, base checkout, env-only PR text, regex match).
- Starship sidecar: version + sha256 pinned, re-verified, `-x` guarded.
- Capabilities: clipboard write-only main-only, no fs/shell/http/dialog plugins, no `withGlobalTauri`.
- Test discipline: seam injection (only 9/121 test files use `vi.mock`), 0 assertion-less tests, 0 snapshots, 0 `.only`; hermetic real-PTY fixtures (`zsh -f`, scrubbed env, zombie check via `ps -o stat=`); Tauri-free seams in the shell have 60 tests; `cli_version.rs` runs the real binary with a kill timer.
- Entry ordering: `ctl` forks before any Tauri machinery; smoke/perf modes parsed purely.
- Ports-and-adapters with a fake PTY backend whose drain-then-EOF semantics match the real one.
- Two-window model: main is the authority; settings is a projection with value-strict payload validation and echo guards.

---

## Add-on 1 — Scale stress: 100x traffic, team doubles

"Traffic" for a terminal is bytes/second of output, number of live panes, and remote-control clients. Ordered by what breaks first:

1. **Output throughput (100x → ~100 MB/s bursts).** The JSON `number[]` channel (M4) is the cliff: each 256 KiB batch becomes ~900 KB of `[27,91,...]` text, `JSON.parse`d into a `number[]` at 8 B/element, then copied. The credit window (2 MiB + one batch) will correctly throttle the reader — so the *shell* appears to hang while the JS main thread parses. Backpressure works; the parse cost is the bottleneck. Fix M4 first; it is half a day.
2. **Live panes (100 tabs × splits).** Two costs compound: (a) `App.tsx` fans every reducer dispatch through 20 `useEffect`s and 15 ref-maps (H6); (b) the foreground poller resolved each session via `Command::new("ps")` — **measured and corrected by trmx-263**: the loop ticks every 250 ms, not 1 Hz, and cost **6N forks per four-tick cycle** (one `is_busy` per session every iteration, two `foreground_process` forks per session on every 4th), sequentially on a dedicated thread with the registry lock released — never on the main thread. Because the 250 ms sleep follows the work, the cycle stretched linearly with N: 116 ms / 1.2 s / 7.5 s / 19.2 s of resolution work per cycle at 1 / 10 / 50 / 100 real shells (reference Mac, `tests/poller_cost.rs`). trmx-263 batched it into one `ps -o pid=,tpgid= -p …` per iteration plus one `ps -o pid=,comm= -p …` per title iteration: 96 / 159 / 193 / 237 ms per cycle, flat in N.
3. **Remote-control clients (100x).** One unbounded OS thread per accepted connection and no line-length cap (M16); under `panic = "abort"` a failed `thread::spawn` aborts the app and every PTY with it. Cap workers; `Read::take`.
4. **Config size** is not a concern — the schema is 25 keys and the file is rewritten atomically.

**Team doubles (1 → 2+ contributors):**
- `main.rs` and `App.tsx` are simultaneously the two highest-churn files and the two god files (H5, H6) → merge-conflict serialization begins immediately.
- A new setting touches 6 declaration sites in 3 languages (M6) → the most common feature PR is the most error-prone one; the lockstep tests catch omissions but not the cost.
- Hooks are opt-in and skip frontend tests/clippy (M24); a second contributor who never ran `install-hooks.sh` gets their first feedback from a 30+-minute macOS job.
- Five doc/gate divergences (Red flag 1) mean the second contributor will trust a rule that is not enforced and be corrected in review instead of by a check.
- No coverage number (M20) → no objective way to review a PR's test adequacy.

## Add-on 2 — Hidden costs (5)

1. **Debugging cost — every user bug is a from-scratch reproduction.** 32 backend + ~40 frontend diagnostic sites already exist and already say the right thing; the packaged app discards all of them (H1). The message "shell enhancements unavailable (spawning bare)" has been written and will never be read by the person it is for.
2. **Onboarding cost — the map disagrees with the territory in five places** (hooks README, secret-scan CI claim, R1 scope, golden "MUST NOT drift", socket path in the shipped config template). A contributor reading the docs is *more* likely to be wrong than one reading the code.
3. **Velocity cost — shotgun surgery is measured, not hypothetical.** 13 commits touched `config.rs` + `config_io.rs` + `settingsStore.ts` together; 15/15 recent `main.rs` commits are distinct issues; every pane feature adds a ref-map and a dispose line (H6). Each of these is a tax on *the* most common change types in this product (a setting, a session behavior, a pane feature).
4. **Operational cost — every release is an unverified bet.** 11 releases in 66 days; the release-profile binary (`panic = "abort"`, `lto`, `strip`) has never been executed by CI; the updater auto-downloads; there is no rollback procedure and no revocation path for the signing key. The cost is paid the first time a release-only bug ships to every installed copy at once.
5. **CI cost — the macOS job is the only real gate and it is slow, flaky, and partially cached.** tauri-cli compiles from source on every `Cargo.lock` change (`ci.yml:80-81`), Playwright chromium installs every run (`:105-106`), `retries: 1` hides e2e flake, and the `< 8 ms` assert (`main.rs:2536`) is a known re-run generator. Every re-run is ~30 minutes of a single maintainer's attention.

## Add-on 3 — Principle violations

**Single Responsibility**
- `main.rs` (H5): PTY plane + poller + launch modes + quit gating + builder.
- `App.tsx` (H6): declarative tree owner + runtime pane registry + command context + close guard + activity timers + search.
- `settingsStore.ts` (M8): live store + legacy localStorage backend (test-only) + warnings ledger + migration.
- Config knowledge (M6): six owners for one schema.

**Dependency Inversion**
- `app/src/ipc/backend.ts:18` — the transport layer imports `parseActivityPayload` from `panes/activityLine`: the lowest layer depends on a domain module above it (M7).
- `config_io.rs:455-472` — Rust `ConfigState.last` is `Config::default()` until the *webview* calls `config_read`; the backend's correctness depends on the frontend's boot order, pinned by a JS test (`main.order.test.ts`) — the dependency points the wrong way (L5).
- Three directory cycles `tabs⇄commands`, `scripts⇄commands`, `theme⇄settings` (M7); nothing enforces layering on the frontend, unlike the Rust seam gate.
- R1 itself: the rule says the platform crate is the only `cfg(target_os)` home; the shell crate depends directly on `libc` (M12).

**Least Privilege**
- `"csp": null` (M3): no confinement of a future injection.
- `build.rs` is a bare `tauri_build::build()` — no `AppManifest::commands`, so all 28 app commands (including `open_pty`, `pty_write`, `smoke_done` → `exit(1)`) are callable from the settings window whose own capability description says it "gains no close-by-script surface" (L13).
- A custom `remote_control.socket_path` silently `chmod 0700`s whatever directory it names, including `$HOME` (L12).
- `tauri-action@v0` — the most mutable pin possible — runs with the updater private key and six Apple secrets (M1).
- `${{ github.ref_name }}` interpolated into a `contents: write` shell step (L15).

## Add-on 4 — Strangler fig migration (no big bang)

Each step is an independent PR with no behavior change, gated by the existing tests; the old path stays live until the last step removes it.

**`main.rs` → modules → core**
1. `launch.rs`: move `SpecialLaunch`/`SmokeMode`/`PerfMode`/`CliQuery` + parsers + watchdogs + `smoke_*`/`perf_*` commands (pure, lowest coupling). `generate_handler!` list unchanged.
2. `poller.rs`: `PollerGate`, `poll_tick`, `activity_tick`, `rises_of`, `enrich_rises`, `run_title_poller`, `RealForeground` + their tests.
3. `pty_io.rs`: `PtyState`, `CreditCell`, `next_batch`, `run_batch_sender`, the seven PTY commands.
4. Move the pure halves down (M5): `CreditCell`/`next_batch`/`run_batch_sender` → `termixion-core::pump`; `control_io.rs` → `termixion-core::control`; `should_apply`/`apply_file_text` → `termixion-core::config`. Linux CI now covers them.
5. `ensure_private_dir`/`create_socket` → `termixion-platform`; drop `libc` from the shell; add the `cargo tree --depth 1` gate (M12).

**`App.tsx` → `PaneRuntime`**
1. Add `panes/paneRuntime.ts` with `PaneRuntime` + `Map<PaneId, PaneRuntime>` alongside the existing maps; `disposePaneResources` calls both.
2. Migrate one ref-map per PR, starting with `sessionsRef` + `handlesRef` (the pair every other closure needs). Each PR deletes one `useRef(new Map…)` and one dispose line.
3. When the last map is gone, extract `useCommandContext`, `useCloseGuard`, `usePaneActivity`; regroup the 22 injection props into one `deps` object.

**Config schema (M6)**
1. Add `SCHEMA: &[SettingDef]` in core plus a test asserting the *existing* `toml_path_for`/`value_kind_for`/`diff_configs` agree with it (no production change yet).
2. Emit `config-schema-golden.json` from a core test; make `settingsStore.test.ts` assert `SETTING_DEFAULTS` and types against it.
3. Replace one derived function per PR: `value_kind_for` (delete the shell copy) → `toml_path_for` → `diff_configs` → generic `walk_table`.

**Observability (H1)**
1. Add `tauri-plugin-log` with file + `os_log` targets; nothing else changes.
2. Mechanical `eprintln!` → `log::warn!/error!` (the `termixion:` prefix becomes the target).
3. `log_message` command + error boundary/global handlers forward webview errors (H3).

## Add-on 5 — Success metrics and measurement plan

| Metric | Baseline (today) | Target | How to measure |
|---|---|---|---|
| Bug reports diagnosable from attached log | 0% (no log exists) | ≥ 80% | Issue template asks for `~/Library/Logs/Termixion/`; label `has-log` |
| CI flake rate (re-runs ÷ runs on `main`) | unknown; ≥ 1 known flaky assert | < 2% | `gh run list --workflow ci.yml --json conclusion,attempt` weekly via `scripts/repo-stats.py` |
| Full-gate p50 duration | ~30+ min (per notes) | < 20 min | `gh run list --json durationMs` |
| Release lead time (tag → published) and release-smoke pass rate | manual; 0% smoke on release bundle | 100% smoke-gated; ≤ 30 min | `release.yml` job timings; smoke step exit code |
| Escaped defects per release | not tracked | trend down | Issues labeled `bug` opened ≤ 7 days after each tag, per `CHANGELOG.md` release date |
| PTY throughput p95 (MB/s) and unacked-bytes bound | `--perf` harness exists, numbers in `docs/design/` | ≥ 3x after M4 | `pnpm --filter app perf` before/after; record in ADR-0001 addendum |
| MTTR for user-visible degraded modes (enhancements off, remote control dead) | ∞ (invisible) | user sees cause within one session | M18/M19 warnings emitted; count `config:warnings` kinds in log |
| Code-health guards | `main.rs` 1430 non-test lines; `App.tsx` 2492; config schema sites 6 | `main.rs` < 800; `App.tsx` < 1000; schema sites 1 | `scripts/repo-stats.py` largest-files output; a CI check that fails on growth of these two files is optional |
| Frontend/Rust line coverage | unmeasured | measure now; ratchet +2 pts per release | `vitest --coverage` + `cargo llvm-cov --summary-only` artifacts |
| Doc/gate divergence count | 5 | 0 | A checklist item in `docs/CONTRIBUTING.md`; re-audit quarterly |

## Add-on 6 — Before vs after (components + data flow)

```
BEFORE                                                AFTER
──────────────────────────────────────────────────    ──────────────────────────────────────────────────
termixion-core  (pure; serde+toml)                    termixion-core  (pure; +serde_json)
  config ─ theme ─ pty ─ pump ─ registry ─ zdotdir      config(+SCHEMA table, +should_apply)
        ▲                                                theme ─ pty ─ pump(+CreditCell,next_batch,sender)
        │ (only dep-level seam enforced)                 registry ─ zdotdir ─ control(codec)
termixion-platform  (libc, objc2)                              ▲ gate: cargo tree + token scan (unchanged)
  unix ─ foreground(ps) ─ services                    termixion-platform  (libc, objc2)
        ▲                                                unix ─ foreground ─ services ─ socket(ensure_dir,create)
termixion-tauri                                                ▲ NEW gate: shell may not depend on libc/nix/objc2*
  main.rs (1430 lines: PTY+poller+launch+quit+builder)  termixion-tauri
  config_io ─ control ─ control_io ─ *_io               main.rs (builder + close gate only)
  eprintln! ──► /dev/null (packaged)                    pty_io ─ poller ─ launch ─ config_io ─ control ─ *_io
                                                        log::* ──► tauri-plugin-log ──► ~/Library/Logs + os_log
   │ 28 commands (Result<_,String>)                      │ 28 commands (Result<_,IpcError>), PTY cmds main-only
   │ open_pty: Channel<Vec<u8>> → JSON number[]           │ open_pty: Channel<ArrayBuffer> (raw body)
   ▼                                                     ▼
app/src                                               app/src
  ipc/backend.ts ──imports──► panes/activityLine        ipc/{backend,payloads,window}.ts   (imports nothing above)
  8 other files import @tauri-apps/*                    plugin clients only; eslint no-restricted-paths
  App.tsx (2492: 15 ref-maps, 22 props, 20 effects)     App.tsx (composition) ─ panes/paneRuntime.ts (1 map)
  settingsStore (store+legacy backend+ledger)             hooks: useCommandContext / useCloseGuard / usePaneActivity
  no ErrorBoundary; boot() uncaught                     settingsStore (store+ledger) ─ test/settingsFixture.ts
  csp: null                                             <ErrorBoundary> + onerror/unhandledrejection → log_message
                                                        csp: default-src 'self' …
Data flow (PTY):                                      Data flow (PTY): identical topology, raw bytes on the wire,
  pty → pump → sync_channel(256) → sender → credits     spawn-failure and exit surfaced in-pane, errors typed.
  → Channel(JSON) → JSON.parse → Uint8Array.from
  → term.write → ack → refill
Release: tag ─► build ─► "dmg exists?" ─► publish     Release: tag ─► CI-green check ─► build ─► smoke(release .app)
                                                               ─► publish; rollback runbook; SHA-pinned actions
```

## Add-on 7 — Assumptions audit

| # | Assumption | Held by | Validate by | Cost |
|---|---|---|---|---|
| A1 | Tauri 2.11 `ipc::Response` raw body arrives as `ArrayBuffer` in a `Channel` on WKWebView (M4) | architecture agent | 1-hour spike: change `openPty`, run `--smoke` + `--perf`; check `frame instanceof ArrayBuffer` | 1 h |
| A2 | `tauri::test::MockRuntime` can host the real managed states (`PtyState`, `ConfigState`, `ControlState`) and drive handlers via `get_ipc_response` (H7) | testing agent | Write one test for `config_reset_all` first; if `MockRuntime` cannot manage the states, fall back to the `open_session(...)` extraction path | 2 h |
| A3 | The 1 Hz poller forks `ps` once per session per tick, making it the second scale cliff (Scale stress §2) | **verified by trmx-263: confirmed and corrected** — 250 ms iterations, 6N forks per four-tick cycle (plus two per busy rise), on a dedicated thread, not the main thread; measured against 1/10/50/100 real shells and a 2 s thread sample of a live 13-session instance (37 % of the poller thread awake); batched to 5 forks per cycle | (done: `crates/termixion-platform/tests/poller_cost.rs`, run with `--ignored --nocapture`) | 30 min |
| A4 | The `< 8 ms` assert at `main.rs:2536` is the "known PTY-sender CI flake" | testing agent (strong circumstantial) | `gh run list --status failure` → grep logs for "idle send must be immediate-ish" | 15 min |
| A5 | A `script-src 'self'` CSP does not break xterm's WebGL addon or Vite's injected styles (M3) | security agent | Run Playwright + packaged `--smoke` with the proposed CSP; expect `style-src 'unsafe-inline'` to be required | 2 h |
| A6 | Users on the unsigned alpha actually take updates through the updater (so H8's rollback gap is live) | recon/README | GitHub release asset download counts per version vs. `latest.json` fetches (not observable without telemetry) — treat as **true** by default and gate releases regardless | — |
| A7 | The project stays single-author for the next release line | git history | Re-check when a second contributor appears; that is the trigger for M24 (hooks) and M7 (layering lint) to jump priority | — |
| A8 | macOS-only remains the product scope, so Linux CI covering only core is acceptable | recon (v0.1.1 note) | If Linux returns, M5 (pure seams in core) becomes HIGH, since it is what makes the Linux job meaningful | — |
| A9 | `toml 1.1.2` (read) and `toml_edit 0.25.12` (write) parse the same dialect | architecture agent (L3) | Round-trip `DEFAULT_TEMPLATE` through `toml_edit` → `parse_config` and assert zero warnings, as a core test | 1 h |
| A10 | The 8 `.zwc` blobs are byte-identical to what p10k would compile from the vendored `.zsh` (L14) | nobody | `zcompile` the sources in a clean shell and `cmp` — or simply delete them and let p10k recompile | 30 min |

## Add-on 8 — Compact & optimize

Code that can be removed, merged, or derived (all traceable to ledger IDs):

| What | Where | Lines saved / effect | ID |
|---|---|---|---|
| Three copy-pasted `notify` watcher loops → one `fs_watch::run_debounced` | `config_io.rs:607-662`, `themes_io.rs:224-275`, `scripts_io.rs:167-210` | ~100 lines; one debounce policy | L7 |
| Test-only `makeLegacyStorageStore` out of production | `settingsStore.ts:658-733` | ~75 lines (~10% of the module) | M8 |
| `set_session_title` + `mirrorTitle` + `mirroredRef` + `Session::set_title` — no reader exists | `main.rs:841-855`, `registry.rs:122-130`, `App.tsx:580` | one IPC per title change, one injection prop, ~40 lines | L6 |
| Shell-side `value_kind_for` table — derive from the core schema | `config_io.rs:137-166` | 25 duplicated arms; one of six schema sites | M6 |
| `ConsumeOutcome` enum whose only caller discards it | `main.rs:764` | make `consume_floored` return `()`; keep enum test-only | L4 |
| Duplicate theme golden fixture → import the core file | `app/src/theme/__fixtures__/theme-golden.json` | one file; drift impossible | M21 |
| Eight compiled `.zwc` blobs (one is 816 KB) embedded in the binary via `include_dir` | `resources/shell-enhancements/**/*.zwc` | smaller binary, reviewable tree; p10k recompiles once per version dir (~100 ms) | L14 |
| Three config read paths → one `config_io::hydrate(app)` | `config_io.rs:497-529`, `main.rs:1331-1332`, `config_io.rs:527` | one read at startup; Rust self-consistent | L5 |
| JSON `number[]` PTY frames → raw `ArrayBuffer` | `backend.ts:47,98`, `main.rs:677,765` | ~3.5x less IPC bandwidth; no per-byte parse | M4 |
| 22 `App` injection props → one `deps` object | `App.tsx:363-408` | readability; done with H6 step 3 | H6 |
| Orphan `scripts/repo-stats.test.py` — run it or delete it | `scripts/` | — | L9 |
| `@types/node ^26` → `^24` to match `.nvmrc` | `app/package.json` | correct types | L3 |
| Five doc/gate claims → align text with reality (or add the gate) | hooks README, `secret-scan.sh:4`, R1, `themeSpecGolden.test.ts:4-7`, `config.rs:492`/`docs/remote-control.md:30,34` | onboarding trust | Red flag 1 |

---

## Executive summary

**Verdict.** Termixion is a well-engineered alpha with an unusually disciplined core: no panics, a correct PTY data plane with real backpressure, atomic comment-preserving config writes, hardened input edges, and a test culture that injects seams instead of mocking (26k test lines, 0 assertion-less tests). Nothing warrants a rewrite. The biggest risk is not in the code that runs — it is that **the packaged app cannot tell anyone when it degrades, cannot be quit if its webview dies, ships from a release pipeline that never executes what it publishes, and pulls its signing key through mutable third-party action tags.** Second is structural: the two most-changed files are god files, and a routine new setting touches six declaration sites in three languages — with one author today, this is a tax; with two, it is a merge-conflict machine.

**Top 3 actions (if only three):**
1. **Ship the observability bundle (H1 + H2 + H3 + H4, ~4 days).** Add `tauri-plugin-log`, a Rust-side quit fallback, an error boundary, and in-pane spawn failures. Every other bug in this report becomes diagnosable from a user's log, and the app can always be quit.
2. **Lock the supply chain and the release (M1 + M2 + H8, ~4 days).** SHA-pin actions (half a day; closes the signing-key exfiltration path), add `cargo deny`/`pnpm audit`/Dependabot, smoke-test the release-profile bundle, gate tags on green CI, write the rollback runbook.
3. **Decompose the two god files and push pure logic down (H5 + M5 + H6 step 1, ~2.5 weeks).** Split `main.rs` into `pty_io`/`poller`/`launch`, move the Tauri-free seams into core so Linux CI covers them, and consolidate `App.tsx`'s 15 ref-maps into one `PaneRuntime`. Do M6 (single config schema) immediately after.

**Confidence.**
| Recommendation | Confidence | What would raise it |
|---|---|---|
| Observability bundle (H1–H4) | **High** — every claim verified by grep (no log dep, `let _ = emit_to`, 0 error boundaries, `console.error`-only catch) | Nothing needed |
| SHA-pin + audit + release gate (M1, M2, H8) | **High** — `@v0` pins, absent audit config, and absent release smoke confirmed directly | Nothing needed |
| Split `main.rs` / move seams to core (H5, M5) | **High** on the diagnosis (line ranges + churn data), **Medium** on the exact module cut | Do `launch.rs` first; if it lands cleanly the rest follows the same shape |
| `App.tsx` PaneRuntime (H6) | **Medium** — the 15 maps are verified; the refactor's cost depends on how many closures capture multiple maps | Attempt the `sessionsRef`+`handlesRef` pair first and measure the diff |
| Raw-bytes channel (M4) | **Medium** — the inflation is certain; ArrayBuffer delivery on WKWebView is assumption A1 | The 1-hour spike in A1 |
| Handler tests via MockRuntime (H7) | **Medium** — the gap is certain; the harness is assumption A2 | One `config_reset_all` test |
| Scale cliff #2 (`ps` per session) | **Measured (trmx-263)** — confirmed, worse than inferred (6N per cycle, cycle stretching linearly), and fixed: 5 forks per cycle regardless of N | `tests/poller_cost.rs` (kept as an ignored measurement) |
| CSP (M3) | **Medium** — value is certain; friction with xterm WebGL/Vite is assumption A5 | Run e2e + smoke with the proposed policy |

---

## Fixing Plan

Every item traces to a ledger ID above. Effort is single-developer working days.

### Phase 1: Critical fixes (do immediately)

No `[CRITICAL]` findings. Phase 1 is empty by evidence, not by omission — no exploitable vulnerability, data-loss path, or data-plane correctness bug was found by any agent or by verification.

### Phase 2: High-priority fixes (this sprint)

- **H2 — Quit depends on a live webview**
  - Fix: JS `invoke("close_acknowledged")` on `close:requested`; in `PreventAndAsk` record the ask time, authorize teardown on a second gesture after ~3 s without ack, authorize immediately if `emit_to` errs; route `RunEvent::ExitRequested` through the same gate.
  - Effort: 0.5 d
  - Files: `crates/termixion-tauri/src/main.rs:1126-1170,1394-1397`, `crates/termixion-tauri/src/menu.rs:225-234`, `app/src/App.tsx:1567-1581`, `app/src/ipc/backend.ts`
- **H3 — No error boundary / global handlers**
  - Fix: class `ErrorBoundary` rendering "shells still running — [Reload] [Quit]" (Quit → `quit_confirmed`); `window.addEventListener("error"|"unhandledrejection")`; `boot().catch(...)`; validate `ControlRequest` payloads instead of casting.
  - Effort: 0.5 d
  - Files: `app/src/main.tsx:85-96`, new `app/src/chrome/ErrorBoundary.tsx`, `app/src/App.tsx:301`
- **H4 — Silent dead pane on spawn failure**
  - Fix: write the error into the pane and mark it dead; in `open_pty`, when `cwd` is not a directory retry with `cwd = None` and emit a one-line notice.
  - Effort: 0.5 d
  - Files: `app/src/App.tsx:790-795`, `crates/termixion-tauri/src/main.rs:676-780`, `crates/termixion-platform/src/unix.rs:134-141`
- **H1 — No logging sink**
  - Fix: add `tauri-plugin-log` (LogDir + os_log, Stdout in dev); replace 32 `eprintln!` with `log::*`; `log_message(level, msg)` command called from H3's handlers; "Open log folder" row in About.
  - Effort: 3 d
  - Files: `crates/termixion-tauri/Cargo.toml`, `crates/termixion-tauri/src/main.rs` (plugin registration + `:1312,1336,1344,1425`), `config_io.rs:517,612,618,640,645,668`, `control.rs:188-200`, `enhancements_io.rs:226`, `themes_io.rs:167,231,250,255`, `scripts_io.rs:172,189,194`, `crates/termixion-tauri/capabilities/default.json` (`log:default`), `app/src/settings/AboutSettings.tsx`
- **H8 — Release never executed; no CI gate; no rollback**
  - Fix: after `tauri-action`, run `bash scripts/smoke.sh <release .app>`; add a first job asserting the tagged SHA has a successful `full gate (macos)` check run and make `build-macos` `needs` it; write the rollback + key-compromise runbook.
  - Effort: 3 d
  - Files: `.github/workflows/release.yml:17-19,99-140,189-205`, `scripts/smoke.sh`, `docs/RELEASE.md`
- **H7 — 28 handlers untested**
  - Fix: `tauri = { features = ["test"] }` dev-dep; `mock_builder()` app with real managed states; tests for `config_write` latch order, `config_reset_all`, `open_settings_window` singleton, `control_response` pop; extract `open_session(...)` from `open_pty` and pin credit-insert-before-spawn + `on_done` exactly-once; make `bridge_to_webview` generic over `emit` and add a `UnixStream` round-trip test; temp-dir rename-replace test per watcher.
  - Effort: 4 d
  - Files: `crates/termixion-tauri/Cargo.toml`, `main.rs:676-780`, `config_io.rs:533-712`, `control.rs:219-330`, `window_manager.rs:70-103`, `themes_io.rs:224`, `scripts_io.rs:167`
- **H5 — `main.rs` god file**
  - Fix: extract `launch.rs` → `poller.rs` → `pty_io.rs` (in that order; tests move with code; `generate_handler!` unchanged).
  - Effort: 4 d
  - Files: `crates/termixion-tauri/src/main.rs:49-1429`, new `launch.rs`, `poller.rs`, `pty_io.rs`
- **H6 — `App.tsx` 15 ref-maps (step 1)**
  - Fix: `panes/paneRuntime.ts` with `PaneRuntime` + single `Map<PaneId, PaneRuntime>`; migrate one map per PR starting with `sessionsRef`+`handlesRef`; delete `disposePaneResources` lines as maps disappear. (Step 2 — hook extraction + `deps` object — is Phase 3 scope, ~15 d.)
  - Effort: 5 d
  - Files: `app/src/App.tsx:553-598,947-985`, new `app/src/panes/paneRuntime.ts`, `app/src/App.test.tsx`

### Phase 3: Medium-priority improvements (next sprint)

- **M1** — SHA-pin every `uses:` (comment the tag); `.github/dependabot.yml` for `github-actions`. 0.5 d. Files: `.github/workflows/ci.yml:26,29,53,56,67,70-74`, `release.yml:35,73-77,101,117,150,162`, `r9-issue-link.yml`.
- **M2** — `deps-audit` job: `cargo deny check advisories bans licenses` (+`deny.toml`), `pnpm audit --prod --audit-level=high`; Dependabot for `cargo`/`npm` grouped weekly. 0.5 d. Files: `.github/workflows/ci.yml`, new `deny.toml`, `.github/dependabot.yml`.
- **M3** — CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src ipc: http://ipc.localhost; worker-src 'self' blob:` + `devCsp`; run e2e + smoke. 3 d. Files: `crates/termixion-tauri/tauri.conf.json:22-24`.
- **M4** — `tauri::ipc::Response::new(batch)`; `new Channel<ArrayBuffer>()`; `decodePtyFrame = new Uint8Array(frame)`; `--perf` before/after; ADR-0001 addendum. 0.5 d. Files: `main.rs:677,765`, `app/src/ipc/backend.ts:47,53,98`, `docs/adr/0001-pty-transport.md`.
- **M5** — Move `CreditCell`/`ConsumeOutcome`/`next_batch`/`run_batch_sender` → `core::pump`; `control_io.rs` → `core::control` (+`serde_json`); `should_apply`/`apply_file_text` → `core::config`. 4 d. Files: `main.rs:501-673`, `control_io.rs`, `config_io.rs:79-118`, `crates/termixion-core/src/{pump,config}.rs`, new `core/src/control.rs`, `core/Cargo.toml`.
- **M6** — `SCHEMA: &[SettingDef]` in core; derive `toml_path_for`/`value_kind_for`/`diff_configs`/`walk_table`; golden JSON asserted by `settingsStore.test.ts`. 4 d. Files: `config.rs:172-380,529-1043`, `config_io.rs:137-166`, `settingsStore.ts:75-131,159-200,270-385`, new `crates/termixion-core/tests/config_schema_golden.rs`.
- **M7** — `ipc/window.ts` (from `App.tsx:225-243`), `ipc/payloads.ts` (from `panes/activityLine`), break `tabs⇄commands` (`chordGlyphs` → `keys/`), `scripts⇄commands` (`fuzzy` + `PaletteOverlay` → `ui/`), `theme⇄settings` (`settings/types.ts`); `eslint-plugin-import` `no-restricted-paths`. 4 d. Files: listed at M7 in the ledger, `app/eslint.config.js`.
- **M8** — `makeLegacyStorageStore` → `app/src/test/settingsFixture.ts`; `createSettingsRuntime()` constructed in `main.tsx`. 3 d. Files: `settingsStore.ts:20-23,443-452,524-539,658-733`, dependent suites.
- **M9** — `reader.read_line(&mut buf)`. 0.25 d. Files: `control.rs:376-389`.
- **M10** — `CONTROL_COMMANDS` allowlist + test vs `buildCommands()`; document in `docs/remote-control.md`. 0.5 d. Files: `app/src/control/controlBridge.ts:13`, `crates/termixion-tauri/src/control_io.rs:59-70`, `docs/remote-control.md`.
- **M11** — Fix four text sites; core test asserting `DEFAULT_TEMPLATE` contains `socket_path_from(None, "~")`; move `socket_path_from` to core. 0.25 d. Files: `config.rs:196,492`, `docs/remote-control.md:30,34`, `docs/config.md:83`, `control.rs:79-86`.
- **M12** — Move `ensure_private_dir`/`create_socket` to platform; drop `libc` from shell; `cargo tree -p termixion-tauri --depth 1` gate; reword R1. 0.5 d. Files: `control.rs:101-167`, `crates/termixion-tauri/Cargo.toml:27`, `crates/termixion-platform/src/`, `scripts/check-core-seam.sh`, `.claude/rules/architecture.md`.
- **M13** — `IpcError { kind, message }` with `From<PtyError>`; typed `BackendError` in `backend.ts`; `NotFound`/`NotRunning` on write/resize → debug level. 3 d. Files: `main.rs:785-856`, `app/src/ipc/backend.ts:138-168`, `useBackend.ts:141-149`, wire-shape golden tests.
- **M14** — On `config_write` rejection: `clientWarnings.set(key, …)` + `publishConfigWarnings()`. 0.5 d. Files: `settingsStore.ts:614-618,846-850,916-919`.
- **M15** — Match on read error: `NotFound` → re-read after ~100 ms; other → log + skip; `ConfigWarning::Unreadable` with `exists: true`. 0.5 d. Files: `config_io.rs:498-502,664-666`, `crates/termixion-core/src/config.rs` (warning variant), `settingsStore.ts` hydrate path.
- **M16** — Log accept errors; retry `Interrupted`/`ConnectionAborted`; `dead` flag checked by `apply_remote_control`; worker cap (~16) via `Builder::spawn`; `Read::take(64 KiB)` before `lines()`. 0.5 d. Files: `control.rs:172-190,231-245,263`.
- **M17** — Document at-least-once on `timeout`; make timeout configurable/longer for mutating verbs; log late responses; optional idempotency key. 0.5 d. Files: `control.rs:33,306-327`, `docs/remote-control.md`.
- **M18** — Emit materialization failures on `config:warnings`; `enhancements_status` command shown next to toggles; shim prints one line when a flagged plugin is unreadable. 0.5 d. Files: `enhancements_io.rs:222-229`, `zdotdir.rs:98-104,137-141`, `app/src/settings/TerminalSettings.tsx`.
- **M19** — Main-window `config:warnings` subscriber + title-bar badge. 0.5 d. Files: `app/src/App.tsx`, `app/src/chrome/TitleBar.tsx`.
- **M20** — `@vitest/coverage-v8` + thresholds; `cargo llvm-cov --summary-only` advisory; upload artifacts; then add tests for `PaletteOverlay.tsx`, `conformance/driver.ts`, `clampNumberSetting`/`isTabBarPosition`. 1 d measure (+3 d ratchet). Files: `app/vite.config.ts:20-26`, `app/package.json`, `.github/workflows/ci.yml:90-93`.
- **M21** — Import core golden directly (or `toEqual` the two); assert `spec.terminal.search` consumed by `deriveTheme`. 0.5 d. Files: `app/src/theme/themeSpecGolden.test.ts`, delete `app/src/theme/__fixtures__/theme-golden.json`.
- **M22** — Inject a clock into `run_batch_sender`; assert decisions not elapsed; `CreditCell` tests use large slices; Vitest fake timers for negative assertions; `runPerf` fake `delay` → `Promise.resolve()`. 3 d. Files: `main.rs:2001-2020,2343-2360,2396-2411,2477-2540`, `useUpdateAuthority.test.tsx`, `runPerf.test.ts:196-211`, `runPerf.ts:196-217`.
- **M23** — `app/e2e/fixtures/tauriFake.ts` (`addInitScript` `__TAURI_INTERNALS__.invoke` from fixtures); use in settings/theme/shell specs; grow `--smoke` scenarios (`config_write` round-trip, `open_settings_window`, `ctl version`); upload `test-results` on failure; `retries: 0`. 4 d. Files: `app/playwright.config.ts`, `app/e2e/*.spec.ts`, `app/src/smoke/runSmoke.ts`, `scripts/smoke.sh`, `ci.yml:105-108`.
- **M24** — pre-commit += `cargo fmt --check`, `pnpm --filter app lint`; pre-push += `pnpm --filter app test`, `cargo clippy --workspace --all-targets -- -D warnings`; fix README. 0.5 d. Files: `.claude/hooks/pre-commit`, `pre-push`, `README.md`, `docs/CONTRIBUTING.md:58-60`.

### Phase 4: Low-priority cleanup (when touching these files)

- **`crates/termixion-tauri/src/control.rs`**: L2 promote the `lock()` helper (`:72-74`) crate-wide; L12 require a pre-existing 0700 parent for custom `socket_path` (`:88-130`).
- **`crates/termixion-tauri/src/config_io.rs` / `themes_io.rs` / `scripts_io.rs`**: L1 on watcher `Err`/rescan, log and send a wake; L7 one `fs_watch::run_debounced`; L5 `config_io::hydrate(app)` in `setup()` and `keys_read` from cached state.
- **`crates/termixion-tauri/src/main.rs`**: L4 `consume_floored` → `()` (`:764`); L6 delete `set_session_title` mirror (`:841-855`) + `App.tsx:580` + `registry.rs:122-130`; L13 `AppManifest::commands` in `build.rs` and PTY `allow-*` only in `main-window.json`; gate `smoke_done`/`perf_done` on launch mode; L2 mutex policy (`:336-340`).
- **`crates/termixion-core/src/lib.rs`**: L8 `#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]`; update R3 text.
- **`app/package.json` / `crates/termixion-core/tests`**: L3 `@types/node ^24`; round-trip `DEFAULT_TEMPLATE` through `toml_edit` → `parse_config` zero-warnings test.
- **`app/src/main.tsx` / `main.order.test.ts`**: L10 extract `boot(deps)` to `app/src/boot.ts`; test call order with a recorder.
- **`app/src/terminal/osc52.ts` / `config.rs`**: L11 `terminal.clipboard_write = allow|deny` + transient badge on OSC 52 write.
- **`resources/shell-enhancements/` / `THIRD_PARTY.md`**: L14 delete 8 `.zwc`; CI assert none committed; per-plugin tarball sha256.
- **`.github/workflows/release.yml`**: L15 `env: TAG` at `:178,200,204`.
- **`.github/workflows/ci.yml` / `scripts/secret-scan.sh`**: L16 `--range` mode run in CI (or SHA-pinned gitleaks); L9 `timeout-minutes: 60`, `permissions: contents: read`, cache Playwright + tauri-cli, run `repo-stats.test.py`.

### Dependency graph

- **H3 depends on H1** for forwarding webview errors to the log (the boundary itself can ship first with `console.error`).
- **M13 (typed IpcError) should follow H1** so `kind` is what gets logged, and **precedes M14/M15** only cosmetically — they can ship independently.
- **M5 depends on H5**: split `main.rs` first, then move the pure halves of the new modules into core in the same pass.
- **M12 depends on M5's control move** only if `ensure_private_dir` moves in the same PR; otherwise independent.
- **H7 depends on A2 (MockRuntime spike)**; the `open_session` extraction part of H7 is easier after H5 creates `pty_io.rs`.
- **H6 step 2 (hooks) depends on H6 step 1 (map consolidation)**; **M7's `ipc/window.ts` move** should land before H6 step 2 so the new hooks import from `ipc/` only.
- **M6 depends on nothing**, but **M21's pattern (golden JSON asserted cross-tree)** is the template M6 reuses — do M21 first (half a day).
- **M4 depends on A1 (ArrayBuffer spike)**; re-run `--perf` from **M22-fixed** harness to trust the numbers.
- **M23 depends on M13** for the fake runtime's error shapes to match production.
- **H8's CI-green gate depends on L9's `permissions:` block** granting `checks: read`.
- **M24 hooks** should wait for **M22** — otherwise pre-push inherits the flaky asserts.

### Estimated total effort

- Phase 1: **0 days** (no CRITICAL findings)
- Phase 2: **20.5 days** (H6 step 1 only; +15 days for H6 step 2 if scheduled)
- Phase 3: **~38 days** (M1–M24; M20's ratchet counted as +3)
- Phase 4: **~6 days** (opportunistic, 16 items at ~0.3–0.5 d)
- **Total: ~65 days** single-developer (≈ 80 with the full `App.tsx` decomposition). The 80/20 plan in §B delivers the bulk of the risk reduction in **~29 days**.
