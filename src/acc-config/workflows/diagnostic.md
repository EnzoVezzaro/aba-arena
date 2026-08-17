# diagnostic.md — Diagnose a Problem

A reproducible procedure for investigating a failure in an ACC-enhanced
project.

## Steps

1. **Identify the boundary.** Which directory's `AGENTS.md` covers the
   failing behavior? Start from its contract.

2. **Gather the focused context.** Run `acc context <dir>` to get the
   boundary's declared context, then read the relevant source under `<dir>`.

3. **Follow dependencies.** Use `acc graph <dir>` and `acc dependencies <dir>`
   to trace declared dependencies — the failure may live upstream of the
   reported boundary.

4. **Check the memory log.** Read `<dir>/.acc-memory.md` — earlier agents may
   already have recorded the gotcha.

5. **Record the outcome.** Once root-caused, run
   `acc memory add <dir> "<root cause>"` so the diagnosis is never repeated.
