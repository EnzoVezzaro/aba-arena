# src

## Purpose

The React source for the ABA battle arena: battle orchestration, arena
simulation, provider adapters, server API client, and all UI components.

## Responsibilities

- Orchestrate a battle (`BattlePage.jsx`): start/stop, streaming per panel,
  per-task results, metrics, winners, blind mode, and history persistence.
- Simulate the two-panel arena (`arena.js`) with per-panel providers.
- Adapter-agnostic provider layer (`providers.js`) and server client
  (`api.js`): repo metadata, sandbox file tree/read/write, reports.
- Render the arena components: `App.jsx` (config), `components.jsx`
  (panel/result cards, history drawer), `Timeline.jsx`, `CodeSandbox.jsx`,
  `CodeExplorer.jsx`, `icons.jsx`; entry via `main.jsx`; styles in
  `styles.css`; the default task series in `tasks.js`.

## Ownership

Owner: ui/src

## Inputs

- The ABA server REST API and the browser's stored provider keys and
  battle history (localStorage).
- The battle configuration (repo, task series, per-panel provider/model).

## Outputs

- The rendered arena views and battle results presented to the user.

## Dependencies

- (external npm packages: react, react-dom, vite, and the AI SDK with its provider adapters)

## Constraints

- MUST NOT make LLM calls from the server — streaming is browser-side only.
- MUST NOT leak ACC identity while blind mode is active (labels, styling,
  summary, timeline, file explorers all stay aliased until reveal).
- MUST NOT hang on a silent provider — every panel races against hard and
  idle timeouts.
- MUST NOT commit the built bundle; only source lives in the repo.

## Architecture

Entry (`main.jsx`) mounts `App.jsx`, which renders the config page or the
battle page (`BattlePage.jsx`). The battle page composes result cards,
the timeline, and code views; `arena.js` coordinates the panel streams and
`providers.js` builds the AI SDK model instances per panel.

## Workflows

- See `.acc/config/workflows/feature.md` for the standard feature workflow.
