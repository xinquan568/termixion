# Architecture rules

See **[`architecture.md`](architecture.md)** for the load-bearing invariants (R1–R10 — including **R8,
test-driven development**, **R9, every change traces to a GitHub issue / `trmx-N`**, and **R10, a curated
user-facing changelog**) and which are machine-enforced. The git hooks in [`../hooks/`](../hooks/)
(install: `scripts/install-hooks.sh`) run the fast checks locally; CI (E-1) mirrors every load-bearing
check.
