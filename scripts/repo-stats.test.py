# SPDX-License-Identifier: ISC
"""Tests for scripts/repo-stats.py (trmx-213). Run: python3 scripts/repo-stats.test.py"""

import contextlib
import importlib.util
import io
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone

MOD_PATH = pathlib.Path(__file__).resolve().with_name("repo-stats.py")
spec = importlib.util.spec_from_file_location("repo_stats", MOD_PATH)
rs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rs)


class TestCategorize(unittest.TestCase):
    def test_rust_prod(self):
        self.assertEqual(rs.categorize("crates/termixion-core/src/lib.rs"), "prod")

    def test_rust_integration_test_dir(self):
        self.assertEqual(rs.categorize("crates/termixion-platform/tests/pty_golden.rs"), "test")

    def test_ts_unit_test_suffix(self):
        self.assertEqual(rs.categorize("app/src/term/scrollback.test.ts"), "test")

    def test_playwright_spec(self):
        self.assertEqual(rs.categorize("app/e2e/smoke.spec.ts"), "test")

    def test_ts_prod(self):
        self.assertEqual(rs.categorize("app/src/main.ts"), "prod")

    def test_vendored_resources(self):
        self.assertEqual(
            rs.categorize("resources/shell-enhancements/zsh-autosuggestions/zsh-autosuggestions.zsh"),
            "vendored",
        )

    def test_lockfiles_generated(self):
        self.assertEqual(rs.categorize("Cargo.lock"), "generated")
        self.assertEqual(rs.categorize("pnpm-lock.yaml"), "generated")

    def test_docs(self):
        self.assertEqual(rs.categorize("README.md"), "docs")
        self.assertEqual(rs.categorize("LICENSE"), "docs")
        self.assertEqual(rs.categorize("docs/notes.txt"), "docs")

    def test_config(self):
        self.assertEqual(rs.categorize("Cargo.toml"), "config")
        self.assertEqual(rs.categorize(".github/workflows/ci.yml"), "config")
        self.assertEqual(rs.categorize(".gitignore"), "config")
        self.assertEqual(rs.categorize("package.json"), "config")

    def test_assets(self):
        self.assertEqual(rs.categorize("app/public/fonts/mono.woff2"), "assets")
        self.assertEqual(rs.categorize("docs/icons/app.png"), "assets")

    def test_git_hook_scripts_are_prod(self):
        self.assertEqual(rs.categorize(".claude/hooks/pre-push"), "prod")
        self.assertEqual(rs.categorize(".claude/hooks/commit-msg"), "prod")

    def test_this_test_file_is_test(self):
        self.assertEqual(rs.categorize("scripts/repo-stats.test.py"), "test")
        self.assertEqual(rs.categorize("scripts/repo-stats.py"), "prod")


class TestLanguageOf(unittest.TestCase):
    def test_languages(self):
        self.assertEqual(rs.language_of("crates/x/src/a.rs"), "Rust")
        self.assertEqual(rs.language_of("app/src/a.ts"), "TypeScript")
        self.assertEqual(rs.language_of("app/src/a.tsx"), "TypeScript")
        self.assertEqual(rs.language_of("scripts/x.sh"), "Shell")
        self.assertEqual(rs.language_of(".claude/hooks/pre-push"), "Shell")
        self.assertEqual(rs.language_of("app/src/style.css"), "CSS")
        self.assertEqual(rs.language_of("app/index.html"), "HTML")
        self.assertEqual(rs.language_of("scripts/repo-stats.py"), "Python")


class TestRustTestBlockExtraction(unittest.TestCase):
    def test_no_test_block(self):
        src = "fn main() {\n    println!(\"hi\");\n}\n"
        self.assertEqual(rs.extract_rust_test_lines(src), 0)

    def test_simple_block(self):
        src = (
            "fn add(a: i32, b: i32) -> i32 { a + b }\n"
            "\n"
            "#[cfg(test)]\n"          # line 3
            "mod tests {\n"            # 4
            "    use super::*;\n"      # 5
            "    #[test]\n"            # 6
            "    fn adds() {\n"        # 7
            "        assert_eq!(add(1, 2), 3);\n"  # 8
            "    }\n"                  # 9
            "}\n"                      # 10
        )
        self.assertEqual(rs.extract_rust_test_lines(src), 8)

    def test_nested_braces(self):
        src = (
            "#[cfg(test)]\n"
            "mod tests {\n"
            "    #[test]\n"
            "    fn f() {\n"
            "        if true { let _x = vec![1, 2]; }\n"
            "    }\n"
            "}\n"
            "fn prod() {}\n"
        )
        self.assertEqual(rs.extract_rust_test_lines(src), 7)

    def test_two_blocks_sum(self):
        block = "#[cfg(test)]\nmod t {\n    fn x() {}\n}\n"
        src = "fn a() {}\n" + block + "fn b() {}\n" + block
        self.assertEqual(rs.extract_rust_test_lines(src), 8)


class TestTsTestCaseCount(unittest.TestCase):
    def test_it_and_test(self):
        src = (
            "describe('suite', () => {\n"
            "  it('one', () => {});\n"
            "  test('two', () => {});\n"
            "  it.skip('three', () => {});\n"
            "  it.each([[1], [2]])('four %i', () => {});\n"
            "});\n"
        )
        self.assertEqual(rs.count_ts_test_cases(src), 4)

    def test_non_cases_not_counted(self):
        src = (
            "test.describe('suite', () => {});\n"
            "test.beforeEach(async () => {});\n"
            "unittest('x', () => {});\n"
            "myit('y', () => {});\n"
            "const fit = (x) => x;\n"
        )
        self.assertEqual(rs.count_ts_test_cases(src), 0)


class TestRustTestCaseCount(unittest.TestCase):
    def test_attributes(self):
        src = (
            "#[test]\nfn a() {}\n"
            "#[tokio::test]\nasync fn b() {}\n"
            "#[tokio::test(flavor = \"multi_thread\")]\nasync fn c() {}\n"
            "#[test_case(1)]\nfn d(_: i32) {}\n"
        )
        self.assertEqual(rs.count_rust_test_cases(src), 4)

    def test_lookalikes_not_counted(self):
        src = "#[test_helper]\nfn a() {}\n#[testing::attr]\nfn b() {}\n"
        self.assertEqual(rs.count_rust_test_cases(src), 0)


class TestHumanSize(unittest.TestCase):
    def test_sizes(self):
        self.assertEqual(rs.human_size(0), "0 B")
        self.assertEqual(rs.human_size(1023), "1023 B")
        self.assertEqual(rs.human_size(1536), "1.5 KB")
        self.assertEqual(rs.human_size(3 * 1024 * 1024), "3.0 MB")


class TestEndToEnd(unittest.TestCase):
    def _make_fixture(self, root: pathlib.Path):
        (root / "src").mkdir()
        (root / "src" / "lib.rs").write_text(
            "fn add(a: i32, b: i32) -> i32 { a + b }\n"
            "\n"
            "#[cfg(test)]\n"
            "mod tests {\n"
            "    #[test]\n"
            "    fn adds() { assert_eq!(super::add(1, 2), 3); }\n"
            "}\n"
        )
        (root / "app").mkdir()
        (root / "app" / "main.ts").write_text("export const x = 1;\n")
        (root / "app" / "main.test.ts").write_text(
            "it('a', () => {});\ntest('b', () => {});\n"
        )
        (root / "README.md").write_text("# fixture\n")
        subprocess.run(["git", "init", "-q"], cwd=root, check=True)
        subprocess.run(["git", "add", "-A"], cwd=root, check=True)

    def test_full_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            self._make_fixture(root)
            out = root / "reports"
            stats = rs.analyze(root)
            self.assertEqual(stats["total_files"], 4)
            # lib.rs prod: 7 lines total, 5 in the #[cfg(test)] block => prod 2, test 5
            self.assertEqual(stats["rust_inline_test_lines"], 5)
            self.assertEqual(stats["test_cases"]["Rust"], 1)
            self.assertEqual(stats["test_cases"]["Vitest (unit)"], 2)
            md = rs.render_markdown(stats)
            html = rs.render_html(stats)
            self.assertIn("# Repository statistics", md)
            self.assertIn("Top 5", md)
            # Category rows are whole-file classification; the "(by file)" suffix
            # distinguishes them from the line-accurate prod-vs-test section.
            self.assertIn("Production code (by file)", md)
            self.assertIn("Test code (by file)", md)
            self.assertIn("<title>", html)
            self.assertIn("Production code (by file)", html)
            self.assertIn("Test code (by file)", html)
            rc = rs.main([str(root), "--out", str(out)])
            self.assertEqual(rc, 0)
            self.assertTrue((out / "repo-stats.md").is_file())
            self.assertTrue((out / "repo-stats.html").is_file())



# --- trmx-265: --ci mode (CI flake rate, gate duration, release lead time, escaped defects) ------
# Fixtures under scripts/fixtures/repo-stats-ci/ hold exactly what `gh api --paginate --slurp`
# returns (an array of pages); no test below reaches the network.


FIXTURES = MOD_PATH.parent / "fixtures" / "repo-stats-ci"
REPO_ROOT = MOD_PATH.parent.parent
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "repo-stats-ci.yml"
MAC = "full gate (macos)"
LIN = "core tests (linux)"
SINCE = datetime(2026, 7, 1, tzinfo=timezone.utc)
UNTIL = datetime(2026, 8, 1, tzinfo=timezone.utc)


def _load(rel):
    return json.loads((FIXTURES / rel).read_text(encoding="utf-8"))


class TestParseTs(unittest.TestCase):
    def test_zulu_and_offset(self):
        a = rs.parse_ts("2026-07-05T10:00:00Z")
        b = rs.parse_ts("2026-07-05T10:00:00+00:00")
        self.assertEqual(a, b)
        self.assertEqual(a.tzinfo, timezone.utc)
        self.assertEqual(a.hour, 10)


class TestPercentile(unittest.TestCase):
    def test_nearest_rank(self):
        self.assertEqual(rs.percentile([30], 50), 30)
        self.assertEqual(rs.percentile([30], 90), 30)
        self.assertEqual(rs.percentile([700, 600, 660, 640], 50), 640)   # rank ceil(2.0) = 2
        self.assertEqual(rs.percentile([700, 600, 660, 640], 90), 700)   # rank ceil(3.6) = 4
        self.assertEqual(rs.percentile([120, 600, 640, 660, 700], 50), 640)  # rank ceil(2.5) = 3
        self.assertEqual(rs.percentile([120, 600, 640, 660, 700], 90), 700)  # rank ceil(4.5) = 5
        self.assertEqual(rs.percentile(list(range(1, 11)), 90), 9)         # rank 9 of 10
        self.assertIsNone(rs.percentile([], 50))


class TestDecodePages(unittest.TestCase):
    def test_envelope_pages_concatenate(self):
        pages = [{"total_count": 3, "workflow_runs": [{"id": 1}, {"id": 2}]},
                 {"total_count": 3, "workflow_runs": [{"id": 3}]}]
        self.assertEqual(rs.decode_pages(pages, "workflow_runs"), [{"id": 1}, {"id": 2}, {"id": 3}])

    def test_array_pages_concatenate(self):
        self.assertEqual(rs.decode_pages([[{"n": 1}], [{"n": 2}, {"n": 3}]], None),
                         [{"n": 1}, {"n": 2}, {"n": 3}])

    def test_single_object_page(self):
        self.assertEqual(rs.decode_pages([{"id": 7, "run_attempt": 1}], None), {"id": 7, "run_attempt": 1})

    def test_empty(self):
        self.assertEqual(rs.decode_pages([], "jobs"), [])
        self.assertEqual(rs.decode_pages([], None), [])


class TestGhArgv(unittest.TestCase):
    def test_argv_paginates_and_slurps_without_jq(self):
        ep = "repos/x/y/releases?per_page=100"
        self.assertEqual(rs.gh_argv(ep), ["gh", "api", "--paginate", "--slurp", ep])

    def test_endpoints(self):
        self.assertEqual(
            rs.ci_runs_endpoint("x/y", "2026-07-01"),
            "repos/x/y/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=100&created=>=2026-07-01",
        )
        self.assertEqual(rs.run_attempt_endpoint("x/y", 2, 1), "repos/x/y/actions/runs/2/attempts/1")
        self.assertEqual(rs.run_jobs_endpoint("x/y", 2), "repos/x/y/actions/runs/2/jobs?per_page=100")
        self.assertEqual(rs.run_jobs_endpoint("x/y", 2, 1), "repos/x/y/actions/runs/2/attempts/1/jobs?per_page=100")
        self.assertEqual(rs.release_runs_endpoint("x/y"), "repos/x/y/actions/workflows/release.yml/runs?per_page=100")
        self.assertEqual(rs.releases_endpoint("x/y"), "repos/x/y/releases?per_page=100")
        self.assertEqual(rs.issues_endpoint("x/y"), "repos/x/y/issues?state=all&per_page=100")


class TestResolveRepo(unittest.TestCase):
    def test_precedence_and_git_url_forms(self):
        self.assertEqual(rs.resolve_repo("a/b", {"GITHUB_REPOSITORY": "c/d"}, "git@github.com:e/f.git"), "a/b")
        self.assertEqual(rs.resolve_repo(None, {"GITHUB_REPOSITORY": "c/d"}, "git@github.com:e/f.git"), "c/d")
        self.assertEqual(rs.resolve_repo(None, {}, "git@github.com:e/f.git"), "e/f")
        self.assertEqual(rs.resolve_repo(None, {}, "https://github.com/e/f"), "e/f")
        self.assertEqual(rs.resolve_repo(None, {}, "https://github.com/e/f.git\n"), "e/f")
        self.assertIsNone(rs.resolve_repo(None, {}, None))
        self.assertIsNone(rs.resolve_repo(None, {}, "https://example.com/e/f"))


class TestFixtureSource(unittest.TestCase):
    def test_reads_decoded_lists(self):
        src = rs.FixtureSource(FIXTURES)
        runs = src.ci_runs("2026-07-01")
        self.assertEqual([r["id"] for r in runs], list(range(1, 10)))
        self.assertEqual(src.run_attempt(2, 1)["conclusion"], "failure")
        self.assertEqual([j["name"] for j in src.run_jobs(2, 1)], [MAC])
        self.assertEqual([j["name"] for j in src.run_jobs(2)], [MAC])
        self.assertEqual(len(src.release_runs()), 5)
        self.assertEqual([r["tag_name"] for r in src.releases()][:3], ["v0.1.0", "v0.0.9", "v0.0.8"])
        self.assertEqual(len(src.issues()), 7)   # two pages merged


class TestGhSource(unittest.TestCase):
    def test_live_and_fixture_paths_share_the_decoder(self):
        mapping = {
            rs.ci_runs_endpoint("x/y", "2026-07-01"): "ci-runs.json",
            rs.run_attempt_endpoint("x/y", 2, 1): "attempts/2-1.json",
            rs.run_jobs_endpoint("x/y", 2, 1): "jobs/2-1.json",
            rs.run_jobs_endpoint("x/y", 2): "jobs/2-latest.json",
            rs.release_runs_endpoint("x/y"): "release-runs.json",
            rs.releases_endpoint("x/y"): "releases.json",
            rs.issues_endpoint("x/y"): "issues.json",
        }
        calls = []

        def runner(argv):
            calls.append(argv)
            self.assertEqual(argv[:4], ["gh", "api", "--paginate", "--slurp"])
            self.assertEqual(len(argv), 5)
            return _load(mapping[argv[4]])

        live = rs.GhSource("x/y", runner=runner)
        fix = rs.FixtureSource(FIXTURES)
        self.assertEqual(live.ci_runs("2026-07-01"), fix.ci_runs("2026-07-01"))
        self.assertEqual(live.run_attempt(2, 1), fix.run_attempt(2, 1))
        self.assertEqual(live.run_jobs(2, 1), fix.run_jobs(2, 1))
        self.assertEqual(live.run_jobs(2), fix.run_jobs(2))
        self.assertEqual(live.release_runs(), fix.release_runs())
        self.assertEqual(live.releases(), fix.releases())
        self.assertEqual(live.issues(), fix.issues())
        self.assertEqual(len(calls), 7)


class TestCiWindow(unittest.TestCase):
    def setUp(self):
        self.runs = rs.FixtureSource(FIXTURES).ci_runs("2026-07-01")

    def test_denominator_and_exclusions(self):
        w = rs.ci_window(self.runs, SINCE)
        self.assertEqual([r["id"] for r in w["denominator"]], [1, 2, 3, 4, 8])
        self.assertEqual(w["excluded"], {"cancelled": 1, "in_progress": 1, "skipped": 0})

    def test_pull_request_run_dropped(self):
        w = rs.ci_window(self.runs, SINCE)
        self.assertNotIn(7, [r["id"] for r in w["denominator"]])

    def test_since_applied_client_side(self):
        w = rs.ci_window(self.runs, SINCE)
        self.assertNotIn(9, [r["id"] for r in w["denominator"]])
        w2 = rs.ci_window(self.runs, datetime(2026, 6, 1, tzinfo=timezone.utc))
        self.assertIn(9, [r["id"] for r in w2["denominator"]])


class TestFlake(unittest.TestCase):
    def setUp(self):
        self.src = rs.FixtureSource(FIXTURES)
        self.den = rs.ci_window(self.src.ci_runs("2026-07-01"), SINCE)["denominator"]

    def test_flake_rate_and_attribution(self):
        f = rs.compute_flake(self.den, self.src)
        self.assertEqual(f["denominator"], 5)
        self.assertAlmostEqual(f["rate"], 0.2)
        self.assertEqual([x["run_id"] for x in f["flakes"]], [2])
        self.assertEqual(f["flakes"][0]["jobs"], [{"name": MAC, "steps": ["pnpm test (vitest)"]}])
        self.assertEqual(f["flakes"][0]["created_at"], "2026-07-06T10:00:00Z")

    def test_rerun_of_green_is_not_a_flake(self):
        f = rs.compute_flake(self.den, self.src)
        self.assertEqual(f["reruns_of_green"], [3])
        self.assertNotIn(3, [x["run_id"] for x in f["flakes"]])

    def test_denominator_excludes_cancelled_and_in_progress(self):
        f = rs.compute_flake(self.den, self.src)
        self.assertEqual(f["denominator"], 5)
        self.assertAlmostEqual(f["rate"], 1 / 5)

    def test_breakage(self):
        f = rs.compute_flake(self.den, self.src)
        self.assertEqual([x["run_id"] for x in f["breakage"]], [4])
        self.assertEqual(f["breakage"][0]["jobs"], [{"name": MAC, "steps": ["cargo test (workspace)"]}])


class TestDuration(unittest.TestCase):
    def setUp(self):
        self.src = rs.FixtureSource(FIXTURES)
        self.den = rs.ci_window(self.src.ci_runs("2026-07-01"), SINCE)["denominator"]

    def test_failed_jobs_with_timestamps_count(self):
        d = rs.compute_durations(self.den, self.src)
        self.assertEqual(d[MAC], {"n": 5, "p50_s": 640, "p90_s": 700})

    def test_skipped_and_unfinished_jobs_excluded(self):
        d = rs.compute_durations(self.den, self.src)
        self.assertEqual(d[LIN], {"n": 1, "p50_s": 30, "p90_s": 30})
        self.assertNotIn("dependency audit (cargo deny + pnpm audit)", d)
        self.assertNotIn("secret scan (R5)", d)
        self.assertEqual(list(d)[0], MAC)   # the full gate is listed first


class TestReleases(unittest.TestCase):
    def setUp(self):
        self.r = rs.compute_releases(rs.FixtureSource(FIXTURES))

    def test_per_tag_intervals(self):
        by = {t["tag"]: t for t in self.r["per_tag"]}
        self.assertEqual([t["tag"] for t in self.r["per_tag"]], ["v0.0.8", "v0.0.9", "v0.1.0"])
        self.assertEqual((by["v0.1.0"]["pipeline_s"], by["v0.1.0"]["signoff_s"], by["v0.1.0"]["lead_s"],
                          by["v0.1.0"]["commit_to_published_s"]), (700, 504, 1204, 1930))
        self.assertEqual((by["v0.0.8"]["pipeline_s"], by["v0.0.8"]["signoff_s"], by["v0.0.8"]["lead_s"],
                          by["v0.0.8"]["commit_to_published_s"]), (535, 661, 1196, 2205))
        self.assertEqual(by["v0.1.0"]["run_id"], 104)
        self.assertEqual(by["v0.1.0"]["pipeline_done_at"], "2026-07-10T00:59:23Z")

    def test_pipeline_ends_at_last_job(self):
        by = {t["tag"]: t for t in self.r["per_tag"]}
        self.assertEqual(by["v0.1.0"]["pipeline_s"], 700)   # not 760 (run updated_at)

    def test_successful_run_preferred(self):
        by = {t["tag"]: t for t in self.r["per_tag"]}
        self.assertEqual(by["v0.0.9"]["run_id"], 102)
        self.assertEqual(by["v0.0.9"]["run_started_at"], "2026-07-07T03:19:54Z")
        self.assertEqual(by["v0.0.9"]["pipeline_s"], 776)

    def test_smoke_na_before_step_exists(self):
        by = {t["tag"]: t for t in self.r["per_tag"]}
        self.assertEqual(by["v0.0.8"]["smoke"], "pass")
        self.assertEqual(by["v0.0.9"]["smoke"], "n/a")
        self.assertEqual(by["v0.1.0"]["smoke"], "n/a")
        self.assertEqual(self.r["smoke"], {"pass": 1, "fail": 0, "na": 2})

    def test_medians_carry_n(self):
        self.assertEqual(self.r["median_pipeline_s"], {"n": 3, "value": 700})
        self.assertEqual(self.r["median_signoff_s"], {"n": 3, "value": 504})
        self.assertEqual(self.r["median_lead_s"], {"n": 3, "value": 1196})
        self.assertEqual(self.r["median_commit_to_published_s"], {"n": 3, "value": 1930})

    def test_drafts_and_non_semver_tags_ignored(self):
        self.assertNotIn("v9.9.9", [t["tag"] for t in self.r["per_tag"]])
        self.assertNotIn("nightly", [t["tag"] for t in self.r["per_tag"]])


class TestEscapedDefects(unittest.TestCase):
    def setUp(self):
        src = rs.FixtureSource(FIXTURES)
        self.e = rs.compute_escaped_defects(src.releases(), src.issues())

    def test_literal_overlapping_windows(self):
        per = {t["tag"]: t for t in self.e["per_tag"]}
        self.assertEqual(per["v0.0.8"]["issues"], [145])
        self.assertEqual(per["v0.0.9"]["issues"], [145, 150])
        self.assertEqual(per["v0.1.0"]["issues"], [150, 180])
        self.assertEqual(self.e["attributions"], 5)
        self.assertEqual(self.e["distinct"], 3)
        self.assertEqual(per["v0.0.9"]["window_end"], "2026-07-14T03:18:08Z")

    def test_window_end_inclusive(self):
        per = {t["tag"]: t for t in self.e["per_tag"]}
        self.assertIn(150, per["v0.0.9"]["issues"])   # created exactly at tag + 7 days

    def test_outside_and_label_coverage(self):
        self.assertEqual(self.e["outside_any_window"], [37])
        self.assertEqual(self.e["label_coverage"]["fix_titled_unlabelled"], [148])

    def test_pull_requests_ignored(self):
        for t in self.e["per_tag"]:
            self.assertNotIn(160, t["issues"])
        self.assertNotIn(160, self.e["outside_any_window"])


class TestCiEndToEnd(unittest.TestCase):
    def test_ci_mode_prints_and_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp) / "reports"
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = rs.main(["--ci", "--ci-fixtures", str(FIXTURES), "--repo", "x/y",
                              "--since", "2026-07-01", "--out", str(out)])
            self.assertEqual(rc, 0)
            md = (out / "ci-stats.md").read_text(encoding="utf-8")
            stats = json.loads((out / "ci-stats.json").read_text(encoding="utf-8"))
            for heading in ("## Window", "## Flake rate", "## Duration", "## Releases", "## Escaped defects"):
                self.assertIn(heading, md)
                self.assertIn(heading, buf.getvalue())
            self.assertEqual(stats["schema"], "termixion-ci-stats/1")
            self.assertEqual(stats["repo"], "x/y")
            self.assertEqual(stats["window"]["since"], "2026-07-01")
            self.assertEqual(stats["window"]["source"], "fixture")
            self.assertEqual(stats["flake"]["rate"], 0.2)
            self.assertEqual(stats["flake"]["denominator"], 5)
            self.assertEqual(stats["flake"]["excluded"], {"cancelled": 1, "in_progress": 1, "skipped": 0})
            self.assertEqual([f["run_id"] for f in stats["flake"]["flakes"]], [2])
            self.assertEqual(stats["flake"]["reruns_of_green"], [3])
            self.assertEqual([b["run_id"] for b in stats["flake"]["breakage"]], [4])
            self.assertEqual(stats["duration"][MAC], {"n": 5, "p50_s": 640, "p90_s": 700})
            self.assertEqual(stats["duration"][LIN], {"n": 1, "p50_s": 30, "p90_s": 30})
            rel = {t["tag"]: t for t in stats["releases"]["per_tag"]}
            self.assertEqual((rel["v0.1.0"]["pipeline_s"], rel["v0.1.0"]["signoff_s"], rel["v0.1.0"]["lead_s"],
                              rel["v0.1.0"]["commit_to_published_s"], rel["v0.1.0"]["smoke"]),
                             (700, 504, 1204, 1930, "n/a"))
            self.assertEqual(rel["v0.0.9"]["run_started_at"], "2026-07-07T03:19:54Z")
            self.assertEqual(stats["releases"]["median_lead_s"], {"n": 3, "value": 1196})
            self.assertEqual(stats["releases"]["smoke"], {"pass": 1, "fail": 0, "na": 2})
            esc = {t["tag"]: t["issues"] for t in stats["escaped_defects"]["per_tag"]}
            self.assertEqual(esc, {"v0.0.8": [145], "v0.0.9": [145, 150], "v0.1.0": [150, 180]})
            self.assertEqual(stats["escaped_defects"]["attributions"], 5)
            self.assertEqual(stats["escaped_defects"]["distinct"], 3)
            self.assertEqual(stats["escaped_defects"]["outside_any_window"], [37])
            self.assertEqual(stats["escaped_defects"]["label_coverage"]["fix_titled_unlabelled"], [148])
            self.assertNotIn("repo-stats.md", os.listdir(out))   # --ci replaces the codebase report


class TestWeeklyWorkflow(unittest.TestCase):
    """The weekly measurement is never on the PR path (trmx-265): structural pins on the workflow."""

    def setUp(self):
        self.text = WORKFLOW.read_text(encoding="utf-8")
        self.lines = self.text.splitlines()
        # Substring checks look at code lines only, so comments may mention what is forbidden.
        self.code = "\n".join(l for l in self.lines if not l.lstrip().startswith("#"))

    def _block(self, key):
        """Top-level keys of the mapping under a top-level `key:` line."""
        start = self.lines.index(f"{key}:")
        keys = []
        for line in self.lines[start + 1:]:
            if line and not line.startswith(" "):
                break
            m = re.match(r"^  ([A-Za-z_-]+):", line)
            if m:
                keys.append(m.group(1))
        return keys

    def test_triggers_are_schedule_and_dispatch_only(self):
        self.assertEqual(sorted(self._block("on")), ["schedule", "workflow_dispatch"])
        self.assertNotIn("pull_request", self.code)
        self.assertNotRegex(self.code, re.compile(r"^\s*push:", re.M))

    def test_read_only_permissions(self):
        self.assertEqual(self._block("permissions"), ["actions", "contents", "issues"])
        self.assertRegex(self.text, re.compile(r"^  actions: read$", re.M))
        self.assertRegex(self.text, re.compile(r"^  contents: read$", re.M))
        self.assertRegex(self.text, re.compile(r"^  issues: read$", re.M))
        self.assertNotRegex(self.code, r":\s*write\b")

    def test_fork_guard_timeout_concurrency(self):
        self.assertIn("if: github.repository == 'xinquan568/termixion'", self.text)
        self.assertRegex(self.text, re.compile(r"^\s+timeout-minutes: \d+$", re.M))
        self.assertRegex(self.text, re.compile(r"^concurrency:$", re.M))

    def test_since_is_wired_from_the_dispatch_input(self):
        self.assertIn("SINCE: ${{ inputs.since }}", self.text)
        self.assertIn("GH_TOKEN: ${{ github.token }}", self.text)
        self.assertIn('${SINCE:+--since "$SINCE"}', self.text)

    def test_actions_are_sha_pinned(self):
        uses = re.findall(r"^\s+(?:- )?uses: (\S+)(.*)$", self.text, re.M)
        self.assertTrue(uses)
        for ref, rest in uses:
            self.assertRegex(ref, r"@[0-9a-f]{40}$", ref)
            self.assertRegex(rest, r"# v\d+", ref)


class TestWeeklyWorkflowShell(unittest.TestCase):
    """The measure step's shell fragment: no --since under the schedule (empty input), --since under dispatch."""

    def _run(self, since_value):
        text = WORKFLOW.read_text(encoding="utf-8")
        line = next(l for l in text.splitlines() if "run:" in l and "${SINCE:+" in l)
        cmd = line.split("run:", 1)[1].strip() if "run:" in line else line.strip()
        with tempfile.TemporaryDirectory() as tmp:
            stub = pathlib.Path(tmp) / "bin"
            stub.mkdir()
            log = pathlib.Path(tmp) / "argv.txt"
            (stub / "python3").write_text("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$ARGV_LOG\"\n")
            (stub / "python3").chmod(0o755)
            env = {**os.environ, "PATH": f"{stub}{os.pathsep}{os.environ['PATH']}",
                   "ARGV_LOG": str(log), "SINCE": since_value}
            subprocess.run(["bash", "-c", cmd], cwd=tmp, env=env, check=True)
            return log.read_text().split("\n")

    def test_schedule_without_since(self):
        argv = self._run("")
        self.assertIn("--ci", argv)
        self.assertNotIn("--since", argv)

    def test_dispatch_with_since(self):
        argv = self._run("2026-07-01")
        self.assertIn("--since", argv)
        self.assertEqual(argv[argv.index("--since") + 1], "2026-07-01")


if __name__ == "__main__":
    unittest.main(verbosity=2)
