// SPDX-License-Identifier: ISC
// Copyright (c) 2026 Eric Y. Liu
//! trmx-243 (grill H5): the special-launch surface, extracted verbatim from `main.rs`.
//!
//! Everything that decides *how this process was started* and what it should do instead of being a
//! normal terminal window: the `--smoke` / `--perf` mode parsers and their watchdog budgets, the
//! `--version` / `--help` CLI query, and the four `smoke_*` / `perf_*` commands the driven webview
//! calls back into. [`SpecialLaunch`] is the single managed struct `main()` builds once at launch
//! and `open_pty` reads to pick the deterministic rc-free shell.
//!
//! Pure by construction — the parsers take their argv/env as arguments, so every branch is unit
//! tested below without a Tauri runtime.

use std::path::Path;

use tauri::State;

/// The special-launch state (C-3 smoke / trmx-78 perf): at most one is set (launch_modes gives
/// smoke precedence). One managed struct so `open_pty` reads a single State.
pub(crate) struct SpecialLaunch {
    pub(crate) smoke: Option<String>,
    pub(crate) perf: Option<String>,
    /// trmx-103: which perf scenario the webview should drive (`single`|`multipane`); irrelevant
    /// unless `perf` is set. Resolved once at launch from the args/env by [`perf_scenario`].
    pub(crate) perf_scenario: &'static str,
}

/// Whether/how the packaged smoke runs. `MissingDir` (smoke requested but no `DIR`) must FAIL the gate,
/// not silently launch the app — otherwise the packaged `--smoke` would hang CI instead of exiting 1.
pub(crate) enum SmokeMode {
    Off,
    MissingDir,
    On(String),
}

/// Resolve smoke mode: `--smoke` arg OR truthy `TERMIXION_SMOKE` enables it; the sentinel dir is the
/// `DIR` env var (the pre-created `mktemp -d` holding `SMOKE_OK`). Pure, for testing.
pub(crate) fn smoke_mode<I: IntoIterator<Item = String>>(
    args: I,
    smoke_env: Option<String>,
    dir_env: Option<String>,
) -> SmokeMode {
    let enabled = args.into_iter().any(|a| a == "--smoke")
        || smoke_env.is_some_and(|v| v == "1" || v == "true");
    if !enabled {
        return SmokeMode::Off;
    }
    match dir_env.filter(|d| !d.is_empty()) {
        Some(dir) => SmokeMode::On(dir),
        None => SmokeMode::MissingDir,
    }
}

/// The webview asks whether to run the end-to-end smoke, and against which dir (`None` = normal launch).
#[tauri::command]
pub(crate) fn smoke_config(launch: State<'_, SpecialLaunch>) -> Option<String> {
    launch.smoke.clone()
}

/// Whether/how the NFR-1 perf harness runs (trmx-78) — the exact [`SmokeMode`] shape: requesting
/// perf without an output dir must FAIL the launch, not silently start the app.
pub(crate) enum PerfMode {
    Off,
    MissingDir,
    On(String),
}

/// Resolve perf mode: `--perf` arg OR truthy `TERMIXION_PERF` enables it; the report target is
/// the `TERMIXION_PERF_OUT` env dir. Pure, for testing (mirror of [`smoke_mode`]).
pub(crate) fn perf_mode<I: IntoIterator<Item = String>>(
    args: I,
    perf_env: Option<String>,
    out_env: Option<String>,
) -> PerfMode {
    let enabled = args.into_iter().any(|a| a == "--perf")
        || perf_env.is_some_and(|v| v == "1" || v == "true");
    if !enabled {
        return PerfMode::Off;
    }
    match out_env.filter(|d| !d.is_empty()) {
        Some(dir) => PerfMode::On(dir),
        None => PerfMode::MissingDir,
    }
}

/// Combine the two special-launch resolutions (trmx-78, pure): smoke wins if both are requested
/// (never expected — pinned by test), and either mode's MissingDir is a hard, fail-fast error.
pub(crate) fn launch_modes(
    smoke: SmokeMode,
    perf: PerfMode,
) -> Result<(Option<String>, Option<String>), String> {
    let smoke = match smoke {
        SmokeMode::Off => None,
        SmokeMode::On(dir) => Some(dir),
        SmokeMode::MissingDir => {
            return Err("termixion-smoke: FAIL — smoke requested but DIR is missing/empty".into());
        }
    };
    let perf = match perf {
        PerfMode::Off => None,
        PerfMode::On(dir) => Some(dir),
        PerfMode::MissingDir => {
            return Err(
                "termixion-perf: FAIL — perf requested but TERMIXION_PERF_OUT is missing/empty"
                    .into(),
            );
        }
    };
    if smoke.is_some() {
        return Ok((smoke, None));
    }
    Ok((None, perf))
}

/// Resolve which perf scenario to drive (trmx-103): `--scenario multipane` (or `--scenario=…`) OR
/// `TERMIXION_PERF_SCENARIO=multipane` selects the v0.0.9 multi-pane load; anything else — including
/// absent — is the default single-pane run. Pure, for testing (the same discipline as `perf_mode`).
pub(crate) fn perf_scenario<I: IntoIterator<Item = String>>(
    args: I,
    scenario_env: Option<String>,
) -> &'static str {
    let mut selected: Option<String> = None;
    let mut expect_value = false;
    for a in args {
        if expect_value {
            selected = Some(a);
            expect_value = false;
        } else if a == "--scenario" {
            expect_value = true;
        } else if let Some(v) = a.strip_prefix("--scenario=") {
            selected = Some(v.to_string());
        }
    }
    match selected.or(scenario_env).as_deref() {
        Some("multipane") => "multipane",
        _ => "single",
    }
}

/// trmx-146: a terminal CLI query resolved from argv — answered BEFORE the Tauri builder runs.
#[derive(Debug, PartialEq)]
pub(crate) enum CliQuery {
    /// No query — proceed to a normal (or smoke/perf) launch.
    None,
    /// `--version` / `-V`: print [`version_line`] and exit 0.
    Version,
    /// `--help` / `-h`: print [`usage`] and exit 0.
    Help,
    /// An unrecognized `--flag`: print [`usage`] to stderr and exit 2 — a typo'd query
    /// (`--verison`) must never silently launch a GUI (the same fail-fast discipline as
    /// [`launch_modes`]'s MissingDir).
    UnknownFlag(String),
}

/// Resolve the launcher CLI query. Precedence (pinned by tests): Help > Version > UnknownFlag >
/// None — help/version are terminal queries and win over both the known launch flags and any
/// unknown token; the first unknown `--flag` is the one reported. Tolerated unconditionally:
/// every non-`--` token (legacy LaunchServices `-psn_<n>`, bare paths, `--scenario`'s value) and
/// single-dash tokens other than the exact `-V`/`-h`, so a Finder/`open` launch can never be
/// rejected. The `ctl` subcommand is forked off in `main()` BEFORE this runs (trmx-101 keeps
/// precedence); pure, for testing (the `smoke_mode`/`perf_mode` discipline).
pub(crate) fn cli_query<I: IntoIterator<Item = String>>(args: I) -> CliQuery {
    const KNOWN_FLAGS: [&str; 3] = ["--smoke", "--perf", "--scenario"];
    let mut help = false;
    let mut version = false;
    let mut unknown: Option<String> = None;
    for a in args {
        match a.as_str() {
            "--help" | "-h" => help = true,
            "--version" | "-V" => version = true,
            s if s.starts_with("--") => {
                let name = s.split('=').next().unwrap_or(s);
                if !KNOWN_FLAGS.contains(&name) && unknown.is_none() {
                    unknown = Some(s.to_string());
                }
            }
            _ => {} // non-`--` tokens are never ours to reject
        }
    }
    if help {
        CliQuery::Help
    } else if version {
        CliQuery::Version
    } else if let Some(flag) = unknown {
        CliQuery::UnknownFlag(flag)
    } else {
        CliQuery::None
    }
}

/// The `--version` line: the binary's compile-time truth (workspace-inherited version).
pub(crate) fn version_line() -> String {
    format!("termixion {}", env!("CARGO_PKG_VERSION"))
}

/// The `--help` text. `ctl` is documented generically — `run_ctl` has no help path today, so
/// pointing at `ctl --help` would mislead (plan §4). The smoke/perf/scenario flags are CI-internal
/// contracts: documented so they are not mystery flags, flagged so nobody treats them as public.
pub(crate) fn usage() -> String {
    [
        version_line().as_str(),
        "",
        "USAGE:",
        "  termixion                       launch the app",
        "  termixion ctl <command>         send a command to a running instance's control socket",
        "  termixion --version | -V        print the version and exit",
        "  termixion --help | -h           print this help and exit",
        "",
        "internal (CI harness; require env vars, exit non-zero without them):",
        "  --smoke · --perf · --scenario <single|multipane>",
    ]
    .join("\n")
}

/// What `perf_config` returns to the webview (trmx-78): where to have the report written, which
/// build produced it (budgets are only recorded from `release`), and which scenario to drive
/// (trmx-103 — `single`|`multipane`). camelCase for the frontend.
#[derive(Clone, serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PerfConfig {
    out_dir: String,
    build: &'static str,
    scenario: &'static str,
}

/// The smoke watchdog (trmx-102): fail rather than hang if the webview never reports the sentinel. Bumped
/// from 30 s so a slow headless webkit2gtk boot on Linux CI is not killed mid-flight (the happy path is <5 s).
pub(crate) const SMOKE_WATCHDOG_SECS: u64 = 90;

/// The perf watchdog (trmx-78): fail the run rather than hang if the webview driver never reports.
/// 300 s ≈ 3× the harness's end-to-end schedule — the derivation is pinned in the tests below and
/// quoted by docs/design/performance-protocol.md.
pub(crate) const PERF_WATCHDOG_SECS: u64 = 300;

/// The webview asks whether to run the NFR-1 perf harness (`None` = normal launch), and learns
/// the report dir + build kind (trmx-78).
#[tauri::command]
pub(crate) fn perf_config(launch: State<'_, SpecialLaunch>) -> Option<PerfConfig> {
    launch.perf.clone().map(|out_dir| PerfConfig {
        out_dir,
        build: if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        },
        scenario: launch.perf_scenario,
    })
}

/// The webview reports the perf result (trmx-78): persist the JSON report to the out dir, then
/// exit `0`/`1` on budget pass/fail so `scripts/perf.sh` is a gate. The report lands on disk
/// either way — a failed run's numbers are exactly the ones worth reading.
#[tauri::command]
pub(crate) fn perf_done(report: String, success: bool, launch: State<'_, SpecialLaunch>) {
    if let Some(dir) = launch.perf.as_ref() {
        let path = Path::new(dir).join("report.json");
        if let Err(err) = std::fs::create_dir_all(dir).and_then(|()| std::fs::write(&path, &report))
        {
            log::error!(
                "termixion-perf: FAIL — could not write {}: {err}",
                path.display()
            );
            std::process::exit(1);
        }
        log::info!("termixion-perf: report written to {}", path.display());
    }
    if success {
        log::info!("termixion-perf: OK — budgets met");
        std::process::exit(0);
    }
    log::error!("termixion-perf: FAIL — budgets missed or the run was invalid");
    std::process::exit(1);
}

/// The webview reports the smoke result; exit the process `0`/`1` so the packaged `--smoke` is a gate.
#[tauri::command]
pub(crate) fn smoke_done(success: bool, reason: String) {
    if success {
        log::info!("termixion-smoke: OK — {reason}");
        std::process::exit(0);
    }
    log::error!("termixion-smoke: FAIL — {reason}");
    std::process::exit(1);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// trmx-146: argv → CliQuery, as a plain Vec<String> (same convention as the smoke/perf tests).
    fn q(args: &[&str]) -> CliQuery {
        cli_query(args.iter().map(|s| (*s).to_string()))
    }
    #[test]
    fn cli_query_recognizes_version_and_help_in_both_spellings() {
        assert_eq!(q(&["--version"]), CliQuery::Version);
        assert_eq!(q(&["-V"]), CliQuery::Version);
        assert_eq!(q(&["--help"]), CliQuery::Help);
        assert_eq!(q(&["-h"]), CliQuery::Help);
    }

    #[test]
    fn cli_query_precedence_is_help_over_version_over_unknown() {
        // trmx-146 (plan §2): Help > Version > UnknownFlag > None — a caller who asked an
        // answerable question gets the answer; version/help are terminal queries and beat both
        // the known launch flags and any unknown token.
        assert_eq!(q(&["--version", "--help"]), CliQuery::Help);
        assert_eq!(q(&["--help", "--version"]), CliQuery::Help);
        assert_eq!(q(&["--smoke", "--version"]), CliQuery::Version);
        assert_eq!(q(&["--help", "--bogus"]), CliQuery::Help);
        assert_eq!(q(&["--bogus", "--help"]), CliQuery::Help);
        assert_eq!(q(&["--version", "--bogus"]), CliQuery::Version);
    }

    #[test]
    fn cli_query_rejects_the_first_unknown_double_dash_flag() {
        assert_eq!(q(&["--bogus"]), CliQuery::UnknownFlag("--bogus".into()));
        // First offender reported when several are present.
        assert_eq!(
            q(&["--bogus", "--other"]),
            CliQuery::UnknownFlag("--bogus".into())
        );
        // A typo'd query must NOT silently launch a GUI (the trmx-146 bug in a hat).
        assert_eq!(q(&["--verison"]), CliQuery::UnknownFlag("--verison".into()));
    }

    #[test]
    fn cli_query_tolerates_known_flags_platform_args_and_plain_tokens() {
        // The CI-internal launch flags stay recognized (value and `=` forms of --scenario).
        assert_eq!(q(&["--smoke"]), CliQuery::None);
        assert_eq!(q(&["--perf"]), CliQuery::None);
        assert_eq!(q(&["--scenario", "multipane"]), CliQuery::None);
        assert_eq!(q(&["--scenario=multipane"]), CliQuery::None);
        // Platform-injected argv must never be rejected: legacy LaunchServices -psn_<n>,
        // bare paths, and single-dash tokens other than the exact -V/-h.
        assert_eq!(q(&["-psn_0_12345"]), CliQuery::None);
        assert_eq!(q(&["some/path"]), CliQuery::None);
        assert_eq!(q(&["-x"]), CliQuery::None);
        assert_eq!(q(&[]), CliQuery::None);
    }

    #[test]
    fn version_line_carries_the_compiled_crate_version() {
        let line = version_line();
        assert!(line.starts_with("termixion "), "got: {line}");
        assert!(line.contains(env!("CARGO_PKG_VERSION")), "got: {line}");
    }

    #[test]
    fn usage_documents_the_public_surface_and_flags_the_internal_one() {
        let text = usage();
        for needle in [
            "termixion",
            "ctl <command>",
            "--version",
            "--help",
            "internal",
        ] {
            assert!(text.contains(needle), "usage() must mention {needle:?}");
        }
        // trmx-146 (plan §4): run_ctl has no help path — usage must not advertise one.
        assert!(
            !text.contains("ctl --help"),
            "usage() must not point at nonexistent ctl --help"
        );
        for internal in ["--smoke", "--perf", "--scenario"] {
            assert!(
                text.contains(internal),
                "internal flag {internal:?} documented-but-flagged"
            );
        }
    }
    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn mode(args_v: &[&str], smoke_env: Option<&str>, dir_env: Option<&str>) -> SmokeMode {
        smoke_mode(
            args(args_v),
            smoke_env.map(str::to_string),
            dir_env.map(str::to_string),
        )
    }
    // --- trmx-78: the --perf mode's pure pieces ------------------------------------------------

    fn perf(args_v: &[&str], perf_env: Option<&str>, out_env: Option<&str>) -> PerfMode {
        perf_mode(
            args(args_v),
            perf_env.map(str::to_string),
            out_env.map(str::to_string),
        )
    }

    #[test]
    fn perf_mode_resolves_off_on_and_missing_dir() {
        let out = "/tmp/termixion-perf";

        // Enabled (arg or env) WITH an output dir → On(dir).
        assert!(matches!(perf(&["app", "--perf"], None, Some(out)), PerfMode::On(d) if d == out));
        assert!(matches!(perf(&["app"], Some("1"), Some(out)), PerfMode::On(d) if d == out));
        assert!(matches!(perf(&["app"], Some("true"), Some(out)), PerfMode::On(d) if d == out));

        // Not enabled → Off, even with the dir set.
        assert!(matches!(perf(&["app"], None, Some(out)), PerfMode::Off));

        // Enabled but TERMIXION_PERF_OUT missing/empty → MissingDir (fail fast, never launch normally).
        assert!(matches!(
            perf(&["app", "--perf"], None, None),
            PerfMode::MissingDir
        ));
        assert!(matches!(
            perf(&["app", "--perf"], None, Some("")),
            PerfMode::MissingDir
        ));
    }

    #[test]
    fn launch_modes_gives_smoke_precedence_and_fails_fast_on_missing_dirs() {
        let dir = "/tmp/x".to_string();
        // Smoke wins when both are requested (never expected, but pinned): perf is dropped.
        let both = launch_modes(SmokeMode::On(dir.clone()), PerfMode::On(dir.clone()));
        assert_eq!(both, Ok((Some(dir.clone()), None)));
        // Perf alone rides through; either MissingDir is a hard error.
        assert_eq!(
            launch_modes(SmokeMode::Off, PerfMode::On(dir.clone())),
            Ok((None, Some(dir.clone())))
        );
        assert_eq!(
            launch_modes(SmokeMode::Off, PerfMode::Off),
            Ok((None, None))
        );
        assert!(launch_modes(SmokeMode::MissingDir, PerfMode::Off).is_err());
        assert!(launch_modes(SmokeMode::Off, PerfMode::MissingDir).is_err());
    }

    #[test]
    fn perf_config_serializes_camel_case_for_the_frontend() {
        // The frontend destructures `outDir`/`build`/`scenario` — pin the wire shape like SessionInfo.
        let value = serde_json::to_value(PerfConfig {
            out_dir: "/tmp/perf".to_string(),
            build: "release",
            scenario: "single",
        })
        .expect("PerfConfig serializes");
        assert_eq!(
            value,
            serde_json::json!({ "outDir": "/tmp/perf", "build": "release", "scenario": "single" })
        );
    }

    #[test]
    fn perf_scenario_resolves_single_and_multipane_from_arg_or_env() {
        // Default (nothing set) → single; the whole point is the existing path is unchanged.
        assert_eq!(perf_scenario(args(&["app", "--perf"]), None), "single");
        // Explicit multipane via arg (spaced or `=`) or env.
        assert_eq!(
            perf_scenario(args(&["app", "--perf", "--scenario", "multipane"]), None),
            "multipane"
        );
        assert_eq!(
            perf_scenario(args(&["app", "--scenario=multipane"]), None),
            "multipane"
        );
        assert_eq!(
            perf_scenario(args(&["app"]), Some("multipane".to_string())),
            "multipane"
        );
        // The arg wins over the env; an unknown value falls back to single (never a launch failure).
        assert_eq!(
            perf_scenario(
                args(&["app", "--scenario", "single"]),
                Some("multipane".to_string())
            ),
            "single"
        );
        assert_eq!(
            perf_scenario(args(&["app", "--scenario", "bogus"]), None),
            "single"
        );
        assert_eq!(
            perf_scenario(args(&["app"]), Some("single".to_string())),
            "single"
        );
    }
    #[test]
    fn perf_watchdog_outlasts_the_scenario_schedule() {
        // Derivation (app/src/perf/runPerf.ts consts): typing 1000 keys × 50 ms ≈ 50 s, readiness
        // + warmup ≈ 5 s, seq-scroll ≈ 30 s, yes-scroll 5 s, paging 40 × 100 ms = 4 s, settles ≈
        // 10 s → ≈ 105 s end-to-end. 300 s ≈ 3× headroom without masking a genuine hang.
        // ≈105 s schedule × ~3 headroom = the 300 s pinned here; change the consts together.
        assert_eq!(PERF_WATCHDOG_SECS, 300);
    }
    #[test]
    fn smoke_mode_resolves_off_on_and_missing_dir() {
        let on = "/tmp/termixion-smoke";

        // Enabled (arg or env) WITH DIR → On(dir).
        assert!(matches!(mode(&["app", "--smoke"], None, Some(on)), SmokeMode::On(d) if d == on));
        assert!(matches!(mode(&["app"], Some("1"), Some(on)), SmokeMode::On(d) if d == on));

        // Not enabled → Off, even with DIR set.
        assert!(matches!(mode(&["app"], None, Some(on)), SmokeMode::Off));

        // Enabled but DIR missing/empty → MissingDir (the gate fails fast, never launches normally).
        assert!(matches!(
            mode(&["app", "--smoke"], None, None),
            SmokeMode::MissingDir
        ));
        assert!(matches!(
            mode(&["app", "--smoke"], None, Some("")),
            SmokeMode::MissingDir
        ));
    }
}
