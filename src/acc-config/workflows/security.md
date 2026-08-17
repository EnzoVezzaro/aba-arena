# security.md — Security Review

A reproducible procedure for reviewing a functionality for security issues.

## Steps

1. **Scope.** Identify the boundary under review and read its `AGENTS.md`
   (what it owns, what it depends on, what invariants it declares).

2. **Trace the inputs.** Follow the boundary's declared inputs to their
   sinks — filesystem, network, shell, database, rendering.

3. **Check the checklist.**
   - [ ] Input validation and output encoding at every boundary.
   - [ ] Secrets never reach the repository or the `.acc-memory.md` log.
   - [ ] No dependency is declared that is not actually used.
   - [ ] Failures are handled without leaking internal state.

4. **Record findings.** Run
   `acc memory add <dir> "<finding + remediation>"` — the durable log is the
   right place for the review outcome.
