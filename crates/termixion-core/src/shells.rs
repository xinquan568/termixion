// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-205: pure curation of the installed-shells dropdown. The tauri layer supplies the impure
//! inputs — `/etc/shells` content, an installed-probe, and a canonicalizer — and this module
//! turns them into the deterministic, deduplicated candidate list the settings UI offers:
//! zsh · bash (preferring the Homebrew build over Apple's 3.2-era `/bin/bash`, label carries the
//! path) · fish · nushell, each only when actually installed. Legacy shells (csh/tcsh/ksh/dash/sh)
//! are deliberately excluded from curation — the Custom path… field reaches them.

/// One offerable shell: `id` is the stable kind, `label` the dropdown text, `path` the exact
/// program the config persists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellCandidate {
    pub id: String,
    pub label: String,
    pub path: String,
}

/// The curated kinds, in dropdown order, with their preference-ordered well-known paths.
/// `/etc/shells` entries whose basename matches a kind are appended AFTER the well-known paths,
/// so the curated preference (e.g. Homebrew bash first) always wins when both are present.
const KINDS: &[(&str, &[&str])] = &[
    ("zsh", &["/bin/zsh"]),
    (
        "bash",
        &["/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/bin/bash"],
    ),
    ("fish", &["/opt/homebrew/bin/fish", "/usr/local/bin/fish"]),
    ("nushell", &["/opt/homebrew/bin/nu", "/usr/local/bin/nu"]),
];

/// The basename a kind matches in `/etc/shells` (nushell's binary is `nu`).
fn kind_basename(id: &str) -> &str {
    if id == "nushell" { "nu" } else { id }
}

/// Curate the installed shells: for each kind, the first candidate path that is installed AND
/// canonicalizable wins; canonical paths dedupe across sources (a `/etc/shells` symlink to an
/// already-offered binary adds nothing). A missing/unreadable `/etc/shells` (`None`) degrades to
/// the well-known probe list alone. Pure and deterministic over the injected closures.
pub fn curated_shells(
    etc_shells: Option<&str>,
    installed: impl Fn(&str) -> bool,
    canonical: impl Fn(&str) -> Option<String>,
) -> Vec<ShellCandidate> {
    let etc_lines: Vec<&str> = etc_shells
        .unwrap_or_default()
        .lines()
        .map(str::trim)
        .filter(|line| line.starts_with('/'))
        .collect();

    let mut seen_canonical: Vec<String> = Vec::new();
    let mut out = Vec::new();

    for (id, known_paths) in KINDS {
        let from_etc = etc_lines.iter().copied().filter(|line| {
            std::path::Path::new(line)
                .file_name()
                .and_then(|name| name.to_str())
                == Some(kind_basename(id))
        });
        let candidates = known_paths.iter().copied().chain(from_etc);

        for path in candidates {
            if !installed(path) {
                continue;
            }
            let Some(canon) = canonical(path) else {
                continue; // dangling symlink / unreadable — not offerable
            };
            if seen_canonical.contains(&canon) {
                continue; // an alias of something already offered
            }
            seen_canonical.push(canon);
            let label = if *id == "bash" {
                format!("bash ({path})") // disambiguate Homebrew vs Apple's 3.2-era build
            } else {
                (*id).to_string()
            };
            out.push(ShellCandidate {
                id: (*id).to_string(),
                label,
                path: path.to_string(),
            });
            break; // first installed candidate per kind wins
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn installed<'a>(paths: &'a [&'a str]) -> impl Fn(&str) -> bool + 'a {
        move |p| paths.contains(&p)
    }

    /// Identity canonicalizer for tests that don't exercise aliasing.
    fn identity(p: &str) -> Option<String> {
        Some(p.to_string())
    }

    #[test]
    fn offers_only_installed_kinds_in_deterministic_order() {
        let shells = curated_shells(
            None,
            installed(&["/bin/zsh", "/opt/homebrew/bin/fish"]),
            identity,
        );
        assert_eq!(
            shells
                .iter()
                .map(|s| (s.id.as_str(), s.path.as_str()))
                .collect::<Vec<_>>(),
            vec![("zsh", "/bin/zsh"), ("fish", "/opt/homebrew/bin/fish")]
        );
    }

    #[test]
    fn bash_prefers_homebrew_and_labels_the_path() {
        let shells = curated_shells(
            None,
            installed(&["/bin/bash", "/opt/homebrew/bin/bash"]),
            identity,
        );
        assert_eq!(shells.len(), 1);
        assert_eq!(shells[0].path, "/opt/homebrew/bin/bash");
        assert_eq!(shells[0].label, "bash (/opt/homebrew/bin/bash)");
    }

    #[test]
    fn apple_bash_offered_when_homebrew_absent() {
        let shells = curated_shells(None, installed(&["/bin/bash"]), identity);
        assert_eq!(shells[0].path, "/bin/bash");
        assert_eq!(shells[0].label, "bash (/bin/bash)");
    }

    #[test]
    fn etc_shells_extends_the_probe_list_for_known_kinds_only() {
        let etc = "# /etc/shells\n/bin/zsh\n/opt/weird/bin/fish\n/bin/tcsh\n";
        let shells = curated_shells(Some(etc), installed(&["/opt/weird/bin/fish"]), identity);
        // fish found via /etc/shells; tcsh (legacy) never offered; zsh not installed → absent.
        assert_eq!(
            shells.iter().map(|s| s.path.as_str()).collect::<Vec<_>>(),
            vec!["/opt/weird/bin/fish"]
        );
    }

    #[test]
    fn nushell_matches_the_nu_basename() {
        let etc = "/opt/tools/bin/nu\n";
        let shells = curated_shells(Some(etc), installed(&["/opt/tools/bin/nu"]), identity);
        assert_eq!(shells[0].id, "nushell");
        assert_eq!(shells[0].label, "nushell");
    }

    #[test]
    fn canonical_aliases_dedupe_and_dangling_candidates_drop() {
        // /usr/local/bin/bash is a symlink onto the Homebrew bash — offered once, first wins.
        let canonical = |p: &str| match p {
            "/opt/homebrew/bin/bash" | "/usr/local/bin/bash" => Some("/brew/bash".to_string()),
            "/bin/zsh" => None, // dangling — never offerable
            other => Some(other.to_string()),
        };
        let shells = curated_shells(
            None,
            installed(&["/bin/zsh", "/opt/homebrew/bin/bash", "/usr/local/bin/bash"]),
            canonical,
        );
        assert_eq!(
            shells.iter().map(|s| s.path.as_str()).collect::<Vec<_>>(),
            vec!["/opt/homebrew/bin/bash"]
        );
    }
}
