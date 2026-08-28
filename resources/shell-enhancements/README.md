# Vendored zsh enhancement plugins (trmx-206)

Pinned upstream releases, vendored verbatim (licenses alongside; `.gitattributes` keeps them
byte-exact). Embedded into the app binary (`enhancements_io.rs`) and materialized under
`~/.config/termixion/shell-enhancements/versions/<key>/` at spawn time — never installed into,
and never touching, any user rc file.

| Directory | Upstream | Release | Archive sha256 | License |
| --- | --- | --- | --- | --- |
| `zsh-autosuggestions/` | zsh-users/zsh-autosuggestions | v0.7.1 | `0df7afff…503badf` | MIT |
| `zsh-syntax-highlighting/` | zsh-users/zsh-syntax-highlighting | 0.8.0 | `5981c19e…aee9cc32` | BSD-3-Clause |
| `powerlevel10k/` | romkatv/powerlevel10k | v1.20.0 (runtime zsh subset — NO gitstatusd binaries, no wizard, no installer scripts; the shim pins `POWERLEVEL9K_DISABLE_GITSTATUS=true` + `GITSTATUS_AUTO_INSTALL=0` so the zsh-native fallback is used and nothing is ever downloaded) | `d8187d44…780a2d3d7` | MIT |
| `pure/` | sindresorhus/pure | v1.23.0 (`prompt_pure_setup`, `async` — the upstream-documented promptinit fpath names for `pure.zsh`/`async.zsh`) | `b316fe5a…d67877921` | MIT |

Full hashes and what they do (and do not) establish: [`THIRD_PARTY.md`](../../THIRD_PARTY.md).

The `highlighters/` tree layout is preserved exactly — the main script resolves it relative to
its own path. Plugin trees fetched 2026-07-21; prompt trees (trmx-207) fetched 2026-07-21.

## No compiled wordcode (trmx-240)

**Never commit `.zwc` files here.** zsh loads a `.zwc` in preference to the `.zsh` beside it whenever
the wordcode is not older, so a committed blob — not the reviewable source — is what executes in the
user's shell. Upstream powerlevel10k does not ship them either; it compiles its own on first load
(`powerlevel10k.zsh-theme:61-74`) into the materialized version directory, which is user-writable.

Measured cost of that one-time compile (macOS, warm page cache, `zsh -f` sourcing the theme
directly): **first load 307 ms, second load 78 ms — a ~229 ms one-time difference**, paid once per
materialized version, not per session. The issue that removed the blobs estimated ~100 ms; this is
the measured figure and is indicative rather than a guarantee (a cold first launch will differ).

**Three guards, and the third is the one that actually protects the shipped app.**

1. `*.zwc` is in `.gitignore`. It earns its place: `crates/termixion-platform/tests/common/mod.rs`
   points the real-PTY tests at this tree DIRECTLY, so `cargo test -p termixion-platform` leaves
   freshly-compiled wordcode here.
2. `scripts/check-no-zwc.sh` fails on any TRACKED `.zwc`. It runs in the **required** `core seam
   guard` job, so it blocks a merge rather than merely reporting.
3. **`enhancements_io::is_embeddable` refuses to embed or materialize `.zwc` at all.** This is the
   load-bearing one, because the first two are git-side and `include_dir!` is a FILESYSTEM macro —
   it embeds whatever is on disk, and neither `.gitignore` nor a `git ls-files` gate has any say.
   CI's macOS job runs the tests (which write wordcode here) BEFORE the packaged build, so without
   this filter a test-then-build sequence would ship the very blobs trmx-240 removed while every git
   guard reported clean. Pinned by `a_materialized_tree_contains_no_wordcode`.
