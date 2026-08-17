# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

---

## [0.3.6]

### Fixed
- **Battle result cards now enter with the history panel's motion** — a full
  sweep from 100% off-screen to 0 over 200ms ease-out, mirrored per card
  (left card slides in from the left edge, right card from the right). The
  previous approximation was a subtle 2.5rem slide + fade that read as no
  animation at all.
- **The file explorer (ACC files / plain files) slides like the history
  drawer** — it now stays mounted through its exit transition (`useOverlay`,
  same as the drawer) and slides in/out from the right over 200ms ease-out
  with a fading backdrop, instead of popping in instantly.

### Changed
- **Header logo cleanup** — removed the bordered accent-tinted box around the
  logo (and the inline `acc` label): the favicon badge now stands alone at
  32px with a subtle hover scale, matching the brand mark's own badge
  identity.

---

## [0.3.5-dev-stable]

### Added
- **Fully ACC-compliant sandbox before every battle** — the load pipeline now
  runs `acc init` → `acc build` → `acc fill` (applied, not just reported) →
  `acc memory` → `acc graph` → `acc context` → `acc check` → `acc verify`, so
  the ACC panel's contracts are complete on disk before the first prompt:
  every content folder gets an `AGENTS.md` (any file type — `css/`,
  `images/`, … are covered, not just code dirs), every contract is filled
  with repo-derived content (root from README/package.json, folders from
  their own contents), every contract has a filled `.acc-memory.md`
  alongside it, and a final documentation gate fails the load if anything is
  missing.
- **Complete `.acc/config/` control plane** — project-aware `config.yaml`
  (every setting the framework reads, derived from the repo's languages and
  build noise), `agents/default.md`, `standards/` (architecture, coding,
  review), 7 standard `workflows/` (feature, bugfix, refactor, release,
  security, diagnostic, tooling), plus `skills/`, `mcp/`, `tools/`,
  `multi-agent/` docs.
- **Provider-reported token usage + cost** — the harness accumulates the AI
  SDK's per-step usage and streams it back; the battle page prices those
  tokens with the provider's published rates, falling back to the
  **genai-prices catalog** (`@pydantic/genai-prices`) and a generic
  $1/$3 per 1M tokens. Free and local providers show $0. Estimates are
  flagged `~`/`(est.)`.
- **Blind mode on by default** — the battle starts with the panels hidden
  under aliases; a **Shuffle** button re-assigns them with a flip animation
  (every click guarantees a new order), and the Blind button toggles
  Reveal/Blind.
- **Per-round metrics table** — every task shows time, tokens (input/output
  split), cost, and pass for both panels, with a redesigned battle-analysis
  summary (average tiles + verdict banner).
- **Battle lifecycle controls** — Stop and Delete buttons on the battle page;
  stopped/errored battles persist without a verdict, and reloading a
  finished battle replays the saved report instead of re-running it.
- **Report export/import** — export the battle report as JSON from the
  summary, and the history drawer can load an exported report back in.
- **Harness tool-call recovery** — plain-language feedback when a required
  argument is missing, a loop-cutter that tells a stuck model to move on
  instead of burning its steps, and codebase-agnostic tool descriptions and
  verify prompts (any project manifest, any language).
- **Open-source project files** — `CONTRIBUTING.md`, `SECURITY.md`,
  `CODE_OF_CONDUCT.md`, and `CHANGELOG.md`, plus GitHub issue templates
  (bug report, feature request), discussion templates, and the
  `FUNDING.yml` sponsor configuration.

### Fixed
- **Shuffle** — with two panels a random shuffle is a coin flip; every click
  now visibly re-assigns the aliases.
- **Battle restart on reload** — a finished battle was re-run when the page
  reloaded; it now replays the saved report.
- **Loading modal** — no longer auto-closes; it stays up until
  "Ready — continue to arena" is clicked.
- **ACC context gaps** — `acc build` skipped non-code folders and never
  created the root contract; both are now covered, and `acc fill` (which is
  read-only) is actually applied so contracts are complete before the
  battle.
- **Misleading harness errors** — dead-end "no such file: undefined"
  messages and fake tool-call syntax hints replaced with recovery feedback
  that doesn't derail the agent.

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
