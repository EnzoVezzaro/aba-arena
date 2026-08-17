# refactor.md — Refactor a Functionality

A reproducible procedure for restructuring code without changing behavior.

## Steps

1. **Read the contract.** Start from the target directory's `AGENTS.md` —
   purpose and constraints define what the refactor must preserve.

2. **Map the current shape.** Run `acc graph <dir>` and `acc context <dir>`
   to see declared dependencies and the focused context before you move code.

3. **Refactor in small steps.** Keep each commit behavior-preserving and
   verifiable; update the contract whenever ownership, dependencies, or
   boundaries change.

4. **Validate.** Run `acc check` (no broken references, no orphaned code) and
   the project's tests/build after each step.

5. **Record durable knowledge.** Run
   `acc memory add <dir> "<what moved and why>"` so future agents understand
   the new shape without re-deriving it.
