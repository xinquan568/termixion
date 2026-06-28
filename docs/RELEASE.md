# Release runbook

**Distribution (Alpha, Q-e / Q-g / Q1):** GitHub Releases only; one **Apple-silicon** (`aarch64`)
artifact — `Termixion_0.0.1_aarch64.dmg` — built + signed + notarized on GitHub-hosted `macos-14`. The
pipeline is [`.github/workflows/release.yml`](../.github/workflows/release.yml) (E-2). It triggers on a
pushed `v*` tag.

> ⚠️ **The repo ships the pipeline but NOT the secrets.** Signing/notarization credentials live **only**
> as GitHub Actions secrets (R5 / P0-2); `.gitignore` blocks `*.p12`/`*.p8`/`*.cer`/`*.mobileprovision`
> and the secret-scan hook refuses key material. **Until a maintainer adds the six secrets below, the
> release job fails fast at its first step** ("Require signing secrets") — by design, so an unsigned /
> un-notarized build can never be published by accident.

## Required GitHub Actions secrets

Set these under **Settings → Secrets and variables → Actions** on `xinquan568/termixion`. All six are
required; the workflow's guard step lists any that are missing and refuses to build.

| Secret | What it is | How to get it |
|---|---|---|
| `APPLE_CERTIFICATE` | Base64 of your **Developer ID Application** cert as a `.p12` | Export the cert+key from Keychain Access to `cert.p12`, then `base64 -i cert.p12 \| pbcopy`. |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set on that `.p12` export | Chosen at export time. |
| `APPLE_SIGNING_IDENTITY` | The exact identity string | `Developer ID Application: <Your Name> (<TEAMID>)` — run `security find-identity -v -p codesigning` to copy it verbatim. |
| `APPLE_ID` | Apple Developer account email (for notarization) | Your Apple Developer login. |
| `APPLE_PASSWORD` | An **app-specific password** for `notarytool` (not your Apple ID password) | Create at [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security → App-Specific Passwords. |
| `APPLE_TEAM_ID` | Your 10-character Apple Developer Team ID (P0-1) | [developer.apple.com](https://developer.apple.com) → Membership. |

> **App Store Connect API key alternative.** Instead of `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID`
> you may notarize with an API key (`APPLE_API_ISSUER` + `APPLE_API_KEY` + `APPLE_API_KEY_PATH`). If you
> prefer that path, swap those three into the workflow's `env:` and the guard-step list. The default
> wired here is the Apple-ID path.

## How a release happens

1. Land everything for the version on `main` (CI green — see `.github/workflows/ci.yml`, E-1).
2. Confirm the version identity is consistent: `bash scripts/check-release-metadata.sh` (also run as a
   gate inside the release job). Bump the version in the three places it checks if needed (E-2a).
3. Tag and push: `git tag v0.0.1 && git push origin v0.0.1`. **The tag must be `v<crate version>`** —
   the gate asserts `github.ref_name == v<workspace.package version>`, so a tag that disagrees with the
   crate version (which names the `.dmg`) fails before building.
4. The `release` workflow runs on `macos-14` in this order: verify the secrets → metadata + tag gate →
   build + codesign + `.dmg` + notarize + staple → **verify the staple** (`stapler validate` + `spctl`)
   → only then create a **draft** pre-release with **only** the verified `.dmg` attached (the build also
   produces a `.app`, which is intentionally not uploaded — single-artifact release).
5. Review the draft Release on GitHub, then **publish** it. (The job creates a draft on purpose so a
   human signs off on the first signed artifact — flip `--draft` off in the workflow's publish step once
   you trust the pipeline. Re-running the same tag: delete the prior draft Release first.)

## What the pipeline does (and which secret drives each step)

`tauri-action` runs Tauri's bundler, which performs the whole signing chain from the `APPLE_*` env:

| Step | Driven by |
|---|---|
| Import the cert into a fresh, ephemeral keychain | `APPLE_CERTIFICATE` + `APPLE_CERTIFICATE_PASSWORD` |
| Codesign the `.app` with the Developer ID identity (hardened runtime) | `APPLE_SIGNING_IDENTITY` |
| Build `Termixion_<version>_aarch64.dmg` | `--bundles dmg` (overrides the local-only `["app"]` target) |
| Notarize via `notarytool` (submit + wait) | `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID` |
| Staple the notarization ticket to the artifact | automatic, post-notarization |
| Verify the staple, then publish a draft Release with only the `.dmg` (`gh release create`) | `GITHUB_TOKEN` (auto-provided) |

The build step deliberately runs tauri-action **without** release inputs (so it only builds/signs and
uploads nothing). The **Verify notarization** step is an independent gate — `xcrun stapler validate` +
`spctl --assess` on the produced `.dmg` — and runs **before** publishing, so a silently-unsigned or
un-notarized artifact fails the job instead of shipping a Gatekeeper-blocked download. Only the verified
`.dmg` is then uploaded.

## Verifying a downloaded artifact (manual)

```sh
xcrun stapler validate Termixion_0.0.1_aarch64.dmg   # "The validate action worked!"
spctl --assess --type open --context context:primary-signature -vvv Termixion_0.0.1_aarch64.dmg
```

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
