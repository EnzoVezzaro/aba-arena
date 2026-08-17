# ABA — ACC Battle Arena

🚧 **Work in Progress**

**ABA** is a standalone benchmark application that answers one question:

> Does the **ACC framework** help an AI coding agent work with a repository
> better than no ACC at all?

It runs the same repository and the same task series on **two isolated
sandboxes side by side** — one prepared with ACC (`acc init` → `acc build` →
`acc fill` → `acc graph` → `acc context`), one plain — with real coding
agents, plan/act tasks, automatic project verification, and a live Vite
battle arena in your browser.

> **ABA is not part of the ACC framework.** The framework never requires it
> and works without it — ABA is an independent tool with its own entry
> point, dependencies, and lifecycle.

## Repositories

ABA is part of the ACC ecosystem:

- **[agents-code-context](https://github.com/EnzoVezzaro/agents-code-context)**
  — the main repository: the ACC framework, its docs, and this directory
  where ABA lives as a self-contained project
- **[aba-arena](https://github.com/EnzoVezzaro/aba-arena)** — this project's
  own repository (published to npm as `acc-battle-arena`)

If ABA is useful to you, consider supporting the work:

[![Sponsor](https://img.shields.io/github/sponsors/EnzoVezzaro?label=Sponsor&logo=GitHub)](https://github.com/sponsors/EnzoVezzaro)

## What it does

- **Real agents in sandboxes.** Each panel runs a coding-agent harness
  (`harness.cjs`, modeled on mini-coding-agent) *inside its own isolated
  sandbox copy* of the repo. The harness is driven by the Vercel AI SDK with
  a custom base URL, so every supported provider works. The two sides can
  never touch each other's files or the original repository.
- **Plan/act tasks.** Every task has a mode: **plan** (the agent studies the
  code and produces a plan, read-only) or **act** (the agent edits the code,
  then the harness automatically **starts the project** — it reads
  `package.json` scripts, runs the start/test/build command, and reports
  whether the project still runs). A project that no longer starts fails the
  task in the benchmark.
- **The Answer panel is the sandbox terminal.** While a panel runs you watch
  the agent work live: its `$` commands, tool results, and reasoning stream
  into a terminal view — including the final "start the project" step and
  the server output.
- **Provider/model per panel** — OpenAI, Anthropic, Google Gemini, OpenRouter,
  Groq, DeepSeek, Mistral, xAI, Cerebras, NVIDIA NIM, local Ollama / LM
  Studio, and (optional) Freebuff's free models. Model lists load **live
  from each provider's models endpoint**, with FREE chips and a "free"
  search filter. Keys live in your browser (keyed providers) or in the local
  proxy (Freebuff).
- **Live metrics** — streaming output, time-to-first-token, generation time,
  throughput, estimated cost, agent steps, and a transparent success
  heuristic, with per-metric "best" highlights, **blind mode** (judge without
  knowing which panel has ACC), answer/code views, the sandbox file explorer,
  and local battle history.
- **GitHub repo autocomplete** — connect your GitHub account in Settings
  (OAuth popup) and your repos appear as suggestions under the repository
  box, loading with your token (private repos work). A **folder browser**
  loads local projects from disk.

The original repository is never modified — ABA always works on an isolated
snapshot.

## Quickstart

From this repository:

```bash
node src/index.cjs                 # spawn the battle arena and open the browser
node src/index.cjs ./my-project    # open the UI with a repo preloaded
```

Published package (also used by the `acc` CLI as a convenience launcher):

```bash
npx acc-battle-arena ./my-project
acc battle ./my-project        # via acc-agents (latest: 0.4.0)
```

## Usage

The web app is the main interface: load a repository (local path, GitHub URL,
or a connected-GitHub repo), pick a provider/model per panel, choose or write
a task series (each task plan or act), and hit **Run battle**.

### Headless terminal benchmark

```bash
node src/index.cjs ./my-project --headless --local
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

## Configuration

The server reads `aba/.env` automatically (real environment variables always
win). See [`.env.example`](.env.example) for everything:

- **GitHub OAuth** — `ABA_GITHUB_CLIENT_ID` / `ABA_GITHUB_CLIENT_SECRET` (the
  "ACC Battle Arena" GitHub App; register `http://localhost:4317/api/github/callback`
  as a redirect URI)
- **Freebuff (optional)** — `ABA_FREEBUFF_TOKENS` and `ABA_FREEBUFF_AUTOSTART`
  (ABA never runs the proxy on its own; see [`freebuff/README.md`](freebuff/README.md))

## Project structure

```
aba/
├── src/             # backend (Node) — entry point, CLI, server, harness
│   ├── src/index.cjs    #   entry point (web app + headless CLI)
│   ├── cli.cjs      #   argument parsing + battle configuration
│   ├── importer.cjs #   project import → isolated snapshots
│   ├── sandbox.cjs  #   headless sandbox backends (Docker / local host)
│   ├── results.cjs  #   headless result collection + diff reports
│   ├── server.cjs   #   local backend: repo load, ACC pipeline, sandbox API,
│   │                #     agent-harness runner, model-list proxy, GitHub OAuth
│   └── harness.cjs  #   the coding agent that runs INSIDE each sandbox
│                    #     (AI SDK + custom base URL; plan/act; verify)
├── freebuff/        # vendored Freebuff2API (optional local Freebuff proxy)
├── ui/              # React + Vite battle arena (source + AGENTS.md)
├── AGENTS.md        # ACC contract for this directory
└── package.json     # npm package: `aba` bin → src/src/index.cjs
```

The UI (`ui/`) is a self-contained Vite app with its own `AGENTS.md`; the
backend lives in `src/` so server code, the frontend, and optional
integrations stay clearly separated.

## Development

```bash
npm run build:ui          # install + build the Vite UI (first run auto-builds)
npm run dev:ui            # Vite dev server with HMR (proxies /api to :4317)
node src/index.cjs            # run the backend + serve the built UI
```

## Credits & thanks

ABA stands on the shoulders of the open source community. Explicit credit
where it is due:

- **[isbetter.ai](https://github.com/midudev/isbetter.ai)** by
  [midudev](https://github.com/midudev) (MIT / FSL-1.1-MIT) — the battle
  arena is adapted from it: the side-by-side arena concept, metric pills and
  per-metric winner logic, code extraction helpers, blind mode, and the
  history pattern (`ui/src/arena.js` is adapted from it). Live at
  [isbetter.ai](https://isbetter.ai/).
- **[Freebuff2API](https://github.com/Quorinex/Freebuff2API)** (MIT) — the
  optional local Freebuff proxy, vendored under [`freebuff/`](freebuff/README.md),
  which exposes Freebuff's free models to any OpenAI-compatible client.
- **[genai-prices](https://github.com/pydantic/genai-prices)** by Pydantic
  (MIT) — the pricing catalog behind the battle cost estimates: the
  `@pydantic/genai-prices` package (bundled data + model matching) is the
  fallback for models without curated rates.
- **[mini-coding-agent](https://github.com/michaelmov/mini-coding-agent)** by
  Michael Movsesov — the agentic loop (read → think → act → verify) the
  harness is modeled on, wired to the Vercel [AI SDK](https://ai-sdk.dev/)
  so every ABA provider works.
- The **Vercel AI SDK** and its provider adapters, **React**, **Vite**, and
  the open standards ABA interoperates with: [agents.md](https://agents.md/),
  Agent Skills (https://agentskills.io/), and MCP
  (https://modelcontextprotocol.io/).

<!-- tags: midudev https://github.com/midudev, michaelmov https://github.com/michaelmov/mini-coding-agent, Quorinex https://github.com/Quorinex/Freebuff2API, CodebuffAI https://github.com/CodebuffAI/freebuff, anomalyco https://github.com/anomalyco/opencode -->

### Special thanks to Freebuff 💜 and OpenCode 💜

I built most of ABA with [Freebuff](https://freebuff.com/?ref=ref-0f42f217-e7d8-472f-b137-ca83dacb992b) ([GitHub](https://github.com/CodebuffAI/freebuff)). It's free, no API keys, no subscription — just models you can actually use. For a solo developer in the Dominican Republic, that made a real difference. The design, the tests, even the UI iterations were shaped with Freebuff running locally.

I also spent countless hours with [OpenCode](https://opencode.ai) ([GitHub](https://github.com/anomalyco/opencode)) — the open source coding agent that runs in your terminal, supports 75+ providers, and includes free models out of the box. OpenCode made it possible to prototype, test, and iterate on ABA without spending a dime. The same spirit of making AI accessible to everyone.

> A note to the Freebuff and OpenCode teams: thank you for making this possible. From the Dominican Republic: keep bringing more powerful models to our people. 🌎💜

<!-- tags: Freebuff https://github.com/CodebuffAI/freebuff, OpenCode https://github.com/anomalyco/opencode -->

### To the open source community

Thank you — to every maintainer, contributor, and creator pushing this
ecosystem forward. The tools we build here would not exist without the
countless libraries, frameworks, and standards you release for free.

> **Gracias a toda la comunidad open source por los revolucionarios aportes
> que están haciendo.** 🙌

## Contributing

ABA is open source and welcomes contributions of every size — bug reports,
provider support, sandbox improvements, benchmark tasks, docs.

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — development setup, project layout,
  and the pull request process
- **[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)** — how we treat each other
- **[SECURITY.md](SECURITY.md)** — how to report vulnerabilities privately
- **[CHANGELOG.md](CHANGELOG.md)** — release history

## Support

ABA is free and open source. If it helps you benchmark and improve agent
context, consider sponsoring:

[![Sponsor](https://img.shields.io/github/sponsors/EnzoVezzaro?label=Sponsor&logo=GitHub)](https://github.com/sponsors/EnzoVezzaro)

## License

[MIT](LICENSE)


🚧 **Work in Progress**

> [ ] ⚠️ **Current issue:** Render is showing a white screen — needs a fix.