# src

## Purpose

The ABA backend: a Node HTTP server that imports a repository into two isolated sandboxes, prepares one with ACC (`acc init` → `acc build` → `acc fill` → `acc graph` → `acc context`) and leaves the other plain, installs the coding-agent harness inside both, and streams benchmark battles (`POST /api/agent/run`) to the web UI.

## Responsibilities

- Import a repository (local path, GitHub URL, connected-GitHub repo, or a local folder) into isolated snapshots — the original repository is never modified (`importer.cjs`).
- Create and manage the two per-battle sandbox copies (`acc` and `plain`) and the harness installed in each (`server.cjs`).
- Run the ACC onboarding pipeline on the ACC sandbox only; produce the plain `baseContext` and the ACC `accContext` for the harness prompt.
- Expose the HTTP API: health, repo load, ACC pipeline steps, sandbox file API, model-list proxy, GitHub OAuth, Freebuff status, battle deletion, agent run (NDJSON event stream), report persistence.
- Spawn the in-sandbox coding agent (`harness.cjs`) with the panel's provider/model/key and stream its events (delta, reasoning, cmd, out, verify, done, error) back to the browser, with a hard timeout and disconnect kill.
- Provide the headless CLI path: argument parsing, battle config, Docker/local sandbox backends, result collection and diff reports (`cli.cjs`, `sandbox.cjs`, `results.cjs`, `index.cjs`).

## Ownership

Owned by the root contract (Owner: aba — published as `acc-battle-arena`, git remote EnzoVezzaro/aba-arena).

## Inputs

- A repository source: local path or GitHub URL (optionally a connected GitHub account's repo, with a token for private access).
- Provider config and API keys from the browser (per-run, keyed providers; public endpoints fetched without a key).
- `.env` at the repo root: `ABA_PORT`, `ABA_GITHUB_CLIENT_ID`/`ABA_GITHUB_CLIENT_SECRET`, `ABA_FREEBUFF_TOKENS`/`ABA_FREEBUFF_AUTOSTART` (optional).
- `ui/node_modules` — the Vercel AI SDK + provider adapters the harness resolves at runtime via `NODE_PATH`.

## Outputs

- Terminal prose and JSON for every API route.
- The agent-harness NDJSON event stream (`POST /api/agent/run`).
- Battle sandboxes under `~/.aba-sandbox/battles/{battleId}/acc` and `.../plain` (with `.aba-agent.cjs` installed in each).
- Saved battle reports (`~/.aba-sandbox/reports/battle-{id}.json`).
- Imported snapshots under `~/.aba-sandbox/snapshots` and `repos`.

## Dependencies

- `acc-agents` (the ACC CLI, npm dependency) — builds the ACC panel's context.
- The Vercel AI SDK + provider adapters (`ai` and the `@ai-sdk` packages in `ui/node_modules`) — drive the harness that runs inside the sandboxes.
- `dockerode` (optional) — Docker-backed sandbox backend; falls back to the local host.
- The ACC specification itself — the behavior this benchmark measures.

## Constraints

- The original repository is never modified — agents only ever touch sandbox copies.
- Provider keys go to the local server for the duration of a run only; nothing is uploaded or sent anywhere but the configured provider endpoint (offline-first).
- No arbitrary code execution outside the sandboxes: repo loading copies files, the ACC pipeline is the `acc` CLI, and the harness runs inside the sandbox cwd with lexically confined paths.
- A battle can be stopped or deleted at any time; its sandboxes must be cleaned up (no zombies, no leaked processes).
- The harness is model-driven: the model chooses its own tools. Models that cannot handle the multi-tool round trip (e.g. NVIDIA `meta/llama-*instruct`) must not be offered.

## Architecture

```
index.cjs      entry point (bin: aba) — CLI + server launcher
cli.cjs        argument parsing, battle config (headless)
importer.cjs   project import → isolated snapshots
sandbox.cjs    Docker / local-host sandbox backends (headless)
results.cjs    result collection, diff reports (headless)
harness.cjs    the coding agent copied into each sandbox:
               AI SDK + custom base URL, plan/act modes,
               "start the project" verify
server.cjs     HTTP API: repo import, ACC pipeline, harness install
               + /api/agent/run NDJSON streaming, sandbox file API,
               model-list proxy, GitHub OAuth, Freebuff status
```

Data flow: browser → `/api/repo` (NDJSON: streams one line per setup phase) → snapshots → two sandbox copies → ACC pipeline on the `acc` copy (acc init/build/fill once, at load — the arena shows this as live setup progress) → harness installed in both → `/api/agent/run` spawns the harness in the requested panel's sandbox with the panel's provider/model/key → NDJSON events stream back to the browser's sandbox-terminal Answer panel. The ACC sandbox is configured exactly once, during repo load — the battle itself runs the user's tasks on the two ready sandboxes directly.

## Workflows

- See `.acc/config/workflows/feature.md` for the standard feature workflow.
- See `.acc/config/workflows/diagnostic.md` when adding a diagnostic code.
- See `.acc/config/workflows/release.md` for the release checklist.
