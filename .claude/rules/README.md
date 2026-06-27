# Architecture rules

See **[`architecture.md`](architecture.md)** for the load-bearing invariants (R1–R8 — including **R8,
test-driven development**) and which are machine-enforced. The git hooks in [`../hooks/`](../hooks/)
(install: `scripts/install-hooks.sh`) run the fast checks locally; CI (E-1) mirrors every load-bearing
check.
