# ABA — ACC Battle Arena

ABA is a **standalone benchmark application** used to test and evaluate the
[ACC framework](https://github.com/EnzoVezzaro/agents-code-context).

> **ABA is not part of the ACC framework.** The framework never requires it
> and works without it. ABA lives in this directory so the repository stays
> a single place to develop both, but it is an independent tool with its own
> entry point, dependencies, and lifecycle.

## What it does

ABA answers one question: **does the ACC framework help an AI agent work with
a repository better than no ACC at all?**

By default it spawns a local **Vite web app** (the battle arena) in your
browser:

- Two panels run the **same repo + same task series** side by side — one with
  the ACC  framework installed (AGENTS.md contracts + `acc context` derived
  via the npm-installed `acc-agents` package), one with a plain
  repository.
- **Provider and model are chosen per panel** (OpenAI, Anthropic, Google,
  OpenRouter, Groq, DeepSeek, Mistral, xAI, Cerebras, or a local Ollama /
  LM Studio endpoint). Keys live in your browser only — LLM calls never
  touch the ABA backend.
- Results **stream in real time**: output, time-to-first-token, generation
  time, throughput, tokens, estimated cost, and a transparent success
  heuristic, with per-metric "best" highlights, blind mode (judge without
  knowing which panel has ACC), answer/code views, and local battle history.
- You can **change the repository at any time** and load it into the battle.

The original repository is never modified — ABA always works on an isolated
snapshot. Docker is optional for the headless sandbox: when available,
benchmarks run in a container; otherwise (or with `--local`) on the host.

## Usage

From inside this repository (run from the repo root):

```bash
# Default — spawn the battle arena web app and open the browser:
node index.cjs
node index.cjs ./my-project      # open the UI with a repo preloaded

# Headless — run a single benchmark from the terminal:
node index.cjs ./my-project --headless --local
```

Installed as a package, run it anywhere:

```bash
# Published npm package (also a dependency of acc-agents):
npx acc-battle-arena
npx acc-battle-arena ./my-project

# Via the acc CLI (convenience launcher):
acc battle ./my-project              # opens the arena
acc battle ./my-project --headless   # terminal benchmark
```

| Option | Description |
|--------|-------------|
| `--headless` | Run a single terminal benchmark instead of the web app. |
| `--local` | Headless: run on the host (no Docker). Default: Docker when available, host otherwise. |
| `--network <policy>` | Headless: `disabled` \| `restricted` \| `enabled` (default `restricted`) |
| `--preserve` | Keep the sandbox container/directory after the battle for debugging |
| `--timeout <seconds>` | Benchmark timeout (default `1800`) |
| `--model <model>` | Headless: default model for benchmark agents |
| `--agent <name:model>` | Headless: specify a benchmark agent (repeatable) |

## Development

```bash
# Build the UI (first run builds automatically):
npm run build:ui

# Vite dev server with HMR (proxies /api to the backend on :4317):
npm run dev:ui
```

## Status

Experimental. Docker is optional — benchmarks fall back to the host when
Docker is unavailable. The benchmark agent loop is a placeholder — real
agent harnesses plug in here.

## Credits

ABA's battle arena is adapted from
[**isbetter.ai**](https://github.com/midudev/isbetter.ai) by
[midudev](https://github.com/midudev) (MIT / FSL-1.1-MIT) — an open,
browser-based arena that compares AI models side by side: the same prompt,
streamed answers, live code previews, speed, tokens, and cost, with API keys
that never leave your browser. We use its battle-arena concept, the metric
pill + per-metric winner logic, code extraction helpers, blind mode, and
history pattern in the ABA UI (`ui/src/arena.js` is adapted from it).
Live at [isbetter.ai](https://isbetter.ai/).

Thanks also to the open standards ABA interoperates with:
[agents.md](https://agents.md/), [Agent Skills](https://agentskills.io/),
and [MCP](https://modelcontextprotocol.io/), and to the Vercel
[AI SDK](https://ai-sdk.dev/) for the streaming providers.

## Development

- `cli.cjs` — argument parsing and battle configuration
- `importer.cjs` — project import and isolated snapshots
- `sandbox.cjs` — sandbox backends (Docker container, local host)
- `results.cjs` — result collection and diff reports
- `index.cjs` — standalone entry point
