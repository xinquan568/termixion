# Architecture rules

See **[`architecture.md`](architecture.md)** for the load-bearing invariants (R1–R7) and which are
machine-enforced. The git hooks in [`../hooks/`](../hooks/) (install: `scripts/install-hooks.sh`) run
the fast checks locally; CI (E-1) mirrors every load-bearing check.
