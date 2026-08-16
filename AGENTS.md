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

- Import a repository (local path or GitHub URL) into isolated snapshots —
  the original repository is never modified.
- Build the two panel contexts: the plain `baseContext` and the ACC context
  produced by the `acc` CLI pipeline (`acc init` → `acc build` → `acc fill`
  → `acc graph` → `acc context`).
- Provide sandboxed work areas (Docker container, falling back to the local
  host) where benchmark agents can read and edit files.
- Guarantee panel isolation: each agent sees only its own sandbox copy of the
  repo (no `.git`, no `node_modules`, no sibling battle dirs, no host paths),
  sandbox copies never contain symlinks, the file API confines every path both
  lexically and by real path, and commands run in a sandbox get a scrubbed env
  (never the server's `process.env`).
- Stream agent output in real time from the browser (Vercel AI SDK) — provider
  API keys never leave the browser and never touch the ABA backend.
- Collect results, per-metric winners, success heuristics, and persist battle
  history locally (localStorage) and reports (JSON on the server).
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

- Terminal prose and JSON for every server API route.
- The battle-arena web app (`aba/ui`, built to `ui/dist`).
- Saved battle reports (`~/.aba-sandbox/reports/battle-<id>.json`).
- Local battle history (`aba.history.v1` in the browser).

## Dependencies

- acc-agents (the ACC CLI, resolved via npm/npx) — used to build the ACC
  panel's context.
- The Vercel AI SDK + provider adapters (ai and the @ai-sdk/* packages) —
  browser-side LLM streaming.
- React + Vite for the UI; Docker (optional) for the sandbox backend.
- The ACC specification itself — the behavior this benchmark measures.

## Constraints

- MUST NOT be part of the ACC framework — standalone tool, own entry point,
  own lifecycle, own license (MIT, with FSL-1.1-MIT for the isbetter.ai-derived
  arena UI).
- MUST NOT modify the original repository — always work on an isolated snapshot.
- MUST NOT execute arbitrary code from the benchmarked repository (untrusted
  repo safety): agent tools are file read/write only, confined to the panel's
  sandbox copy.
- MUST keep sandboxes fully isolated from each other and from the host: no
  leakage between panels (shared state, absolute paths, or the other panel's
  files in any context) and no way for one sandbox to read or modify another.
- MUST NOT send provider keys or repository contents through the ABA backend —
  LLM calls happen in the browser, keys stay in the browser.
- MUST NOT hang forever on a blocked or silent provider — panels race against
  hard and idle timeouts and fail with a clear message instead.
- Blind mode MUST hide which panel runs ACC (aliases, styling, winners,
  timeline, summary, file explorers) until explicitly revealed.

## Architecture

The project is a set of functionality boundaries, each with its own contract.

1. Entry point — `index.cjs` (CLI + server launcher).
2. CLI layer — `cli.cjs` (argument parsing, battle config).
3. Import layer — `importer.cjs` (project import, isolated snapshots).
4. Sandbox layer — `sandbox.cjs` (Docker / local-host sandbox backends).
5. Results layer — `results.cjs` (result collection, diff reports).
6. Server layer — `server.cjs` (HTTP API: repo import, context building,
   sandbox file tree/read/write, reports, battle deletion).
7. UI layer — `aba/ui/` (React + Vite arena: config page, battle page,
   code explorer, timeline, history).

## Workflows

- See `.acc/config/workflows/feature.md` for adding a new feature.
- See `.acc/config/workflows/release.md` for the release checklist.
