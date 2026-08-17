# bugfix.md — Fix a Bug

A reproducible procedure for fixing a bug inside an ACC-enhanced project.

## Steps

1. **Locate the functionality.** Find the directory whose `AGENTS.md` covers
   the failing behavior — read the contract first, it declares the intent.

2. **Reproduce.** Write the smallest failing case you can and confirm it
   fails on the current revision.

3. **Read the local contract.** Re-read `<dir>/AGENTS.md` for constraints and
   dependencies before touching code; the contract is the source of truth for
   intent.

4. **Fix and verify.** Make the minimal change, re-run the failing case, and
   run the project's own tests/build.

5. **Validate.** Run `acc check` to confirm no diagnostics regressed, and
   `acc impact <dir>` to spot dependents your change may affect.

6. **Record durable knowledge.** Run
   `acc memory add <dir> "<root cause + fix summary>"` so the next agent does
   not repeat the investigation.
