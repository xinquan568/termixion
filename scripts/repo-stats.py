#!/usr/bin/env python3
# SPDX-License-Identifier: ISC
"""repo-stats (trmx-213): codebase statistics over git-tracked files.

Emits a Markdown and a self-contained HTML report covering file/line totals,
production-vs-test breakdown (including Rust inline #[cfg(test)] blocks),
per-language lines, test-case counts, and file size / line-count extremes.

Usage: python3 scripts/repo-stats.py [repo-root] [--out DIR] [--format both|md|html]
Defaults: repo-root = parent of scripts/, out = <root>/reports/repo-stats (git-ignored).
Stdlib only; requires `git` on PATH.
"""

from __future__ import annotations

import argparse
import html as html_mod
import re
import subprocess
import sys
from datetime import datetime
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


def main(argv: list[str] | None = None) -> int:
    default_root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(prog="repo-stats", description=__doc__.splitlines()[0])
    ap.add_argument("root", nargs="?", default=str(default_root),
                    help="repo root (default: parent of scripts/)")
    ap.add_argument("--out", default=None,
                    help="output directory (default: <root>/reports/repo-stats)")
    ap.add_argument("--format", choices=("both", "md", "html"), default="both")
    args = ap.parse_args(argv)

    root = Path(args.root).resolve()
    out_dir = Path(args.out) if args.out else root / "reports" / "repo-stats"
    out_dir.mkdir(parents=True, exist_ok=True)

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
