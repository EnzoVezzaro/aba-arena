# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Open-source project files** — `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, and `CHANGELOG.md`, plus GitHub issue templates
  (bug report, feature request), discussion templates, and the
  `FUNDING.yml` sponsor configuration.

---

## [0.2.0] - 2026-08-16

### Added
- **Coding-agent harness** (`src/harness.cjs`) — modeled on
  mini-coding-agent, driven by the Vercel AI SDK with a custom base URL so
  every supported provider works. Runs inside each panel sandbox.
- **ACC pipeline in the sandbox** — the ACC panel prepares its copy with
  `acc init` → `acc build` → `acc fill` → `acc graph` → `acc context`
  before the prompt reaches the harness.
- **Plan/act tasks** — plan tasks are read-only; act tasks edit the code and
  then the harness automatically **starts the project** (runs the
  `package.json` scripts) and reports whether it still runs.
- **Strict sandbox isolation** — each panel gets its own isolated copy
  (Docker container when available, host fallback otherwise); the two sides
  can never touch each other's files or the original repository.
- **The Answer panel is the sandbox terminal** — live streaming of the
  agent's `$` commands, tool results, and reasoning, including the
  project-start step and its server output.
- **Per-metric winners, blind mode, and battle history** — with
  per-run history delete and searchable provider/repo selects.
- **Settings (GitHub + data)** — GitHub account connection for repo
  autocomplete, provider keys, and local data management.
- **Dynamic provider/model registry** — model lists load from each
  provider's endpoint (no hardcoding when avoidable), with free-model chips
  and free filtering.
- **Favicon** — shared markdown-file favicon with the ACC ecosystem.

### Fixed
- **Robust battle lifecycle** — no hangs on provider blocks, accurate
  history, correct metric pills and per-metric winners.
- **Per-card Code/Answer views** — the code explorer and terminal are
  per-panel, not global.
- **Sandbox repo re-establishes on `/battle`** — the explorer shows the
  battle repo and the ACC install.
