# ADR-0002 — no built-in chezmoi/dotfile-manager integration

- Status: accepted (trmx-208, 0.1.1)
- Context: the 0.1.1 shell-experience overhaul (trmx-204…207) evaluated bundling
  [chezmoi](https://www.chezmoi.io/) (MIT, a single Go binary) so users could manage dotfiles
  inside Termixion without visiting an external site.

## Decision

Keep chezmoi **external**. No sidecar, no wrapper UI, no detection nag. Termixion neither ships
nor drives any dotfile manager.

## Why

- **A terminal emulator is already the ideal chezmoi UI.** Its value — git sync, templates,
  secrets-manager and editor round-trips, interactive `chezmoi init` auth — lives on the command
  line, which Termixion *is*. Wrapping that in app chrome adds a large surface to save the user
  one `brew install chezmoi` typed into our own terminal.
- **The size/benefit ratio fails.** A chezmoi sidecar is ~25–30 MB — roughly three times the
  Starship sidecar the overhaul *did* accept (~9 MB, trmx-207), for a niche of a niche.
- **Independence is a feature.** The shell-enhancement layer (trmx-206/207) deliberately never
  edits a user's rc files — the ZDOTDIR shim stays transparent, so chezmoi-managed homes keep
  working untouched. Embedding a dotfile *writer* would cut against the very guarantee that makes
  the enhancements safe.

## Consequences

- Users who want chezmoi install it themselves; `~/.config/termixion/termixion.toml` is a file
  worth adding to a dotfiles repo (see [`docs/config.md`](../config.md)).
- The shell-enhancement layer remains dotfile-manager-agnostic by construction; nothing in
  Termixion needs to know or care which manager owns the user's rc files.

## Revisit if

Genuine, repeated user demand for in-app dotfile management appears — or the more useful inverse
ships first: an "export/track Termixion's own config in your dotfiles" affordance. Either would
be a new ADR taking the next free number.
