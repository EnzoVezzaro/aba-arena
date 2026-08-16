# ABA — ACC Battle Arena

## Purpose

ABA answers one question: **does the ACC framework help an AI agent work with
a repository better than no ACC at all?** It runs the same repository and the
same task series on two isolated sandboxes side by side — one prepared with
ACC (AGENTS.md contracts + `acc context`), one plain — and streams the results
in a local Vite web app, with provider/model choice per panel, per-metric
winners, blind mode, and battle history.

ABA is a **standalone benchmark application**, not part of the ACC framework.
The framework never requires it and works without it; ABA lives in this
directory so the repository stays a single place to develop both.

## Responsibilities

- Import a repository (local path, GitHub URL, connected-GitHub repo, or a
  local folder) into isolated snapshots — the original repository is never
  modified.
- Build the two panel contexts: the plain `baseContext` and the ACC context
  produced by the `acc` CLI pipeline (`acc init` → `acc build` → `acc fill`
  → `acc graph` → `acc context`). The acc CLI comes from the npm-installed
  `acc-agents` package (latest at publish time).
- Provide sandboxed work areas (Docker container, falling back to the local
  host) where benchmark agents can read and edit files.
- Run the coding-agent harness (`harness.cjs`) INSIDE each panel sandbox,
  driven by the Vercel AI SDK with a custom base URL (the same provider
  config the UI uses): plan tasks produce a plan only; act tasks edit the
  code and then verify the project still runs ("start the project").
- Guarantee panel isolation: each agent sees only its own sandbox copy of the
  repo (no `.git`, no `node_modules`, no sibling battle dirs, no host paths),
  sandbox copies never contain symlinks, the file API confines every path both
  lexically and by real path, and commands run in a sandbox get a scrubbed env
  (never the server's `process.env`).
- Stream the agent's live work to the Answer panel as a sandbox terminal
  (commands, tool results, reasoning) and collect results, per-metric
  winners, success heuristics, agent steps, and the verified flag; persist
  battle history locally (localStorage) and reports (JSON on the server).
- Stay honest: blind mode shuffles panel aliases so a battle can be judged
  without knowing which side runs ACC; a blocked or silent provider must time
  out and move on, never hang the battle.

## Ownership

Owner: aba

> Standalone tool: published as `acc-battle-arena`, git remote
> EnzoVezzaro/aba-arena. In this repository it lives in the `aba/`
> subdirectory as a self-contained project.

## Inputs

- Repository filesystem or GitHub URL (via the importer).
- Optional `.acc/config/config.yaml` (sensible defaults when absent).
- Provider API keys — stored in the user's browser (localStorage) only.
- The benchmark series definition (default tasks in `ui/src/tasks.js`).

## Outputs

- Terminal prose and JSON for every server API route (health, repo load,
  ACC pipeline steps, sandbox file API, model-list proxy, GitHub OAuth,
  Freebuff status, battle deletion).
- The agent-harness NDJSON event stream (`POST /api/agent/run`): deltas,
  reasoning, terminal cmd/out, verify, done, error.
- The battle-arena web app (`ui/`, built to `ui/dist`).
- Saved battle reports (`~/.aba-sandbox/reports/battle-{id}.json`).
- Local battle history (`aba.history.v1` in the browser).

## Dependencies

- acc-agents (the ACC CLI, npm dependency) — used to build the ACC panel's
  context.
- The Vercel AI SDK + provider adapters (ai and the @ai-sdk/* packages) —
  used by the harness that runs inside the sandboxes (server-side, resolved
  from the UI's node_modules via NODE_PATH).
- React + Vite for the UI; Docker (optional) for the headless sandbox backend.
- The ACC specification itself — the behavior this benchmark measures.

## Constraints

- MUST NOT be part of the ACC framework — standalone tool, own entry point,
  own lifecycle, own license (MIT, with FSL-1.1-MIT for the isbetter.ai-derived
  arena UI).
- MUST NOT modify the original repository — always work on an isolated snapshot.
- MUST NOT execute arbitrary code from the benchmarked repository (untrusted
  repo safety): the harness's tools are confined to the panel's sandbox copy
  (lexical + real-path confinement, scrubbed env, no host paths).
- MUST keep sandboxes fully isolated from each other and from the host: no
  leakage between panels (shared state, absolute paths, or the other panel's
  files in any context) and no way for one sandbox to read or modify another.
- MUST NOT send provider keys or repository contents anywhere except the
  chosen provider: keyed providers send the key server-side for the duration
  of a run (the harness needs it in the sandbox); the Freebuff proxy is the
  user's own local process and is NEVER auto-started by ABA.
- MUST NOT hang forever on a blocked or silent provider — panels race against
  hard and idle timeouts and fail with a clear message instead.
- Blind mode MUST hide which panel runs ACC (aliases, styling, winners,
  timeline, summary, file explorers) until explicitly revealed.

## Architecture

The project is a set of functionality boundaries, each with its own contract.

1. Backend (`src/`) — all Node server code, one directory:
   - `index.cjs` — entry point (CLI + server launcher; package `bin`).
   - `cli.cjs` — argument parsing, battle config.
   - `importer.cjs` — project import, isolated snapshots.
   - `sandbox.cjs` — Docker / local-host sandbox backends (headless).
   - `results.cjs` — result collection, diff reports (headless).
   - `harness.cjs` — the coding agent copied into each sandbox: AI SDK +
     custom base URL, plan/act modes, "start the project" verify.
   - `server.cjs` — HTTP API: repo import, ACC pipeline, harness install +
     `/api/agent/run` NDJSON streaming, sandbox file API, model-list proxy,
     GitHub OAuth, Freebuff status.
2. UI layer — `ui/` (React + Vite arena: config page, battle page with the
   sandbox-terminal Answer panel, code explorer, timeline, history).
3. Optional Freebuff proxy — `freebuff/` (vendored Freebuff2API; configured,
   never auto-run).
4. Control plane — `.acc/` (config + workflows) and `AGENTS.md` at the root.

## Workflows

- See `.acc/config/workflows/feature.md` for adding a new feature.
- See `.acc/config/workflows/release.md` for the release checklist.
