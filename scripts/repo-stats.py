#!/usr/bin/env python3
# SPDX-License-Identifier: ISC
"""repo-stats (trmx-213): codebase statistics over git-tracked files.

Emits a Markdown and a self-contained HTML report covering file/line totals,
production-vs-test breakdown (including Rust inline #[cfg(test)] blocks),
per-language lines, test-case counts, and file size / line-count extremes.

Usage: python3 scripts/repo-stats.py [repo-root] [--out DIR] [--format both|md|html]
       python3 scripts/repo-stats.py --ci [--since YYYY-MM-DD] [--repo owner/name] [--ci-fixtures DIR]
Defaults: repo-root = parent of scripts/, out = <root>/reports/repo-stats (git-ignored).
Stdlib only (Python 3.10+; CI runs the runner's python3); requires `git` on PATH.

--ci (trmx-265, grill Add-on 5 metrics 2-5) is a measurement, never a gate: it reads GitHub's own data
through `gh api` and writes ci-stats.md + ci-stats.json — CI flake rate on main (re-run-to-green),
per-job gate duration p50/p90, release lead time (tag push -> published, split into pipeline and
human sign-off) and escaped defects per release (bug-labelled issues opened within 7 days of a tag).
`--ci-fixtures DIR` replays recorded API pages offline (the unit tests never call gh).
"""

from __future__ import annotations

import argparse
import html as html_mod
import json
import math
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

LANG_BY_EXT = {
    "rs": "Rust",
    "ts": "TypeScript",
    "tsx": "TypeScript",
    "js": "JavaScript",
    "mjs": "JavaScript",
    "cjs": "JavaScript",
    "jsx": "JavaScript",
    "css": "CSS",
    "html": "HTML",
    "sh": "Shell",
    "bash": "Shell",
    "zsh": "Shell",
    "py": "Python",
}
HOOK_BASENAMES = {
    "pre-commit", "pre-push", "commit-msg", "post-checkout",
    "post-merge", "post-commit", "prepare-commit-msg", "pre-rebase",
}
ASSET_EXTS = {"woff", "woff2", "ttf", "otf", "png", "jpg", "jpeg", "gif", "ico", "icns", "svg", "webp"}
DOC_EXTS = {"md", "txt", "adoc", "rst"}
DOC_BASENAMES = {"LICENSE", "COPYING", "NOTICE"}
CONFIG_EXTS = {"toml", "json", "yaml", "yml", "conf", "cfg", "ini", "xml"}
CONFIG_BASENAMES = {
    ".gitignore", ".gitattributes", ".editorconfig", ".nvmrc", ".npmrc",
    ".taurignore", ".version", ".gitkeep", ".prettierrc",
}
LOCK_BASENAMES = {"Cargo.lock", "pnpm-lock.yaml", "package-lock.json", "yarn.lock"}
TEST_DIR_SEGMENTS = {"tests", "__tests__", "e2e", "test"}

# "(by file)": category rows classify whole files, so a production .rs file's
# inline #[cfg(test)] lines land here under prod; the "Production vs test code"
# section is the line-accurate split that reattributes those lines to test.
CATEGORY_LABELS = {
    "prod": "Production code (by file)",
    "test": "Test code (by file)",
    "docs": "Documentation",
    "config": "Configuration",
    "vendored": "Vendored (resources/)",
    "generated": "Generated / lockfiles",
    "assets": "Binary assets",
    "other": "Other",
}
CATEGORY_ORDER = ["prod", "test", "docs", "config", "vendored", "generated", "assets", "other"]

RUST_CFG_TEST_RE = re.compile(r"\s*#\[\s*cfg\s*\(\s*test\s*\)\s*\]")
RUST_TEST_ATTR_RES = [
    re.compile(r"#\[\s*(?:[A-Za-z_][\w:]*::)?test\s*(?:\]|\()"),
    re.compile(r"#\[\s*test_case\s*[\(\]]"),
    re.compile(r"#\[\s*rstest\b"),
]
TS_TEST_CASE_RE = re.compile(
    r"(?<![\w.$])(?:it|test)"
    r"(?:\.(?:each|skip|only|todo|concurrent|serial|sequential|fixme|fails))?"
    r"\s*[(`]"
)


def _ext(base: str) -> str:
    return base.rsplit(".", 1)[1].lower() if "." in base[1:] else ""


def language_of(path: str) -> str | None:
    """Programming language of a code file, or None if the path is not code."""
    base = path.rsplit("/", 1)[-1]
    if base in HOOK_BASENAMES:
        return "Shell"
    return LANG_BY_EXT.get(_ext(base))


def is_test_path(path: str) -> bool:
    parts = path.split("/")
    if any(p in TEST_DIR_SEGMENTS for p in parts[:-1]):
        return True
    return bool(re.search(r"\.(test|spec)\.", parts[-1]))


def categorize(path: str) -> str:
    """One category per tracked path; order of the rules is the precedence."""
    parts = path.split("/")
    base = parts[-1]
    if parts[0] == "resources":
        return "vendored"
    if base in LOCK_BASENAMES:
        return "generated"
    ext = _ext(base)
    if ext in ASSET_EXTS:
        return "assets"
    if language_of(path) is not None:
        return "test" if is_test_path(path) else "prod"
    if ext in DOC_EXTS or base in DOC_BASENAMES or base.startswith("LICENSE"):
        return "docs"
    if ext in CONFIG_EXTS or base in CONFIG_BASENAMES:
        return "config"
    return "other"


def extract_rust_test_lines(source: str) -> int:
    """Lines inside #[cfg(test)] blocks (attribute line through the matching
    closing brace), by brace counting. Best-effort: braces in string literals
    or comments can skew the match; unbalanced blocks count to end-of-file."""
    lines = source.splitlines()
    total = 0
    i = 0
    while i < len(lines):
        if not RUST_CFG_TEST_RE.match(lines[i]):
            i += 1
            continue
        depth = 0
        opened = False
        j = i
        while j < len(lines):
            for ch in lines[j]:
                if ch == "{":
                    depth += 1
                    opened = True
                elif ch == "}":
                    depth -= 1
            if opened and depth <= 0:
                break
            j += 1
        end = min(j, len(lines) - 1)
        total += end - i + 1
        i = end + 1
    return total


def count_ts_test_cases(source: str) -> int:
    """Vitest/Playwright cases: it(/test( plus whitelisted modifiers such as
    .skip/.only/.each — a parameterized .each counts once, not per row."""
    return len(TS_TEST_CASE_RE.findall(source))


def count_rust_test_cases(source: str) -> int:
    return sum(len(r.findall(source)) for r in RUST_TEST_ATTR_RES)


def human_size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    size = float(n)
    for unit in ("KB", "MB", "GB", "TB"):
        size /= 1024.0
        if size < 1024:
            return f"{size:.1f} {unit}"
    return f"{size:.1f} PB"


def _git_files(root: Path) -> list[str]:
    out = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z"],
        capture_output=True, check=True,
    ).stdout
    return [p for p in out.decode("utf-8", errors="replace").split("\0") if p]


def _git_commit(root: Path) -> str:
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--short", "HEAD"],
            capture_output=True, check=True,
        ).stdout
        return out.decode().strip()
    except subprocess.CalledProcessError:
        return "(no commit)"


def analyze(root: Path | str) -> dict:
    root = Path(root).resolve()
    records = []
    for rel in _git_files(root):
        fpath = root / rel
        if not fpath.is_file():
            continue
        data = fpath.read_bytes()
        binary = b"\0" in data[:8192]
        text = None if binary else data.decode("utf-8", errors="replace")
        lines = None if binary else len(text.splitlines())
        category = categorize(rel)
        rec = {
            "path": rel,
            "size": len(data),
            "lines": lines,
            "binary": binary,
            "category": category,
            "language": language_of(rel),
            "inline_test_lines": 0,
            "test_cases": 0,
            "framework": None,
        }
        if not binary:
            if rec["language"] == "Rust":
                if category == "prod":
                    rec["inline_test_lines"] = extract_rust_test_lines(text)
                rec["test_cases"] = count_rust_test_cases(text)
                rec["framework"] = "Rust" if rec["test_cases"] else None
            elif rec["language"] == "TypeScript" and category == "test":
                rec["test_cases"] = count_ts_test_cases(text)
                rec["framework"] = (
                    "Playwright (e2e)" if rel.startswith("app/e2e/") else "Vitest (unit)"
                )
        records.append(rec)

    by_category = {}
    for rec in records:
        c = by_category.setdefault(rec["category"], {"files": 0, "lines": 0, "bytes": 0})
        c["files"] += 1
        c["lines"] += rec["lines"] or 0
        c["bytes"] += rec["size"]

    rust_inline = sum(r["inline_test_lines"] for r in records)
    prod_lines = by_category.get("prod", {}).get("lines", 0) - rust_inline
    test_lines = by_category.get("test", {}).get("lines", 0) + rust_inline

    by_language = {}
    for rec in records:
        if rec["category"] not in ("prod", "test") or rec["language"] is None:
            continue
        lang = by_language.setdefault(
            rec["language"], {"files": 0, "prod_lines": 0, "test_lines": 0}
        )
        lang["files"] += 1
        n = rec["lines"] or 0
        if rec["category"] == "prod":
            lang["prod_lines"] += n - rec["inline_test_lines"]
            lang["test_lines"] += rec["inline_test_lines"]
        else:
            lang["test_lines"] += n

    test_cases = {}
    for rec in records:
        if rec["framework"]:
            test_cases[rec["framework"]] = test_cases.get(rec["framework"], 0) + rec["test_cases"]

    code = [r for r in records if r["category"] in ("prod", "test") and not r["binary"]]
    by_size_all = sorted(records, key=lambda r: (-r["size"], r["path"]))
    by_size_asc = sorted(records, key=lambda r: (r["size"], r["path"]))
    by_lines_desc = sorted(code, key=lambda r: (-(r["lines"] or 0), r["path"]))
    by_lines_asc = sorted(code, key=lambda r: (r["lines"] or 0, r["path"]))

    return {
        "root": str(root),
        "commit": _git_commit(root),
        "generated_at": datetime.now().astimezone().strftime("%Y-%m-%d %H:%M %Z"),
        "total_files": len(records),
        "total_bytes": sum(r["size"] for r in records),
        "total_lines": sum(r["lines"] or 0 for r in records),
        "by_category": by_category,
        "by_language": by_language,
        "prod_lines": prod_lines,
        "test_lines": test_lines,
        "rust_inline_test_lines": rust_inline,
        "test_cases": test_cases,
        "largest_all": by_size_all[:5],
        "smallest_all": by_size_asc[:5],
        "top_lines": by_lines_desc[:5],
        "bottom_lines": by_lines_asc[:5],
        "code_files": len(code),
        "code_lines": prod_lines + test_lines,
    }


def _pct(part: int, whole: int) -> str:
    return f"{100.0 * part / whole:.1f}%" if whole else "n/a"


def render_markdown(s: dict) -> str:
    L = []
    L.append("# Repository statistics")
    L.append("")
    L.append(f"Generated {s['generated_at']} at commit `{s['commit']}` — root `{s['root']}`.")
    L.append("Scope: git-tracked files only. Lines = text lines; binary files count for files/bytes only.")
    L.append("")
    L.append("## Overview")
    L.append("")
    L.append("| Metric | Value |")
    L.append("|---|---:|")
    L.append(f"| Tracked files | {s['total_files']} |")
    L.append(f"| Total lines (all text files) | {s['total_lines']:,} |")
    L.append(f"| Code files (prod + test) | {s['code_files']} |")
    L.append(f"| Code lines (prod + test) | {s['code_lines']:,} |")
    L.append(f"| Total size | {human_size(s['total_bytes'])} |")
    L.append("")
    L.append("## Category breakdown")
    L.append("")
    L.append("| Category | Files | Lines | Size |")
    L.append("|---|---:|---:|---:|")
    for key in CATEGORY_ORDER:
        c = s["by_category"].get(key)
        if not c:
            continue
        L.append(f"| {CATEGORY_LABELS[key]} | {c['files']} | {c['lines']:,} | {human_size(c['bytes'])} |")
    L.append("")
    L.append("## Production vs test code")
    L.append("")
    L.append("| Kind | Lines | Share of code |")
    L.append("|---|---:|---:|")
    L.append(f"| Production | {s['prod_lines']:,} | {_pct(s['prod_lines'], s['code_lines'])} |")
    L.append(f"| Test | {s['test_lines']:,} | {_pct(s['test_lines'], s['code_lines'])} |")
    L.append("")
    L.append(f"Rust inline `#[cfg(test)]` blocks contribute {s['rust_inline_test_lines']:,} of the "
             "test lines (extracted from production .rs files by brace matching).")
    L.append("")
    L.append("## Language breakdown (code files)")
    L.append("")
    L.append("| Language | Files | Prod lines | Test lines | Total |")
    L.append("|---|---:|---:|---:|---:|")
    langs = sorted(s["by_language"].items(),
                   key=lambda kv: -(kv[1]["prod_lines"] + kv[1]["test_lines"]))
    for name, v in langs:
        total = v["prod_lines"] + v["test_lines"]
        L.append(f"| {name} | {v['files']} | {v['prod_lines']:,} | {v['test_lines']:,} | {total:,} |")
    L.append("")
    L.append("## Test cases")
    L.append("")
    L.append("| Framework | Cases |")
    L.append("|---|---:|")
    total_cases = 0
    for name in sorted(s["test_cases"]):
        L.append(f"| {name} | {s['test_cases'][name]} |")
        total_cases += s["test_cases"][name]
    L.append(f"| **Total** | **{total_cases}** |")
    L.append("")
    L.append("A parameterized `it.each`/`test.each` counts once. Rust counts `#[test]`-family "
             "attributes (`#[tokio::test]`, `#[test_case]`, `#[rstest]` included).")
    L.append("")
    L.append("## File size extremes (all tracked files)")
    L.append("")
    largest = s["largest_all"][0]
    smallest = s["smallest_all"][0]
    L.append(f"- Largest: `{largest['path']}` — {human_size(largest['size'])}")
    L.append(f"- Smallest: `{smallest['path']}` — {human_size(smallest['size'])}")
    L.append("")
    L.append("| Top 5 largest | Size | Top 5 smallest | Size |")
    L.append("|---|---:|---|---:|")
    for big, small in zip(s["largest_all"], s["smallest_all"]):
        L.append(f"| `{big['path']}` | {human_size(big['size'])} "
                 f"| `{small['path']}` | {human_size(small['size'])} |")
    L.append("")
    L.append("## Line count extremes (code files)")
    L.append("")
    most = s["top_lines"][0]
    fewest = s["bottom_lines"][0]
    L.append(f"- Most lines: `{most['path']}` — {most['lines']:,} lines")
    L.append(f"- Fewest lines: `{fewest['path']}` — {fewest['lines']:,} lines (ties broken alphabetically)")
    L.append("")
    L.append("| Top 5 by lines | Lines | Bottom 5 by lines | Lines |")
    L.append("|---|---:|---|---:|")
    for big, small in zip(s["top_lines"], s["bottom_lines"]):
        L.append(f"| `{big['path']}` | {big['lines']:,} | `{small['path']}` | {small['lines']:,} |")
    L.append("")
    return "\n".join(L)


def _meter(pct: float) -> str:
    return (f'<div class="meter" title="{pct:.1f}%">'
            f'<div class="meter-fill" style="width:{pct:.1f}%"></div></div>')


def render_html(s: dict) -> str:
    e = html_mod.escape
    total_cases = sum(s["test_cases"].values())

    cat_rows = []
    for key in CATEGORY_ORDER:
        c = s["by_category"].get(key)
        if not c:
            continue
        pct = 100.0 * c["lines"] / s["total_lines"] if s["total_lines"] else 0.0
        cat_rows.append(
            f"<tr><td>{e(CATEGORY_LABELS[key])}</td><td class='n'>{c['files']}</td>"
            f"<td class='n'>{c['lines']:,}</td><td class='n'>{e(human_size(c['bytes']))}</td>"
            f"<td class='bar'>{_meter(pct)}<span class='pct'>{pct:.1f}%</span></td></tr>"
        )

    langs = sorted(s["by_language"].items(),
                   key=lambda kv: -(kv[1]["prod_lines"] + kv[1]["test_lines"]))
    lang_rows = []
    for name, v in langs:
        total = v["prod_lines"] + v["test_lines"]
        pct = 100.0 * total / s["code_lines"] if s["code_lines"] else 0.0
        lang_rows.append(
            f"<tr><td>{e(name)}</td><td class='n'>{v['files']}</td>"
            f"<td class='n'>{v['prod_lines']:,}</td><td class='n'>{v['test_lines']:,}</td>"
            f"<td class='n'>{total:,}</td>"
            f"<td class='bar'>{_meter(pct)}<span class='pct'>{pct:.1f}%</span></td></tr>"
        )

    case_rows = [
        f"<tr><td>{e(name)}</td><td class='n'>{s['test_cases'][name]}</td></tr>"
        for name in sorted(s["test_cases"])
    ]
    case_rows.append(f"<tr class='total'><td>Total</td><td class='n'>{total_cases}</td></tr>")

    def pair_rows(left, right, fmt_l, fmt_r):
        rows = []
        for a, b in zip(left, right):
            rows.append(f"<tr><td class='path'>{e(a['path'])}</td><td class='n'>{fmt_l(a)}</td>"
                        f"<td class='path'>{e(b['path'])}</td><td class='n'>{fmt_r(b)}</td></tr>")
        return "".join(rows)

    size_rows = pair_rows(s["largest_all"], s["smallest_all"],
                          lambda r: e(human_size(r["size"])), lambda r: e(human_size(r["size"])))
    line_rows = pair_rows(s["top_lines"], s["bottom_lines"],
                          lambda r: f"{r['lines']:,}", lambda r: f"{r['lines']:,}")

    prod_pct = 100.0 * s["prod_lines"] / s["code_lines"] if s["code_lines"] else 0.0
    test_pct = 100.0 * s["test_lines"] / s["code_lines"] if s["code_lines"] else 0.0

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Termixion repo statistics</title>
<style>
:root {{
  --surface: #fcfcfb; --text: #0b0b0b; --text-2: #52514e;
  --accent: #2a78d6; --track: #f0efec; --border: #e4e3df;
}}
@media (prefers-color-scheme: dark) {{
  :root {{
    --surface: #1a1a19; --text: #ffffff; --text-2: #c3c2b7;
    --accent: #3987e5; --track: #383835; --border: #3d3d3a;
  }}
}}
* {{ box-sizing: border-box; }}
body {{
  margin: 0 auto; padding: 2rem 1.25rem 4rem; max-width: 68rem;
  background: var(--surface); color: var(--text);
  font: 15px/1.55 -apple-system, "Segoe UI", system-ui, sans-serif;
}}
h1 {{ font-size: 1.5rem; margin: 0 0 .25rem; }}
h2 {{ font-size: 1.1rem; margin: 2.25rem 0 .75rem; }}
.sub {{ color: var(--text-2); font-size: .85rem; margin-bottom: 1.5rem; }}
.tiles {{ display: flex; flex-wrap: wrap; gap: .75rem; margin: 1.25rem 0; }}
.tile {{
  flex: 1 1 9rem; border: 1px solid var(--border); border-radius: 8px; padding: .8rem 1rem;
}}
.tile .v {{ font-size: 1.45rem; font-weight: 650; font-variant-numeric: tabular-nums; }}
.tile .k {{ color: var(--text-2); font-size: .8rem; }}
.wrap {{ overflow-x: auto; }}
table {{ border-collapse: collapse; width: 100%; font-size: .9rem; }}
th, td {{ text-align: left; padding: .4rem .65rem; border-bottom: 1px solid var(--border); }}
th {{ color: var(--text-2); font-weight: 600; font-size: .8rem; }}
td.n, th.n {{ text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }}
td.path {{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8rem; }}
td.bar {{ width: 12rem; }}
tr.total td {{ font-weight: 650; }}
.meter {{
  display: inline-block; vertical-align: middle; width: 8rem; height: 10px;
  background: var(--track); border-radius: 4px; overflow: hidden;
}}
.meter-fill {{ height: 100%; background: var(--accent); border-radius: 0 4px 4px 0; }}
.pct {{ margin-left: .5rem; color: var(--text-2); font-size: .8rem; font-variant-numeric: tabular-nums; }}
.note {{ color: var(--text-2); font-size: .8rem; margin-top: .5rem; }}
</style>
</head>
<body>
<h1>Termixion repository statistics</h1>
<div class="sub">Generated {e(s['generated_at'])} at commit <code>{e(s['commit'])}</code> —
scope: git-tracked files only; binary files count for files/bytes, not lines.</div>

<div class="tiles">
  <div class="tile"><div class="v">{s['total_files']}</div><div class="k">tracked files</div></div>
  <div class="tile"><div class="v">{s['total_lines']:,}</div><div class="k">total lines</div></div>
  <div class="tile"><div class="v">{s['code_lines']:,}</div><div class="k">code lines (prod + test)</div></div>
  <div class="tile"><div class="v">{test_pct:.1f}%</div><div class="k">of code lines are tests</div></div>
  <div class="tile"><div class="v">{total_cases}</div><div class="k">test cases</div></div>
</div>

<h2>Category breakdown</h2>
<div class="wrap"><table>
<tr><th>Category</th><th class="n">Files</th><th class="n">Lines</th><th class="n">Size</th><th>Share of lines</th></tr>
{''.join(cat_rows)}
</table></div>

<h2>Production vs test code</h2>
<div class="wrap"><table>
<tr><th>Kind</th><th class="n">Lines</th><th>Share of code lines</th></tr>
<tr><td>Production</td><td class="n">{s['prod_lines']:,}</td>
    <td class="bar">{_meter(prod_pct)}<span class="pct">{prod_pct:.1f}%</span></td></tr>
<tr><td>Test</td><td class="n">{s['test_lines']:,}</td>
    <td class="bar">{_meter(test_pct)}<span class="pct">{test_pct:.1f}%</span></td></tr>
</table></div>
<div class="note">Rust inline <code>#[cfg(test)]</code> blocks contribute
{s['rust_inline_test_lines']:,} test lines extracted from production .rs files.</div>

<h2>Language breakdown (code files)</h2>
<div class="wrap"><table>
<tr><th>Language</th><th class="n">Files</th><th class="n">Prod lines</th><th class="n">Test lines</th>
<th class="n">Total</th><th>Share of code lines</th></tr>
{''.join(lang_rows)}
</table></div>

<h2>Test cases</h2>
<div class="wrap"><table>
<tr><th>Framework</th><th class="n">Cases</th></tr>
{''.join(case_rows)}
</table></div>
<div class="note">A parameterized <code>it.each</code>/<code>test.each</code> counts once. Rust counts
<code>#[test]</code>-family attributes (<code>#[tokio::test]</code>, <code>#[test_case]</code>,
<code>#[rstest]</code> included).</div>

<h2>File size extremes (all tracked files)</h2>
<div class="wrap"><table>
<tr><th>Top 5 largest</th><th class="n">Size</th><th>Top 5 smallest</th><th class="n">Size</th></tr>
{size_rows}
</table></div>

<h2>Line count extremes (code files)</h2>
<div class="wrap"><table>
<tr><th>Top 5 by lines</th><th class="n">Lines</th><th>Bottom 5 by lines</th><th class="n">Lines</th></tr>
{line_rows}
</table></div>
<div class="note">Ties broken alphabetically.</div>
</body>
</html>
"""


# ---------------------------------------------------------------------------------------------------
# --ci mode (trmx-265). One source seam (GhSource live / FixtureSource offline) sharing one decoder;
# everything below the sources is pure over the decoded JSON, so the unit tests never reach gh.

CI_WORKFLOW_PATH = ".github/workflows/ci.yml"
FULL_GATE_JOB = "full gate (macos)"
SMOKE_STEP_PREFIX = "Smoke the RELEASE bundle"
SEMVER_TAG_RE = re.compile(r"^v\d+\.\d+\.\d+$")
FIX_TITLE_RE = re.compile(r"^(fix|bug)\b", re.IGNORECASE)
GIT_URL_RE = re.compile(r"github\.com[:/]([^/\s]+)/([^/\s]+?)(?:\.git)?/?\s*$")
ESCAPED_WINDOW = timedelta(days=7)
ESCAPED_RULE = ("bug-labelled issues created within 7 days after the tag's commit date (both ends "
                "inclusive); windows may overlap, so one issue can count against several tags")
CI_SCHEMA = "termixion-ci-stats/1"


def parse_ts(s: str) -> datetime:
    """GitHub timestamps are UTC with a trailing Z; normalise for 3.10's fromisoformat."""
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def fmt_ts(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def percentile(values, p: int):
    """Nearest-rank percentile: sorted values, rank ceil(p/100 * n). None for no samples."""
    if not values:
        return None
    s = sorted(values)
    rank = max(1, math.ceil(p / 100.0 * len(s)))
    return s[rank - 1]


def decode_pages(pages, key: str | None):
    """What `gh api --paginate --slurp` returns is an array of pages: envelopes (`workflow_runs`,
    `jobs`) are concatenated by `key`; bare-array pages are concatenated; a single-object page
    (an attempt) is returned as the object. Both sources go through here."""
    if key is not None:
        out = []
        for page in pages:
            out.extend(page.get(key, []))
        return out
    if not pages:
        return []
    if all(isinstance(page, list) for page in pages):
        out = []
        for page in pages:
            out.extend(page)
        return out
    if len(pages) == 1 and isinstance(pages[0], dict):
        return pages[0]
    raise ValueError("unexpected page shape from gh api --slurp")


def gh_argv(endpoint: str) -> list[str]:
    return ["gh", "api", "--paginate", "--slurp", endpoint]


def ci_runs_endpoint(repo: str, since: str) -> str:
    return (f"repos/{repo}/actions/workflows/ci.yml/runs"
            f"?branch=main&event=push&per_page=100&created=>={since}")


def run_attempt_endpoint(repo: str, run_id: int, attempt: int) -> str:
    return f"repos/{repo}/actions/runs/{run_id}/attempts/{attempt}"


def run_jobs_endpoint(repo: str, run_id: int, attempt: int | None = None) -> str:
    if attempt is None:
        return f"repos/{repo}/actions/runs/{run_id}/jobs?per_page=100"
    return f"repos/{repo}/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100"


def release_runs_endpoint(repo: str) -> str:
    return f"repos/{repo}/actions/workflows/release.yml/runs?per_page=100"


def releases_endpoint(repo: str) -> str:
    return f"repos/{repo}/releases?per_page=100"


def issues_endpoint(repo: str) -> str:
    return f"repos/{repo}/issues?state=all&per_page=100"


def _run_gh(argv: list[str]):
    """The one subprocess edge of --ci: gh's stdout is the slurped page array."""
    out = subprocess.run(argv, capture_output=True, check=True).stdout
    return json.loads(out.decode("utf-8"))


class GhSource:
    """Live source: every method is one `gh api --paginate --slurp` call (memoised per endpoint)."""
    kind = "live"

    def __init__(self, repo: str, runner=None):
        self.repo = repo
        self.runner = runner or _run_gh
        self._cache = {}

    def _get(self, endpoint: str, key: str | None):
        if endpoint not in self._cache:
            self._cache[endpoint] = decode_pages(self.runner(gh_argv(endpoint)), key)
        return self._cache[endpoint]

    def ci_runs(self, since: str):
        return self._get(ci_runs_endpoint(self.repo, since), "workflow_runs")

    def run_attempt(self, run_id: int, attempt: int):
        return self._get(run_attempt_endpoint(self.repo, run_id, attempt), None)

    def run_jobs(self, run_id: int, attempt: int | None = None):
        return self._get(run_jobs_endpoint(self.repo, run_id, attempt), "jobs")

    def release_runs(self):
        return self._get(release_runs_endpoint(self.repo), "workflow_runs")

    def releases(self):
        return self._get(releases_endpoint(self.repo), None)

    def issues(self):
        return self._get(issues_endpoint(self.repo), None)


class FixtureSource:
    """Offline source: files hold exactly the slurped page arrays gh would have returned."""
    kind = "fixture"

    def __init__(self, directory):
        self.dir = Path(directory)

    def _read(self, rel: str, key: str | None):
        pages = json.loads((self.dir / rel).read_text(encoding="utf-8"))
        return decode_pages(pages, key)

    def ci_runs(self, since: str):
        return self._read("ci-runs.json", "workflow_runs")

    def run_attempt(self, run_id: int, attempt: int):
        return self._read(f"attempts/{run_id}-{attempt}.json", None)

    def run_jobs(self, run_id: int, attempt: int | None = None):
        return self._read(f"jobs/{run_id}-{attempt if attempt is not None else 'latest'}.json", "jobs")

    def release_runs(self):
        return self._read("release-runs.json", "workflow_runs")

    def releases(self):
        return self._read("releases.json", None)

    def issues(self):
        return self._read("issues.json", None)


def resolve_repo(flag: str | None, env, git_url: str | None) -> str | None:
    """--repo flag, else $GITHUB_REPOSITORY, else the origin remote URL (ssh or https)."""
    if flag:
        return flag
    if env.get("GITHUB_REPOSITORY"):
        return env["GITHUB_REPOSITORY"]
    if git_url:
        m = GIT_URL_RE.search(git_url)
        if m:
            return f"{m.group(1)}/{m.group(2)}"
    return None


def _git_remote_url(root: Path) -> str | None:
    try:
        out = subprocess.run(["git", "-C", str(root), "remote", "get-url", "origin"],
                             capture_output=True, check=True).stdout
        return out.decode("utf-8", errors="replace")
    except (subprocess.CalledProcessError, OSError):
        return None


def ci_window(runs, since: datetime) -> dict:
    """Provenance re-applied (the predicates of scripts/check-main-ci-green.sh) plus the window;
    the denominator is the completed, non-cancelled, non-skipped runs; the rest is counted."""
    denominator = []
    excluded = {"cancelled": 0, "in_progress": 0, "skipped": 0}
    for r in runs:
        if (r.get("path") != CI_WORKFLOW_PATH or r.get("event") != "push"
                or r.get("head_branch") != "main"):
            continue
        if parse_ts(r["created_at"]) < since:
            continue
        if r.get("status") != "completed":
            excluded["in_progress"] += 1
            continue
        conclusion = r.get("conclusion")
        if conclusion in ("cancelled", "skipped"):
            excluded[conclusion] += 1
            continue
        denominator.append(r)
    denominator.sort(key=lambda r: (r["created_at"], r["id"]))
    return {"denominator": denominator, "excluded": excluded}


def _failing_jobs(jobs) -> list:
    return [{"name": j["name"],
             "steps": [s["name"] for s in j.get("steps", []) if s.get("conclusion") == "failure"]}
            for j in jobs if j.get("conclusion") == "failure"]


def _run_ref(r) -> dict:
    return {"run_id": r["id"], "created_at": r["created_at"], "url": r.get("html_url")}


def compute_flake(denominator, source) -> dict:
    """A flake is a run whose attempt 1 failed and whose re-run succeeded, attributed to the
    attempt-1 failing jobs/steps. A re-run of an already-green run is listed apart. Breakage is a
    run that ended red (fixed by a follow-up push rather than a re-run)."""
    flakes, reruns_of_green, breakage = [], [], []
    for r in denominator:
        final = r.get("conclusion")
        if final == "success" and r.get("run_attempt", 1) > 1:
            first = source.run_attempt(r["id"], 1)
            if first.get("conclusion") != "success":
                flakes.append({**_run_ref(r), "jobs": _failing_jobs(source.run_jobs(r["id"], 1))})
            else:
                reruns_of_green.append(r["id"])
        elif final != "success":
            breakage.append({**_run_ref(r), "jobs": _failing_jobs(source.run_jobs(r["id"]))})
    n = len(denominator)
    return {"rate": (len(flakes) / n) if n else None, "denominator": n, "flakes": flakes,
            "reruns_of_green": reruns_of_green, "breakage": breakage}


def compute_durations(denominator, source) -> dict:
    """Per job name over the latest attempt of every denominator run: every completed job with
    both timestamps counts (failed included — it is wall time the gate spent); skipped and
    unfinished jobs do not. Nearest-rank p50/p90 in whole seconds; the full gate listed first."""
    samples: dict[str, list[int]] = {}
    for r in denominator:
        for j in source.run_jobs(r["id"]):
            if j.get("status") != "completed" or j.get("conclusion") == "skipped":
                continue
            if not j.get("started_at") or not j.get("completed_at"):
                continue
            secs = int((parse_ts(j["completed_at"]) - parse_ts(j["started_at"])).total_seconds())
            samples.setdefault(j["name"], []).append(secs)
    names = sorted(samples, key=lambda n: (n != FULL_GATE_JOB, n))
    return {n: {"n": len(samples[n]), "p50_s": percentile(samples[n], 50),
                "p90_s": percentile(samples[n], 90)} for n in names}


def _release_tags(releases) -> list:
    return sorted((r for r in releases
                   if not r.get("draft") and SEMVER_TAG_RE.match(r.get("tag_name", ""))),
                  key=lambda r: r["created_at"])


def _select_release_run(runs, tag: str):
    """The tag-push run: prefer a successful run, then the latest start."""
    candidates = [r for r in runs if r.get("event") == "push" and r.get("head_branch") == tag]
    if not candidates:
        return None
    candidates.sort(key=lambda r: (r.get("conclusion") == "success", r.get("run_started_at") or ""),
                    reverse=True)
    return candidates[0]


def _seconds(a: datetime | None, b: datetime | None):
    return int((b - a).total_seconds()) if a is not None and b is not None else None


def compute_releases(source) -> dict:
    """Per non-draft v-tag: tag push = release.yml run start; pipeline = run start -> last job
    complete; sign-off = last job -> published_at (the human publishing the draft); lead = run
    start -> published_at; commit -> published from the release's created_at (lightweight tags
    carry no creation time). Smoke = the release-bundle smoke step, n/a where it did not exist."""
    runs = source.release_runs()
    per_tag = []
    for rel in _release_tags(source.releases()):
        commit_at = parse_ts(rel["created_at"])
        published = parse_ts(rel["published_at"]) if rel.get("published_at") else None
        entry = {"tag": rel["tag_name"], "commit_at": fmt_ts(commit_at), "run_id": None,
                 "run_started_at": None, "pipeline_done_at": None,
                 "published_at": fmt_ts(published) if published else None,
                 "pipeline_s": None, "signoff_s": None, "lead_s": None,
                 "commit_to_published_s": _seconds(commit_at, published), "smoke": "n/a"}
        run = _select_release_run(runs, rel["tag_name"])
        if run is not None:
            started = parse_ts(run["run_started_at"])
            jobs = source.run_jobs(run["id"])
            ends = [parse_ts(j["completed_at"]) for j in jobs if j.get("completed_at")]
            done = max(ends) if ends else None
            entry.update({"run_id": run["id"], "run_started_at": fmt_ts(started),
                          "pipeline_done_at": fmt_ts(done) if done else None,
                          "pipeline_s": _seconds(started, done), "signoff_s": _seconds(done, published),
                          "lead_s": _seconds(started, published)})
            for j in jobs:
                for s in j.get("steps", []):
                    if s.get("name", "").startswith(SMOKE_STEP_PREFIX):
                        entry["smoke"] = "pass" if s.get("conclusion") == "success" else "fail"
                        break
                if entry["smoke"] != "n/a":
                    break
        per_tag.append(entry)

    def median(key):
        values = [e[key] for e in per_tag if e[key] is not None]
        return {"n": len(values), "value": percentile(values, 50)}

    smoke = {"pass": sum(e["smoke"] == "pass" for e in per_tag),
             "fail": sum(e["smoke"] == "fail" for e in per_tag),
             "na": sum(e["smoke"] == "n/a" for e in per_tag)}
    return {"per_tag": per_tag, "median_pipeline_s": median("pipeline_s"),
            "median_signoff_s": median("signoff_s"), "median_lead_s": median("lead_s"),
            "median_commit_to_published_s": median("commit_to_published_s"), "smoke": smoke}


def _has_label(issue, name: str) -> bool:
    return any(lbl.get("name") == name for lbl in issue.get("labels", []))


def compute_escaped_defects(releases, issues) -> dict:
    """The issue's literal rule (ESCAPED_RULE); PR items are dropped; the label-coverage caveat
    lists fix/bug-titled issues that carry no `bug` label."""
    plain = [i for i in issues if "pull_request" not in i]
    bugs = [i for i in plain if _has_label(i, "bug")]
    per_tag, attributed = [], set()
    for rel in _release_tags(releases):
        start = parse_ts(rel["created_at"])
        end = start + ESCAPED_WINDOW
        hits = sorted(i["number"] for i in bugs if start <= parse_ts(i["created_at"]) <= end)
        per_tag.append({"tag": rel["tag_name"], "window_start": fmt_ts(start), "window_end": fmt_ts(end),
                        "issues": hits, "count": len(hits)})
        attributed.update(hits)
    return {
        "rule": ESCAPED_RULE,
        "per_tag": per_tag,
        "attributions": sum(t["count"] for t in per_tag),
        "distinct": len(attributed),
        "outside_any_window": sorted(i["number"] for i in bugs if i["number"] not in attributed),
        "label_coverage": {"fix_titled_unlabelled": sorted(
            i["number"] for i in plain
            if FIX_TITLE_RE.match(i.get("title", "")) and not _has_label(i, "bug"))},
    }


def analyze_ci(source, repo: str, since: datetime, until: datetime) -> dict:
    window = ci_window(source.ci_runs(since.strftime("%Y-%m-%d")), since)
    flake = compute_flake(window["denominator"], source)
    flake["excluded"] = window["excluded"]
    return {
        "schema": CI_SCHEMA,
        "generated_at": fmt_ts(until),
        "repo": repo,
        "window": {"since": since.strftime("%Y-%m-%d"), "until": fmt_ts(until), "source": source.kind},
        "flake": flake,
        "duration": compute_durations(window["denominator"], source),
        "releases": compute_releases(source),
        "escaped_defects": compute_escaped_defects(source.releases(), source.issues()),
    }


def _dur(seconds) -> str:
    if seconds is None:
        return "—"
    s = int(seconds)
    if s >= 3600:
        return f"{s // 3600} h {(s % 3600) // 60:02d} m"
    if s >= 60:
        return f"{s // 60} m {s % 60:02d} s"
    return f"{s} s"


def _pct_or_na(rate) -> str:
    return "n/a" if rate is None else f"{100.0 * rate:.1f} %"


def _jobs_cell(jobs) -> str:
    return "; ".join(f"{j['name']}: {', '.join(j['steps']) or '(no failing step)'}" for j in jobs) or "—"


def render_ci_markdown(s: dict) -> str:
    L = []
    f, d, r, e = s["flake"], s["duration"], s["releases"], s["escaped_defects"]
    w = s["window"]
    L.append("# CI statistics (repo-stats --ci)")
    L.append("")
    L.append(f"Generated {s['generated_at']} for `{s['repo']}` — window since {w['since']} "
             f"(source: {w['source']}). A measurement, not a gate (trmx-265).")
    L.append("")
    L.append("## Window")
    L.append("")
    L.append("| Metric | Value |")
    L.append("|---|---:|")
    L.append(f"| Push-to-main `ci.yml` runs in the window (denominator) | {f['denominator']} |")
    ex = f["excluded"]
    L.append(f"| Excluded — cancelled / in progress / skipped | {ex['cancelled']} / {ex['in_progress']} / {ex['skipped']} |")
    L.append("")
    L.append("## Flake rate")
    L.append("")
    L.append(f"**{_pct_or_na(f['rate'])}** — {len(f['flakes'])} re-run-to-green of {f['denominator']} completed runs "
             "(a run whose attempt 1 failed and whose re-run succeeded).")
    L.append("")
    L.append("| Run | Created | Failing job: steps (attempt 1) |")
    L.append("|---|---|---|")
    for x in f["flakes"]:
        L.append(f"| [{x['run_id']}]({x['url']}) | {x['created_at']} | {_jobs_cell(x['jobs'])} |")
    if not f["flakes"]:
        L.append("| — | — | no flakes in the window |")
    L.append("")
    L.append("Re-runs of an already-green run (not flakes): "
             + (", ".join(str(i) for i in f["reruns_of_green"]) or "none") + ".")
    L.append("")
    L.append(f"Breakage — {len(f['breakage'])} run(s) that ended red and were fixed by a follow-up push, not a re-run "
             "(not flakes; shown so a low flake rate is not read as a green main):")
    L.append("")
    L.append("| Run | Created | Failing job: steps |")
    L.append("|---|---|---|")
    for x in f["breakage"]:
        L.append(f"| [{x['run_id']}]({x['url']}) | {x['created_at']} | {_jobs_cell(x['jobs'])} |")
    if not f["breakage"]:
        L.append("| — | — | none |")
    L.append("")
    L.append("## Duration")
    L.append("")
    L.append("Per job over the latest attempt of every denominator run; every completed job counts "
             "(failed included), skipped and unfinished jobs do not. Nearest-rank percentiles.")
    L.append("")
    L.append("| Job | n | p50 | p90 |")
    L.append("|---|---:|---:|---:|")
    for name, v in d.items():
        L.append(f"| {name} | {v['n']} | {_dur(v['p50_s'])} | {_dur(v['p90_s'])} |")
    if not d:
        L.append("| — | 0 | — | — |")
    L.append("")
    L.append("## Releases")
    L.append("")
    L.append("Tag push = `release.yml` run start; pipeline = run start → last job complete; sign-off = last job → "
             "published (the human publishing the draft); lead = run start → published. Commit → published uses "
             "the release's commit date (tags are lightweight and carry no creation time).")
    L.append("")
    L.append("| Tag | Commit | Run start | Pipeline | Sign-off | Lead | Commit → published | Smoke |")
    L.append("|---|---|---|---:|---:|---:|---:|---|")
    for t in r["per_tag"]:
        L.append(f"| {t['tag']} | {t['commit_at']} | {t['run_started_at'] or '—'} | {_dur(t['pipeline_s'])} "
                 f"| {_dur(t['signoff_s'])} | {_dur(t['lead_s'])} | {_dur(t['commit_to_published_s'])} | {t['smoke']} |")
    if not r["per_tag"]:
        L.append("| — | | | | | | | |")
    L.append("")

    def med(key, label):
        m = r[key]
        return f"{label} {_dur(m['value'])} (n = {m['n']})"

    L.append("Medians (nearest-rank): " + med("median_pipeline_s", "pipeline") + " · "
             + med("median_signoff_s", "sign-off") + " · " + med("median_lead_s", "lead") + " · "
             + med("median_commit_to_published_s", "commit → published") + ".")
    sm = r["smoke"]
    L.append(f"Release-bundle smoke: {sm['pass']} pass / {sm['fail']} fail / {sm['na']} n/a "
             "(n/a = the smoke step did not exist for that release).")
    L.append("")
    L.append("## Escaped defects")
    L.append("")
    L.append(f"Rule: {e['rule']}.")
    L.append("")
    L.append("| Tag | Window end | Issues | Count |")
    L.append("|---|---|---|---:|")
    for t in e["per_tag"]:
        L.append(f"| {t['tag']} | {t['window_end']} | {', '.join('#' + str(n) for n in t['issues']) or '—'} | {t['count']} |")
    if not e["per_tag"]:
        L.append("| — | | | 0 |")
    L.append("")
    L.append(f"{e['attributions']} attribution(s) of {e['distinct']} distinct issue(s). "
             f"Bug-labelled issues outside every window: "
             + (", ".join("#" + str(n) for n in e["outside_any_window"]) or "none") + ".")
    unl = e["label_coverage"]["fix_titled_unlabelled"]
    L.append("Label coverage caveat — fix/bug-titled issues without the `bug` label (invisible to this metric): "
             + (", ".join("#" + str(n) for n in unl) or "none") + ".")
    L.append("")
    return "\n".join(L)


def ci_json(s: dict) -> str:
    return json.dumps(s, indent=2) + "\n"


def _main_ci(args, root: Path, out_dir: Path) -> int:
    if args.format != "both":
        print("repo-stats: --format is ignored under --ci (Markdown + JSON are always written)", file=sys.stderr)
    now = datetime.now(timezone.utc).replace(microsecond=0)
    if args.since:
        try:
            since = datetime.strptime(args.since, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            print(f"repo-stats: --since expects YYYY-MM-DD, got {args.since!r}", file=sys.stderr)
            return 2
    else:
        since = (now - timedelta(days=90)).replace(hour=0, minute=0, second=0)
    repo = resolve_repo(args.repo, os.environ, _git_remote_url(root))
    if not repo:
        print("repo-stats: cannot determine the repository — pass --repo owner/name", file=sys.stderr)
        return 2
    source = FixtureSource(args.ci_fixtures) if args.ci_fixtures else GhSource(repo)
    stats = analyze_ci(source, repo, since, now)
    md = render_ci_markdown(stats)
    (out_dir / "ci-stats.md").write_text(md, encoding="utf-8")
    (out_dir / "ci-stats.json").write_text(ci_json(stats), encoding="utf-8")
    print(md, end="" if md.endswith("\n") else "\n")
    print(f"repo-stats --ci: wrote {out_dir / 'ci-stats.md'} and {out_dir / 'ci-stats.json'}", file=sys.stderr)
    return 0


def main(argv: list[str] | None = None) -> int:
    default_root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(prog="repo-stats", description=__doc__.splitlines()[0])
    ap.add_argument("root", nargs="?", default=str(default_root),
                    help="repo root (default: parent of scripts/)")
    ap.add_argument("--out", default=None,
                    help="output directory (default: <root>/reports/repo-stats)")
    ap.add_argument("--format", choices=("both", "md", "html"), default="both")
    ap.add_argument("--ci", action="store_true",
                    help="CI statistics mode (trmx-265): flake rate, gate duration, release lead time, "
                         "escaped defects — writes ci-stats.md + ci-stats.json instead of the codebase report")
    ap.add_argument("--since", default=None, metavar="YYYY-MM-DD",
                    help="--ci: window start (default: 90 days ago, UTC)")
    ap.add_argument("--repo", default=None, metavar="OWNER/NAME",
                    help="--ci: repository (default: $GITHUB_REPOSITORY, else the origin remote)")
    ap.add_argument("--ci-fixtures", default=None, metavar="DIR",
                    help="--ci: replay recorded API pages from DIR instead of calling gh (offline)")
    args = ap.parse_args(argv)

    root = Path(args.root).resolve()
    out_dir = Path(args.out) if args.out else root / "reports" / "repo-stats"
    out_dir.mkdir(parents=True, exist_ok=True)
    if args.ci:
        return _main_ci(args, root, out_dir)

    stats = analyze(root)
    written = []
    if args.format in ("both", "md"):
        p = out_dir / "repo-stats.md"
        p.write_text(render_markdown(stats), encoding="utf-8")
        written.append(p)
    if args.format in ("both", "html"):
        p = out_dir / "repo-stats.html"
        p.write_text(render_html(stats), encoding="utf-8")
        written.append(p)

    total_cases = sum(stats["test_cases"].values())
    print(f"repo-stats: {stats['total_files']} files, {stats['total_lines']:,} lines "
          f"({stats['prod_lines']:,} prod / {stats['test_lines']:,} test code lines), "
          f"{total_cases} test cases @ {stats['commit']}")
    for p in written:
        print(f"  wrote {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
