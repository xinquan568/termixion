# SPDX-License-Identifier: ISC
"""Tests for scripts/repo-stats.py (trmx-213). Run: python3 scripts/repo-stats.test.py"""

import importlib.util
import pathlib
import subprocess
import sys
import tempfile
import unittest

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
