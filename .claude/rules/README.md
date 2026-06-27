# Architecture rules (filled in by task A-4)

A-1 skeleton placeholder. **A-4** encodes the load-bearing invariants here (modeled on ClauDepot's
`.claude/rules/`, authority §7.4):

- **pure-core / thin-shell boundaries**; `termixion-core` stays platform-agnostic.
- **no `cfg(target_os=…)` / platform crates in `termixion-core`** (enforced by
  `scripts/check-core-seam.sh`, D-1).
- **no `unwrap()`/`expect()` in `termixion-core`** non-test code.
- **ISC license header on every new source file.**
- secret-scanning expectations; design-token discipline once theming lands (Beta).
