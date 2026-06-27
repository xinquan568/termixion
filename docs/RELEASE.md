# Release runbook

A-1 skeleton placeholder. Filled in by the P0 / E tasks (plan §3, §8):

- **Apple Team ID** (P0-1).
- **Signing + notarization** secret contract and the exact CI keychain import + `notarytool` validation
  (P0-2).
- **Distribution:** GitHub Releases only for Alpha (Q-e); macOS CI on GitHub-hosted `macos-14` (Q1).
- **Release-on-tag** pipeline: bootstrap `cargo tauri` -> build -> codesign -> notarize -> staple ->
  `.dmg` -> publish GitHub Release; artifact verification via `stapler validate` + `spctl` (E-2).
