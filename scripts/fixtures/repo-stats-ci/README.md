# repo-stats `--ci` fixtures (trmx-265)

Recorded GitHub REST payloads for `scripts/repo-stats.test.py`. The tests never call `gh`; they replay
these files through `FixtureSource`, which decodes them with the same `decode_pages` the live `GhSource`
uses — so every file holds **exactly what `gh api --paginate --slurp <endpoint>` returns**: a JSON array
of pages (an envelope with `workflow_runs`/`jobs`, a bare array, or a one-element array holding a run
object for an attempt).

## Provenance

Captured on 2026-09-04 from `xinquan568/termixion` (endpoints as built by `repo-stats.py`), then
**sanitized** to the fields the script reads (ids, names, states, timestamps, `html_url`; no actors,
avatars or API URLs) and **trimmed** to a handful of real rows. `expected-ci-stats.json` is the report
the script produces from this directory with `--since 2026-07-01` (clock fields normalised by the test);
every number in it was derived by hand from these files before the golden was written.

| File | Endpoint | Real rows |
|---|---|---|
| `ci-runs.json` | `actions/workflows/ci.yml/runs?branch=main&event=push` | `33266632239` (re-run to green after *pnpm test (vitest)* failed), `32962880655` (re-run to green after *cargo test* failed), `33817224013` (plain success), `33248793732` (ended red at vitest, never re-run) |
| `attempts/<id>-1.json` | `actions/runs/<id>/attempts/1` | the two real flakes |
| `jobs/<id>-1.json`, `jobs/<id>-latest.json` | `actions/runs/<id>/attempts/1/jobs`, `actions/runs/<id>/jobs` | the four real runs above |
| `releases.json` | `releases` | `v0.0.9`, `v0.1.0`, `v0.1.1`, `v0.1.2` (the only release with the smoke step) |
| `release-runs.json` | `actions/workflows/release.yml/runs` | every run for those tags (v0.0.9 had two failed runs before its successful one) plus the real `workflow_dispatch` run on `main` |
| `jobs/<release-run>-latest.json` | `actions/runs/<id>/jobs` | the successful run of each real tag |
| `issues.json` | `issues?state=all` (two pages) | `#145`, `#180` (bug-labelled, inside a window), `#37`, `#291` (bug-labelled, outside every window), `#148` (`fix:`-titled, no label) |

## Synthetic witness rows (documented, placeholder host `github.com/x/y`)

Real history has no witness for some branches of the definitions, so these rows are added:

- runs `3` (re-run of an already-green run — not a flake), `5` (cancelled), `6` (in progress), `7`
  (`pull_request` event on a feature branch — dropped by provenance), `8` (a skipped job and an
  unfinished job — no duration sample), `9` (created 2026-06-20: outside `--since 2026-07-01`, inside the
  default 90-day window the scheduled run uses);
- release-run `103`: a failed v0.0.9 run **later** than the successful one (the successful run must
  still be preferred); release `v9.9.9` (draft) and tag `nightly` (not semver) — both excluded;
- issue `#150`: created exactly at `v0.0.9 + 7 days` (the window end is inclusive; it also falls in
  `v0.1.0`'s window, so one issue is attributed to two overlapping windows); `#160`: a pull-request
  item labelled `bug` (ignored).

Regenerate with the run's `make-fixtures-v2.py` (kept with the run's evidence, not in the repo — it
reads the unsanitized recordings).
