# Vendored zsh enhancement plugins (trmx-206)

Pinned upstream releases, vendored verbatim (licenses alongside; `.gitattributes` keeps them
byte-exact). Embedded into the app binary (`enhancements_io.rs`) and materialized under
`~/.config/termixion/shell-enhancements/versions/<key>/` at spawn time — never installed into,
and never touching, any user rc file.

| Directory | Upstream | Release | License |
| --- | --- | --- | --- |
| `zsh-autosuggestions/` | zsh-users/zsh-autosuggestions | v0.7.1 | MIT |
| `zsh-syntax-highlighting/` | zsh-users/zsh-syntax-highlighting | 0.8.0 | BSD-3-Clause |

The `highlighters/` tree layout is preserved exactly — the main script resolves it relative to
its own path. Fetched 2026-07-21.
