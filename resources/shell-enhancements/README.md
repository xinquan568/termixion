# Vendored zsh enhancement plugins (trmx-206)

Pinned upstream releases, vendored verbatim (licenses alongside; `.gitattributes` keeps them
byte-exact). Embedded into the app binary (`enhancements_io.rs`) and materialized under
`~/.config/termixion/shell-enhancements/versions/<key>/` at spawn time — never installed into,
and never touching, any user rc file.

| Directory | Upstream | Release | License |
| --- | --- | --- | --- |
| `zsh-autosuggestions/` | zsh-users/zsh-autosuggestions | v0.7.1 | MIT |
| `zsh-syntax-highlighting/` | zsh-users/zsh-syntax-highlighting | 0.8.0 | BSD-3-Clause |
| `powerlevel10k/` | romkatv/powerlevel10k | v1.20.0 (runtime zsh subset — NO gitstatusd binaries, no wizard, no installer scripts; the shim pins `POWERLEVEL9K_DISABLE_GITSTATUS=true` + `GITSTATUS_AUTO_INSTALL=0` so the zsh-native fallback is used and nothing is ever downloaded) | MIT |
| `pure/` | sindresorhus/pure | v1.23.0 (`prompt_pure_setup`, `async` — the upstream-documented promptinit fpath names for `pure.zsh`/`async.zsh`) | MIT |

The `highlighters/` tree layout is preserved exactly — the main script resolves it relative to
its own path. Plugin trees fetched 2026-07-21; prompt trees (trmx-207) fetched 2026-07-21.
