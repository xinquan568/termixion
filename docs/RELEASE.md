# Release runbook

A-1 skeleton placeholder. Filled in by the P0 / E tasks (plan §3, §8):

- **Apple Team ID** (P0-1).
- **Signing + notarization** secret contract and the exact CI keychain import + `notarytool` validation
  (P0-2).
- **Distribution:** GitHub Releases only for Alpha (Q-e); macOS CI on GitHub-hosted `macos-14` (Q1).
- **Release-on-tag** pipeline: bootstrap `cargo tauri` -> build -> codesign -> notarize -> staple ->
  `.dmg` -> publish GitHub Release; artifact verification via `stapler validate` + `spctl` (E-2).

## Release metadata (E-2a)

The `v0.0.1` release identity is fixed and **machine-checked** by
[`scripts/check-release-metadata.sh`](../scripts/check-release-metadata.sh) (run it in CI before a
release build):

| Field | Value | Where |
|---|---|---|
| Version | `0.0.1` | `Cargo.toml` `[workspace.package]` (source of truth), `app/package.json`, `tauri.conf.json` |
| Product name | `Termixion` | `tauri.conf.json` `productName` |
| Bundle identifier | `dev.termixion.app` | `tauri.conf.json` `identifier` |
| Release asset | **`Termixion_0.0.1_aarch64.dmg`** | the only artifact for v0.0.1 (Apple-silicon only; Q-g M1 Pro) |

The script asserts the three version fields are equal and that `identifier` / `productName` exactly match
`dev.termixion.app` / `Termixion` (so a rename can't slip through), then prints the expected asset name.
Any drift fails the check (and, once wired, the release job).

> **Bundle target.** Normal/local `cargo tauri build` produces the `.app` only (`bundle.targets: ["app"]`
> in `tauri.conf.json`, to keep local builds fast). The **`.dmg` is produced by the E-2 release pipeline**,
> which must build with the `dmg` bundle target (via `tauri-action` / a release-only bundle target). E-2
> owns producing and verifying that `.dmg`; E-2a only fixes its name + identity.

## Release profile (E-3)

`[profile.release]` in the workspace `Cargo.toml` is tuned for a small, fast desktop binary: `opt-level=3`,
`lto="thin"`, `codegen-units=1`, `panic="abort"`, `strip=true`. (`panic="abort"` is auto-overridden to
unwind for test/bench, so `cargo test` is unaffected.) Installed size is printed in CI as an **advisory**
NFR-2 smoke, not a gate, for v0.0.1.
