# Contributing to ABA — ACC Battle Arena

Thank you for your interest in contributing to ABA! This document outlines how
to contribute code, providers, sandbox improvements, benchmark tasks, and more.
We're glad you're here — this is an open source project built for the open
source community.

> **Not sure if this is the right repo?** ABA is the battle arena. Bugs in the
> ACC framework itself (the `acc` CLI, diagnostics, context engine) belong in
> the [main repository](https://github.com/EnzoVezzaro/agents-code-context).

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Layout](#project-layout)
- [What to Work On](#what-to-work-on)
- [Contribution Types](#contribution-types)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-stanards)
- [Testing](#testing)
- [Release Process](#release-process)

---

## Code of Conduct

This project follows our [Code of Conduct](./CODE_OF_CONDUCT.md). By
participating, you agree to uphold it. Be kind, be constructive, assume good
intent.

---

## Getting Started

1. **Fork the repository** on GitHub.
2. **Clone your fork** locally:

   ```bash
   git clone https://github.com/YOUR-USERNAME/aba-arena.git
   cd aba-arena
   ```

3. **Add the upstream remote:**

   ```bash
   git remote add upstream https://github.com/EnzoVezzaro/aba-arena.git
   ```

4. **Create a feature branch:**

   ```bash
   git checkout -b feat/your-feature-name
   ```

---

## Development Setup

### Prerequisites

- **Node.js 18+**
- **npm**
- **Docker** (recommended — sandbox mode; without it ABA falls back to
  running the harness directly on your host)

### Install & run

```bash
# Install server deps and build the UI
npm install
npm run build:ui

# Start the server (serves the battle arena UI + API)
npm start        # → http://localhost:<port>
```

For UI work with hot reload:

```bash
npm run dev:ui   # Vite dev server for the React app
```

The server (`index.cjs`) serves the built UI from `ui/dist/` and exposes the
battle API. The `prepare` script builds the UI automatically on install.

---

## Project Layout

```
index.cjs           # Entry point — starts the server
src/
├── server.cjs      # HTTP server + battle API
├── sandbox.cjs     # Battle sandboxes (Docker container, host fallback)
├── importer.cjs    # Repository import (local path, GitHub URL, folder)
├── harness.cjs     # The coding-agent harness (modeled on mini-coding-agent,
│                   #   driven by the Vercel AI SDK with a custom base URL)
├── cli.cjs         # CLI entry (--headless etc.)
└── results.cjs     # Metrics, per-metric winners, history
ui/                 # React + Vite frontend (the battle arena)
├── src/
│   ├── App.jsx     # Provider/model selects, settings, task library
│   ├── BattlePage.jsx  # The two panels, streaming terminal, timeline
│   ├── arena.js    # Battle orchestration client-side
│   ├── providers.js    # Provider registry (dynamic from model endpoints)
│   └── components.jsx  # Shared UI (searchable selects, modals, drawers)
```

---

## What to Work On

- **Issues labeled `good first issue`** are a great starting point.
- **Check existing issues and discussions** before starting work.
- **Provider/model support** — the model list is meant to stay dynamic; new
  providers usually just need their endpoint + auth shape registered.
- **Sandbox behavior** — isolation, cleanup, "start the project" verification.
- **Battle metrics** — fairness of the ACC vs no-ACC comparison.

---

## Contribution Types

### 🐛 Bug Fixes

1. Search existing [issues](https://github.com/EnzoVezzaro/aba-arena/issues) first.
2. Include the battle context in the report: provider, sandbox mode, task mode.
3. Fix the bug **with a regression check** — run a battle manually to confirm.
4. If sandboxes leaked (containers/processes left behind), that's a bug on its
   own — fix it as part of your change.

### ✨ New Features

1. Open an issue to discuss the feature first (see the issue templates).
2. For provider support: register the provider, keep the model list dynamic
   from its endpoint, mark free models, and make it filterable.
3. Add UI + server changes in the same PR.

### 🏗️ Harness / Sandbox Changes

The harness (`src/harness.cjs`) runs inside the sandbox and drives the agent —
it decides tool use, "start the project" verification, and terminal output.
Sandbox changes affect isolation guarantees. **Both need extra care:**

- Harness: test both plan and act tasks; confirm the project actually starts.
- Sandbox: confirm cleanup on stop/delete and that the two panels can never
  touch each other's files.

### 📚 Documentation

- Fix typos, clarify README instructions, improve the battle docs.
- Keep the README's entry point and install steps accurate.

---

## Pull Request Process

1. **Make your changes** following the [Coding Standards](#coding-stanards).

2. **Build the UI:**

   ```bash
   npm run build:ui
   ```

3. **Verify with a real battle** (at minimum, a short act task with a cheap
   model) — the arena must stream output and finish cleanly.

4. **Verify sandbox cleanup** — stop/delete a battle mid-run and confirm no
   leftover containers or processes.

5. **Commit with conventional commits:**

   ```bash
   git commit -m "feat: add Groq provider to the model registry"
   ```

   Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `security`.

6. **Push and open a PR:**

   ```bash
   git push origin feat/your-feature-name
   ```

7. **PR Requirements:**
   - [ ] UI builds (`npm run build:ui`)
   - [ ] A battle run was verified end-to-end (or explained why not)
   - [ ] Sandbox cleanup verified for lifecycle changes
   - [ ] Provider/model changes keep the list dynamic and free-model filtering
   - [ ] Docs/README updated if the entry point or setup changed

8. **Review:** At least one maintainer approval required.

---

## Coding Stanards

- **Server:** CommonJS, 2-space indent, `const` over `let`, clear comments on
  lifecycle logic (sandbox, harness, battle state).
- **UI:** React function components + hooks, Tailwind-style utility classes
  (the project's `styles.css` tokens), searchable selects over bare inputs for
  anything with many options.
- **Determinism:** battle output and metrics must be reproducible — no
  timestamps or random values in metric comparisons.
- **No secrets in code:** API keys and tokens live in local storage, never in
  committed files.

---

## Testing

ABA is a live, agent-driven application — the practical test is a real battle:

- **Build check:** `npm run build:ui` must pass.
- **Smoke battle:** run a short act task with a small/free model; confirm the
  terminal streams, the project-start step runs, and a winner is declared.
- **Cleanup check:** stop and delete a battle mid-run; confirm sandboxes are
  removed.
- **Provider check:** when adding/changing providers, confirm the model list
  loads from the endpoint and free models are filterable.

Bug fixes ship with a description of the battle scenario used to verify them.

---

## Release Process

Maintainers handle version bumps and publishing to npm (`acc-battle-arena`).
ABA follows [Semantic Versioning](https://semver.org/) and keeps a
[Keep a Changelog](https://keepachangelog.com/) in `CHANGELOG.md`.

---

## Questions?

- Open a [GitHub Discussion](https://github.com/EnzoVezzaro/aba-arena/discussions)
- Check existing [Issues](https://github.com/EnzoVezzaro/aba-arena/issues)
- Framework questions belong in the [main repository](https://github.com/EnzoVezzaro/agents-code-context)

Thank you for contributing to ABA! 🎉
