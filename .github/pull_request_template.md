## Summary

<!-- 1–3 bullets: what changed and why. -->

## Closes

Closes #<N>

## Test plan

<!-- The gates you ran (cargo test …, pnpm --filter app test, a packaged --smoke if relevant). -->

## Checklist

- [ ] Traces to a GitHub issue: `trmx-<N>` in the branch, the PR title, and `Closes #<N>` above (R9).
- [ ] Every behavioral change ships with a covering test, written first (R8).
- [ ] **If this PR adds a claim about enforcement, it adds the enforcement.** A doc, rule or comment
      saying something *is checked* ships with the check — otherwise write it as an intention
      ("should"), not a fact. See
      [Claims and gates](../docs/CONTRIBUTING.md#claims-and-gates-trmx-239) (trmx-239).
- [ ] Commit type chosen deliberately — it decides what reaches `CHANGELOG.md` (R10).
