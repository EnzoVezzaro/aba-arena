# feature.md — Add a New Functionality

A reproducible procedure for adding a new functionality boundary to an
ACC-enhanced project.

## Steps

1. **Isolate the functionality.** Identify the directory that will own the
   new functionality boundary. A functionality is a directory containing an
   `AGENTS.md`.

2. **Read the parent context.** Read the nearest ancestor `AGENTS.md` to
   understand the inheritable context (purpose, constraints, dependencies).

3. **Draft the local contract.** Run `acc document <dir>` for a conservative
   template (stdout), then `acc document <dir> --apply` to write it. Review,
   edit, and commit `<dir>/AGENTS.md` — declare purpose, ownership,
   dependencies, and constraints based on the actual code.

4. **Implement the functionality.** Write the code under `<dir>`.

5. **Validate.** Run `acc check` (broken references, duplicate ownership,
   orphaned code), `acc graph` (relationships match intent), and
   `acc context <dir>` to review the agent-facing context. Fix any
   `error`-level diagnostics before merging.

6. **Record durable knowledge.** Run `acc memory add <dir> "<lesson>"` so
   future agents inherit what you learned instead of rediscovering it.
