# tooling.md — Change Tooling or Dependencies

A reproducible procedure for adding, upgrading, or removing tooling and
dependencies.

## Steps

1. **Read the affected contracts.** Tooling changes often cross boundaries —
   read the root `AGENTS.md` and every boundary that declares the tool as a
   dependency.

2. **Check declared dependencies.** Run `acc check` before the change to
   capture the baseline, and `acc graph --format json` to see which
   boundaries declare the tool.

3. **Make the change.** Update the dependency and the declaring `AGENTS.md`
   sections together — the contract must never name a dependency the project
   no longer uses.

4. **Validate.** Run `acc check` (no broken references) and the project's
   build/tests.

5. **Record durable knowledge.** Run
   `acc memory add <dir> "<why the tooling changed>"` in the affected
   boundaries.
