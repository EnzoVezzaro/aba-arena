import React, { useEffect, useMemo, useRef, useState } from 'react';
import { streamText } from 'ai';
import { PROVIDERS, getProvider, estimateCost, loadKeys, saveKey, fetchProviderModels } from './providers.js';
import { DEFAULT_TASKS, checkSuccess } from './tasks.js';
import {
  fmtDur,
  fmtInt,
  fmtCost,
  fmtRate,
  estTokens,
  extractCode,
  extractAnswer,
  computeWinners,
} from './arena.js';
import { health, loadRepo, saveReport } from './api.js';
import IconSprite from './icons.jsx';
import Timeline from './Timeline.jsx';

const DEFAULT_SYSTEM =
  'You are a senior software engineer benchmarking how well an AI coding agent ' +
  'understands a repository. You are given repository context and a task. Respond ' +
  'concisely and concretely — name specific files, modules, and conventions. Include ' +
  'code where the task asks for it.';

const TASK_EXAMPLES = [
  {
    label: 'Repo comprehension',
    prompt:
      'Summarize this repository: its purpose, main modules and how they relate, and the conventions a contributor must follow. Be specific and concrete.',
  },
  {
    label: 'Unit test',
    prompt:
      'Write one meaningful unit test for the primary module of this repository. Explain in one short paragraph what it verifies, then give the test code.',
  },
  {
    label: 'Find & fix a bug',
    prompt:
      'Find the most likely bug or code smell in the main source files of this repository. Propose a concrete fix, including a code snippet showing the corrected code.',
  },
  {
    label: 'Feature plan',
    prompt:
      'Explain how you would add a new feature to this project following its existing conventions: which files you would touch, in what order, and how you would validate the change.',
  },
];

const HISTORY_KEY = 'aba.history.v1';
const MAX_HISTORY = 20;

function makePanel(id, acc, label) {
  return { id, acc, label, provider: 'openai', model: 'gpt-4o', apiKey: '' };
}

const INITIAL_PANELS = [
  makePanel('acc', true, 'ACC — acc-agents installed'),
  makePanel('plain', false, 'No ACC — plain repository'),
];

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveHistory(history) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
}

function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/* ------------------------------------------------------------------------ */
/* Icons                                                                     */
/* ------------------------------------------------------------------------ */

function Icon({ name, className = 'size-4' }) {
  return (
    <svg className={className} aria-hidden="true">
      <use href={`#i-${name}`} />
    </svg>
  );
}

/* ------------------------------------------------------------------------ */
/* Metric pill (isbetter.ai statPill)                                        */
/* ------------------------------------------------------------------------ */

const PILL_ICON_COLORS = {
  'i-clock': 'text-sky-400',
  'i-clock-bolt': 'text-violet-400',
  'i-bolt': 'text-amber-400',
  'i-down': 'text-cyan-400',
  'i-up': 'text-emerald-400',
  'i-gauge': 'text-orange-400',
  'i-coin': 'text-yellow-400',
};

function MetricPills({ result, best }) {
  if (!result || (result.status !== 'done' && result.status !== 'running')) return null;
  const isBest = (k) => best && best[k];
  const gen = result.genMs != null ? result.genMs : result.durationMs;
  const tput = gen > 0 ? (result.outputTokens || 0) / (gen / 1000) : 0;
  const live = result.status === 'running';
  const pills = [
    { icon: 'i-bolt', key: 'fast', label: 'total time — request to finish', value: fmtDur(result.timeMs || result.durationMs || 0), best: isBest('fast') },
    { icon: 'i-clock', key: 'ttft', label: 'time to first token', value: result.ttftMs != null ? fmtDur(result.ttftMs) : live ? '…' : '—', best: isBest('ttft') },
    { icon: 'i-clock-bolt', key: 'gen', label: 'generation time — first to last token', value: live ? '—' : fmtDur(gen), best: isBest('gen') },
    { icon: 'i-down', key: 'in', label: 'input tokens', value: result.inputTokens != null ? `${fmtInt(result.inputTokens)}${live ? ' est.' : ''}` : live ? fmtInt(estTokens(result.output)) : '·', best: false },
    { icon: 'i-up', key: 'out', label: 'output tokens', value: result.outputTokens != null ? `${fmtInt(result.outputTokens)}${live ? ' est.' : ''}` : live ? fmtInt(estTokens(result.output)) : '·', best: false },
    { icon: 'i-gauge', key: 'tput', label: 'throughput — output tokens/sec', value: tput > 0 ? `${fmtRate(tput)} t/s` : '—', best: isBest('tput') },
    { icon: 'i-coin', key: 'cheap', label: 'cost (estimate)', value: result.cost != null ? `${fmtCost(result.cost)} est.` : '—', best: isBest('cheap') },
  ];
  const responsive = (icon) => (icon === 'i-down' || icon === 'i-clock-bolt' ? 'hidden sm:flex' : 'flex');
  return (
    <div className="flex flex-wrap gap-1.5 bg-[var(--color-panel)] px-3 py-2">
      {pills.map((p) => (
        <span
          key={p.key}
          tabIndex={0}
          data-metric-tooltip={p.label}
          aria-label={`${p.label}: ${p.value}`}
          className={`${responsive(p.icon)} items-center gap-1.5 rounded-md border px-2 py-1 ${
            p.best
              ? 'border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
              : 'border-[var(--color-line)] text-[var(--color-ink-dim)]'
          }`}
        >
          <Icon name={p.icon.replace('i-', '')} className={`size-3.5 shrink-0 opacity-90 ${PILL_ICON_COLORS[p.icon] || 'text-[var(--color-ink-dim)]'}`} />
          <span className="font-mono text-[11px] tabular-nums">{p.value}</span>
          {p.best && <span className="text-[10px] font-medium uppercase tracking-wide">best</span>}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Result card (isbetter.ai renderCard)                                      */
/* ------------------------------------------------------------------------ */

function dotColor(state) {
  if (state === 'loading' || state === 'running' || state === 'streaming')
    return 'bg-[var(--color-accent)] animate-pulse';
  if (state === 'error') return 'bg-red-500';
  return 'bg-emerald-400';
}

function ResultCard({ panel, result, context, viewMode, onViewMode, blind, alias, best }) {
  const provider = getProvider(panel.provider);
  const name = blind ? alias : `${provider.label} · ${panel.model}`;
  const state = result?.status || 'pending';
  const code = result?.output ? extractCode(result.output) : '';
  const answer = result?.output ? extractAnswer(result.output) : '';
  const elapsed = state === 'running' ? Date.now() - (result._startedAt || Date.now()) : result?.timeMs || 0;

  return (
    <article className="result-card flex flex-col overflow-hidden rounded-2xl border border-[var(--color-line)] bg-[var(--color-panel)]">
      {/* header */}
      <div className="flex min-h-12 items-center gap-2 border-b border-[var(--color-line)] px-3.5 py-2.5">
        <span className={`size-2 shrink-0 rounded-full ${dotColor(state)}`} aria-hidden="true" />
        <span className="sr-only">{state}</span>
        {!blind && (
          <span
            className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-pixel text-[9px] uppercase tracking-[0.14em] ${
              panel.acc
                ? 'border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
                : 'border border-[var(--color-line-hi)] bg-[var(--color-panel-hi)] text-[var(--color-ink-dim)]'
            }`}
          >
            {panel.acc ? 'ACC' : 'no-ACC'}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--color-ink)]" title={blind ? '' : panel.model}>
          {name}
        </span>
        <button
          aria-label="Re-run this panel"
          className="grid size-7 place-items-center rounded-md text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-line)] hover:text-[var(--color-ink)]"
          title="re-run this panel"
        >
          <Icon name="refresh" className="size-4" />
        </button>
      </div>

      <MetricPills result={result} best={best} />

      {/* content */}
      <div className="h-[clamp(20rem,50vh,38rem)] bg-[var(--color-surface)]">
        {state === 'pending' && (
          <div className="grid h-full place-items-center text-[var(--color-ink-faint)]">
            <div className="flex flex-col items-center gap-2 text-[12px]">
              <Icon name="clock" className="size-6 opacity-60" />
              <span>waiting…</span>
            </div>
          </div>
        )}
        {state === 'loading' && (
          <div className="grid h-full place-items-center text-[var(--color-ink-faint)]">
            <div className="flex flex-col items-center gap-3">
              <span className="block size-7 rounded-full border-2 border-[var(--color-line-hi)] border-t-[var(--color-accent)] spin" />
              <span className="font-mono text-[11px] tabular-nums">{fmtDur(elapsed)}</span>
            </div>
          </div>
        )}
        {state === 'error' && (
          <div className="grid h-full place-items-center p-5 text-center">
            <div className="flex flex-col items-center gap-2 text-red-400/90">
              <Icon name="alert" className="size-6" />
              <span className="max-w-[24rem] text-[12px] leading-relaxed">{result?.error || 'failed'}</span>
            </div>
          </div>
        )}
        {state === 'running' && (
          <div className="h-full overflow-auto p-3.5 text-[12px] leading-relaxed text-[var(--color-ink-dim)]">
            <div className="flex items-center gap-1.5 pb-2 text-[10px] uppercase tracking-[0.18em] text-[var(--color-ink-faint)]">
              <Icon name="brain" className="size-3.5 animate-pulse text-[var(--color-accent)]" />
              <span>thinking…</span>
            </div>
            <div className="whitespace-pre-wrap break-words">
              <span>{result?.output || ''}</span>
              <span className="caret" />
            </div>
          </div>
        )}
        {state === 'done' && (
          <>
            <div className="flex items-center gap-1 border-b border-[var(--color-line)] px-3 py-1.5">
              <button
                data-on={viewMode === 'answer'}
                className="view-tab flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] text-[var(--color-ink-dim)] transition-colors"
                onClick={() => onViewMode('answer')}
                aria-selected={viewMode === 'answer'}
              >
                <Icon name="text" className="size-4" />
                <span>Answer</span>
              </button>
              <button
                data-on={viewMode === 'code' && !!code}
                className={`view-tab flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] text-[var(--color-ink-dim)] transition-colors ${code ? '' : 'cursor-not-allowed opacity-40'}`}
                onClick={() => code && onViewMode('code')}
                aria-selected={viewMode === 'code' && !!code}
                disabled={!code}
              >
                <Icon name="code" className="size-4" />
                <span>Code{code ? ` (${code.split('\n').length})` : ''}</span>
              </button>
            </div>
            <div className="h-[calc(100%-2.5rem)] overflow-auto p-3.5 text-[12px] leading-relaxed text-[var(--color-ink-dim)]">
              {viewMode === 'code' && code ? (
                <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--color-ink)]">{code}</pre>
              ) : (
                <div className="whitespace-pre-wrap break-words">{answer || result.output}</div>
              )}
            </div>
          </>
        )}
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------------ */
/* Composer panel config (isbetter.ai panel-premium)                         */
/* ------------------------------------------------------------------------ */

function PanelConfig({ panel, onPanel, liveModels, modelsLoading }) {
  const keys = loadKeys();
  // Only providers the user has configured (key set, or local no-key).
  const available = PROVIDERS.filter((p) => !p.needsKey || keys[p.id]);
  const provider = getProvider(panel.provider);
  const configured = !provider.needsKey || !!(panel.apiKey || keys[panel.provider]);
  // Live model list from the provider API when available; static fallback otherwise.
  const models =
    liveModels[panel.provider] && liveModels[panel.provider].length
      ? liveModels[panel.provider]
      : provider.models;
  const loading = !!modelsLoading[panel.provider];
  // If the current provider lost its key, fall back to the first configured one.
  const effectiveProvider = available.some((p) => p.id === panel.provider)
    ? panel.provider
    : available[0]?.id;
  const effective = getProvider(effectiveProvider);
  return (
    <div
      className={`rounded-xl border p-3.5 ${
        panel.acc
          ? 'border-[var(--color-accent)]/25 bg-[var(--color-accent)]/[0.04]'
          : 'border-[var(--color-line)] bg-[var(--color-panel)]'
      }`}
    >
      <div className="mb-2.5 flex items-center gap-2">
        <span
          className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-pixel text-[9px] uppercase tracking-[0.14em] ${
            panel.acc
              ? 'border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
              : 'border border-[var(--color-line-hi)] bg-[var(--color-panel-hi)] text-[var(--color-ink-dim)]'
          }`}
        >
          {panel.acc ? 'ACC' : 'no-ACC'}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--color-ink-dim)]">{panel.label}</span>
        <span className={`size-1.5 shrink-0 rounded-full ${configured ? 'bg-emerald-400' : 'bg-[var(--color-ink-faint)]'}`} title={configured ? 'configured' : 'no API key set'} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-faint)]">Provider</span>
          <select
            value={effectiveProvider}
            onChange={(e) => {
              const next = e.target.value;
              const live = liveModels[next] && liveModels[next].length ? liveModels[next] : getProvider(next).models;
              onPanel({ ...panel, provider: next, model: live[0] || '' });
            }}
            className="arena-select min-h-9 w-full rounded-lg border border-[var(--color-line)] px-2.5 text-[12px] text-[var(--color-ink)] outline-none transition-colors hover:border-[var(--color-line-hi)] focus:border-[var(--color-accent)]/50"
          >
            {available.map((p) => (
              <option key={p.id} value={p.id} className="bg-[var(--color-panel)]">
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-faint)]">
            Model
            {loading && <span className="inline-block size-3 rounded-full border-2 border-[var(--color-line-hi)] border-t-[var(--color-accent)] spin" />}
          </span>
          <select
            value={panel.model}
            onChange={(e) => onPanel({ ...panel, model: e.target.value })}
            className="arena-select min-h-9 w-full rounded-lg border border-[var(--color-line)] px-2.5 text-[12px] text-[var(--color-ink)] outline-none transition-colors hover:border-[var(--color-line-hi)] focus:border-[var(--color-accent)]/50"
          >
            {models.map((m) => (
              <option key={m} value={m} className="bg-[var(--color-panel)]">
                {m}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="mt-2 text-[10px] text-[var(--color-ink-faint)]">
        {loading
          ? 'loading models from provider…'
          : liveModels[panel.provider] && liveModels[panel.provider].length
            ? `${liveModels[panel.provider].length} models live from ${effective.label}`
            : provider.needsKey && !configured
              ? 'no API key yet — add it in API keys (K)'
              : 'model list from provider API — add/refresh key to update'}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Key modal (isbetter.ai API key modal)                                     */
/* ------------------------------------------------------------------------ */

function KeyModal({ open, onClose, onSaved }) {
  const [draft, setDraft] = useState(loadKeys());
  useEffect(() => {
    if (open) setDraft(loadKeys());
  }, [open]);
  if (!open) return null;
  return (
    <div id="key-modal" className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="key-modal-title">
      <div id="key-backdrop" className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={onClose} />
      <div className="panel-premium absolute left-1/2 top-1/2 w-[min(92vw,480px)] -translate-x-1/2 -translate-y-1/2 p-5 shadow-2xl sm:p-6">
        <div className="flex items-center gap-2.5">
          <span className="grid size-10 place-items-center rounded-xl bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
            <Icon name="key" className="size-5" />
          </span>
          <div>
            <h2 id="key-modal-title" className="text-[14px] font-medium text-[var(--color-ink)]">
              Connect providers
            </h2>
            <p className="mt-0.5 text-[11px] text-[var(--color-ink-faint)]">
              Keys stay in this browser and are only sent to their provider.
            </p>
          </div>
        </div>
        <div className="no-scrollbar mt-4 max-h-[min(60vh,560px)] space-y-3 overflow-y-auto pr-1">
          {PROVIDERS.map((provider) => (
            <div key={provider.id}>
              <div className="mb-1 flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 text-[11px] text-[var(--color-ink-dim)]">
                  <span
                    className={`grid size-4 place-items-center rounded border ${
                      provider.needsKey ? 'border-[var(--color-line-hi)] text-[var(--color-ink-faint)]' : 'border-[var(--color-accent)]/30 text-[var(--color-accent)]'
                    }`}
                  >
                    <Icon name={provider.needsKey ? 'key' : 'check'} className="size-3" />
                  </span>
                  {provider.label}
                </span>
                {!provider.needsKey && (
                  <span className="text-[10px] text-[var(--color-ink-faint)]">no key needed (local server)</span>
                )}
              </div>
              {provider.needsKey && (
                <div className="control-surface flex items-center gap-2 px-3 focus-within:border-[var(--color-accent)]/45">
                  <input
                    id={`api-key-${provider.id}`}
                    type="password"
                    placeholder={`${provider.label} API key…`}
                    aria-label={`${provider.label} API key`}
                    autoComplete="off"
                    spellCheck="false"
                    value={draft[provider.id] || ''}
                    onChange={(e) => setDraft((prev) => ({ ...prev, [provider.id]: e.target.value }))}
                    className="w-full bg-transparent font-mono text-[13px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)]"
                  />
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button className="control-surface px-4 text-[12px]" onClick={onClose}>
            Cancel
          </button>
          <button
            className="action-primary flex items-center gap-1.5 px-4 text-[12px] font-semibold"
            onClick={() => {
              for (const [id, key] of Object.entries(draft)) saveKey(id, key);
              onClose();
              if (onSaved) onSaved();
            }}
          >
            <Icon name="check" className="size-4" />
            <span>Save</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* History drawer (isbetter.ai history drawer)                               */
/* ------------------------------------------------------------------------ */

function HistoryDrawer({ open, history, onClose, onClear }) {
  if (!open) return null;
  return (
    <div id="history-drawer" className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="history-title">
      <div id="history-backdrop" className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={onClose} />
      <aside
        id="history-panel"
        className="absolute right-0 top-0 flex h-full w-[min(94vw,480px)] flex-col border-l border-[var(--color-line-hi)] bg-[var(--color-panel)] shadow-2xl"
      >
        <header className="flex items-center gap-2.5 border-b border-[var(--color-line)] px-4 py-3.5">
          <span className="grid size-10 place-items-center rounded-xl bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
            <Icon name="history" className="size-5" />
          </span>
          <div className="flex-1">
            <h2 id="history-title" className="text-[14px] font-medium text-[var(--color-ink)]">
              Battle history
            </h2>
            <p className="text-[11px] text-[var(--color-ink-faint)]">stored locally in this browser</p>
          </div>
          <button
            onClick={onClear}
            aria-label="Clear battle history"
            className="flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-2 py-1.5 text-[11px] text-[var(--color-ink-faint)] transition-colors hover:border-red-500/40 hover:text-red-400"
          >
            <Icon name="trash" className="size-3.5" />
            <span>clear</span>
          </button>
          <button
            onClick={onClose}
            aria-label="Close battle history"
            className="grid size-8 place-items-center rounded-md text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-line)] hover:text-[var(--color-ink)]"
          >
            <Icon name="x" className="size-4" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-3">
          {history.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12px] text-[var(--color-ink-faint)]">No battles yet. Run one and it shows up here.</p>
          ) : (
            <div className="space-y-2">
              {history.map((h) => (
                <div key={h.id} className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-3.5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--color-ink)]">{h.repoName}</span>
                    <span
                      className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] ${
                        h.verdict === 'ACC ahead'
                          ? 'border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
                          : h.verdict === 'no-ACC ahead'
                            ? 'border-red-500/30 bg-red-500/10 text-red-400'
                            : 'border-[var(--color-line)] text-[var(--color-ink-faint)]'
                      }`}
                    >
                      {h.verdict}
                    </span>
                  </div>
                  <p className="mt-1.5 font-mono text-[10px] tabular-nums text-[var(--color-ink-faint)]">
                    {new Date(h.ts).toLocaleString()} · {h.taskCount} tasks · {h.accWins}/{h.taskCount} ACC
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* App                                                                       */
/* ------------------------------------------------------------------------ */

export default function App() {
  const [repoInput, setRepoInput] = useState('');
  const [repo, setRepo] = useState(null);
  const [repoError, setRepoError] = useState('');
  const [loadingRepo, setLoadingRepo] = useState(false);
  const [backend, setBackend] = useState(null);

  const [panels, setPanels] = useState(INITIAL_PANELS);
  const [tasks, setTasks] = useState(DEFAULT_TASKS.map((t) => ({ ...t })));
  const [taskDraft, setTaskDraft] = useState('');
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM);
  const [sysOpen, setSysOpen] = useState(false);

  const [battleStatus, setBattleStatus] = useState('idle'); // idle | running | done | stopped
  const [results, setResults] = useState([]);
  const [viewMode, setViewMode] = useState('answer');
  const [blind, setBlind] = useState({ enabled: false, order: null, revealed: true });
  const [history, setHistory] = useState([]);
  const [keyModal, setKeyModal] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [liveModels, setLiveModels] = useState({}); // providerId -> model ids (fetched with key)
  const [modelsLoading, setModelsLoading] = useState({}); // providerId -> true while fetching

  /* Keep panels on providers that actually have a key; pick a live model. */
  useEffect(() => {
    setPanels((prev) => {
      const keys = loadKeys();
      const available = PROVIDERS.filter((p) => !p.needsKey || keys[p.id]);
      let changed = false;
      const next = prev.map((panel) => {
        const ok = available.some((p) => p.id === panel.provider);
        const providerId = ok ? panel.provider : available[0]?.id || 'openai';
        if (providerId !== panel.provider) changed = true;
        const live = liveModels[providerId];
        const list = live && live.length ? live : getProvider(providerId).models;
        const model = ok ? panel.model : list[0] || '';
        if (model !== panel.model) changed = true;
        return { ...panel, provider: providerId, model };
      });
      return changed ? next : prev;
    });
  }, [liveModels]);

  /* Dynamic model list — fetched from each configured provider's models API
     (isbetter.ai pattern). Called on mount and after keys are saved. */
  async function refreshModels() {
    const keys = loadKeys();
    const targets = PROVIDERS.filter((p) => !p.needsKey || keys[p.id]);
    setModelsLoading(Object.fromEntries(targets.map((p) => [p.id, true])));
    await Promise.all(
      targets.map(async (p) => {
        try {
          const models = await fetchProviderModels(p.id, keys[p.id]);
          if (models.length) setLiveModels((prev) => ({ ...prev, [p.id]: models }));
        } catch {
          // Keep the static fallback list when the provider is unreachable
          // (CORS, offline, no local server). The static list always works.
        }
      })
    );
    setModelsLoading({});
  }

  const abortRef = useRef(new Set());
  const resultsRef = useRef(results);
  resultsRef.current = results;

  useEffect(() => {
    setHistory(loadHistory());
    health().then(setBackend).catch((e) => setBackend({ error: e.message }));
    refreshModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard shortcuts (isbetter.ai style): K keys, H history, B blind.
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey) return;
      if (e.key === 'k' || e.key === 'K') setKeyModal((v) => !v);
      if (e.key === 'h' || e.key === 'H') setHistoryOpen((v) => !v);
      if (e.key === 'b' || e.key === 'B') toggleBlind();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* Repo ---------------------------------------------------------------- */

  async function handleLoadRepo() {
    const source = repoInput.trim();
    if (!source) return;
    setLoadingRepo(true);
    setRepoError('');
    try {
      const data = await loadRepo(source);
      setRepo({ ...data.repo, baseContext: data.baseContext, accContext: data.accContext });
      setResults([]);
      setBattleStatus('idle');
    } catch (err) {
      setRepoError(err.message);
    } finally {
      setLoadingRepo(false);
    }
  }

  /* Battle -------------------------------------------------------------- */

  function runPanel(panel, context, task, onDelta, onLive) {
    const provider = getProvider(panel.provider);
    const key = panel.apiKey || loadKeys()[panel.provider];
    if (provider.needsKey && !key) {
      throw new Error(`API key required for ${provider.label}`);
    }
    const controller = new AbortController();
    abortRef.current.add(controller);
    const startedAt = Date.now();
    let firstTokenAt = null;
    const samples = [];
    let lastSampleAt = 0;

    const model = provider.create(key);
    return streamText({
      model: model(panel.model),
      system: systemPrompt,
      prompt: `${context}\n\nTASK:\n${task.prompt}`,
      temperature: 0.3,
      abortSignal: controller.signal,
    }).then(async (result) => {
      const { textStream, usage } = result;
      let output = '';
      for await (const chunk of textStream) {
        output += chunk;
        if (firstTokenAt === null) {
          firstTokenAt = Date.now();
          if (onLive) onLive({ ttftMs: firstTokenAt - startedAt });
        }
        const now = Date.now();
        if (now - lastSampleAt > 120 || samples.length === 0) {
          lastSampleAt = now;
          samples.push({ tMs: now - startedAt, completionTokens: estTokens(output) });
        }
        onDelta(output);
      }
      const u = await usage;
      const doneAt = Date.now();
      const elapsed = doneAt - startedAt;
      const success = checkSuccess(output, task);
      return {
        status: 'done',
        output,
        timeMs: elapsed,
        ttftMs: firstTokenAt ? firstTokenAt - startedAt : elapsed,
        genMs: firstTokenAt ? doneAt - firstTokenAt : 0,
        inputTokens: u?.inputTokens ?? 0,
        outputTokens: u?.outputTokens ?? 0,
        cost: estimateCost(panel.model, u?.inputTokens ?? 0, u?.outputTokens ?? 0),
        success,
        samples,
      };
    });
  }

  function setPanelResult(taskIndex, panelId, patch) {
    setResults((prev) =>
      prev.map((r, i) =>
        i === taskIndex ? { ...r, panels: { ...r.panels, [panelId]: { ...(r.panels[panelId] || {}), ...patch } } } : r
      )
    );
  }

  function toggleBlind() {
    setBlind((prev) => {
      if (prev.enabled) return { enabled: false, order: null, revealed: true };
      const order = prev.order || shuffle(['acc', 'plain']);
      return { enabled: true, order, revealed: false };
    });
  }

  function reveal() {
    setBlind((prev) => ({ ...prev, revealed: true }));
  }

  const displayOrder = useMemo(() => {
    const ids = blind.enabled && blind.order ? blind.order : ['acc', 'plain'];
    return ids.map((id) => panels.find((p) => p.id === id)).filter(Boolean);
  }, [panels, blind]);

  const aliasFor = (panelId) => {
    if (!blind.enabled) return '';
    const idx = (blind.order || ['acc', 'plain']).indexOf(panelId);
    return `Panel ${String.fromCharCode(65 + Math.max(0, idx))}`;
  };

  async function startBattle() {
    if (!repo || battleStatus === 'running') return;
    setResults(tasks.map((t) => ({ task: t, panels: { acc: { status: 'pending' }, plain: { status: 'pending' } } })));
    setBattleStatus('running');

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      await Promise.all(
        panels.map(async (panel) => {
          const context = panel.acc ? repo.accContext : repo.baseContext;
          setPanelResult(i, panel.id, { status: 'running', output: '', _startedAt: Date.now() });
          try {
            const out = await runPanel(
              panel,
              context,
              task,
              (output) => setPanelResult(i, panel.id, { status: 'running', output }),
              (live) => setPanelResult(i, panel.id, live)
            );
            setPanelResult(i, panel.id, out);
          } catch (err) {
            setPanelResult(i, panel.id, { status: 'error', error: err.message });
          }
        })
      );
    }
    setBattleStatus((prev) => (prev === 'stopped' ? 'stopped' : 'done'));
    persistBattle();
  }

  function persistBattle() {
    const final = resultsRef.current;
    if (!final.length || !repo) return;
    const done = final.filter((r) => r.panels.acc?.status === 'done' || r.panels.plain?.status === 'done');
    if (!done.length) return;
    const history = loadHistory();
    const accWins = done.filter((r) => {
      const a = r.panels.acc;
      const p = r.panels.plain;
      if (!a || !p || a.status !== 'done' || p.status !== 'done') return false;
      if (a.success !== p.success) return a.success;
      return a.timeMs < p.timeMs;
    }).length;
    history.unshift({
      id: String(Date.now()),
      ts: Date.now(),
      repoName: repo.name,
      repoSource: repo.source,
      taskCount: final.length,
      accWins,
      verdict: accWins > final.length / 2 ? 'ACC ahead' : accWins < final.length / 2 ? 'no-ACC ahead' : 'tie',
    });
    saveHistory(history);
    setHistory(loadHistory());
  }

  function stopBattle() {
    for (const c of abortRef.current) c.abort();
    abortRef.current.clear();
    setBattleStatus('stopped');
  }

  /* Tasks --------------------------------------------------------------- */

  function addTask() {
    const text = taskDraft.trim();
    if (!text) return;
    setTasks((prev) => [...prev, { title: text.slice(0, 60), prompt: text, hints: [], minChars: 80 }]);
    setTaskDraft('');
  }

  function removeTask(i) {
    setTasks((prev) => prev.filter((_, idx) => idx !== i));
  }

  function useExample(prompt) {
    setTaskDraft(prompt);
  }

  /* Summary ------------------------------------------------------------- */

  const summary = useMemo(() => {
    if (results.length === 0) return null;
    const done = results.filter((r) => r.panels.acc?.status === 'done' && r.panels.plain?.status === 'done');
    if (done.length === 0) return null;
    const acc = done.map((r) => r.panels.acc);
    const plain = done.map((r) => r.panels.plain);
    const avg = (arr, f) => (arr.length ? arr.reduce((s, r) => s + f(r), 0) / arr.length : 0);
    const accWins = done.filter((r) => {
      const a = r.panels.acc;
      const p = r.panels.plain;
      if (a.success !== p.success) return a.success;
      return a.timeMs < p.timeMs;
    }).length;
    return {
      accWins,
      total: done.length,
      time: { acc: avg(acc, (r) => r.timeMs), plain: avg(plain, (r) => r.timeMs) },
      tokens: { acc: avg(acc, (r) => r.inputTokens + r.outputTokens), plain: avg(plain, (r) => r.inputTokens + r.outputTokens) },
      cost: { acc: avg(acc, (r) => r.cost), plain: avg(plain, (r) => r.cost) },
      success: { acc: acc.filter((r) => r.success).length, plain: plain.filter((r) => r.success).length },
    };
  }, [results]);

  async function handleSaveReport() {
    try {
      const r = await saveReport({ repo, panels, tasks, results, savedAt: new Date().toISOString() });
      alert(`Report saved: ${r.file}`);
    } catch (e) {
      alert(`Failed to save report: ${e.message}`);
    }
  }

  function clearHistory() {
    localStorage.removeItem(HISTORY_KEY);
    setHistory([]);
  }

  /* Render -------------------------------------------------------------- */

  const ready = repo && battleStatus !== 'running';

  return (
    <div className="grid-bg min-h-screen">
      <IconSprite />
      <div className="app-shell flex min-h-screen flex-col">
        {/* ============================== HEADER ============================== */}
        <header className="flex min-h-14 items-center justify-between gap-3 py-2.5">
          <a href="/" className="group flex min-w-0 items-center gap-3" aria-label="ABA home">
            <span className="grid size-9 shrink-0 place-items-center rounded-[0.65rem] border border-[var(--color-accent)]/20 bg-[var(--color-accent)]/[0.06] transition-colors group-hover:border-[var(--color-accent)]/40">
              <img src="/favicon.svg" alt="" className="size-5" />
            </span>
            <p className="truncate text-[15px] font-bold tracking-[-0.03em] text-[var(--color-ink)] sm:text-[16px]">
              <span className="font-pixel text-[13px] font-semibold tracking-normal text-[var(--color-accent)]">acc</span>
              <span className="ml-2">Agent Code Context</span>
              <span className="ml-2 text-[var(--color-ink-faint)]">· Battle Arena</span>
            </p>
          </a>
          <nav className="flex items-center gap-1.5 sm:gap-2" aria-label="Workspace">
            <button
              onClick={() => setHistoryOpen((v) => !v)}
              aria-label="Open battle history"
              className="control-surface relative flex min-h-9 items-center gap-2 px-2.5 text-[11px] sm:px-3"
              title="Battle history · shortcut: H"
            >
              <Icon name="history" className="size-4" />
              <span className="hidden sm:inline">History</span>
              {history.length > 0 && (
                <span className="min-w-[1.2rem] rounded-md bg-[var(--color-panel-hi)] px-1.5 py-0.5 text-center text-[10px] tabular-nums">
                  {history.length}
                </span>
              )}
              <kbd className="key-hint">H</kbd>
            </button>
            <button
              onClick={() => setKeyModal(true)}
              aria-label="Configure API keys"
              className="control-surface relative flex min-h-9 items-center gap-2 px-2.5 text-[11px] sm:px-3"
              title="Configure provider API keys · shortcut: K"
            >
              <Icon name="key" className="size-4" />
              <span className="hidden sm:inline">API keys</span>
              <span className="size-1.5 rounded-full bg-[var(--color-accent)]" aria-hidden="true" />
              <kbd className="key-hint">K</kbd>
            </button>
          </nav>
        </header>

        <main className="flex-1 pb-8">
          {/* ============================== HERO ============================== */}
          <section className="arena-intro pb-6 pt-8 lg:pb-7 lg:pt-10">
            <h1 className="max-w-3xl text-balance text-[clamp(2rem,4.5vw,3.75rem)] font-semibold leading-[1.02] tracking-[-0.05em] text-[var(--color-ink)]">
              ACC vs no-ACC. <em className="not-italic text-[var(--color-accent)]">Side by side.</em>
            </h1>
            <p className="mt-3 max-w-2xl text-[13px] leading-6 text-[var(--color-ink-dim)] sm:text-[14px]">
              Give both panels the same repository and the same benchmark tasks. One side has{' '}
              <strong className="font-semibold text-[var(--color-ink)]">ACC</strong> — the Agent Code Context framework —
              installed; the other doesn't. Compare the answer, code, speed, and cost in real time.
            </p>
          </section>

          {/* ============================ COMPOSER ============================ */}
          <section className="battle-composer panel-premium overflow-visible" aria-labelledby="battle-builder-title">
            <h2 id="battle-builder-title" className="sr-only">Configure a new battle</h2>

            <div className="grid lg:grid-cols-[minmax(18rem,0.82fr)_minmax(0,1.45fr)]">
              {/* ---- 01 Panels ---- */}
              <div className="min-w-0 border-b border-[var(--color-line)] p-4 sm:p-5 lg:border-b-0 lg:border-r">
                <div className="flex items-center justify-between gap-3">
                  <p className="composer-label">
                    <span className="composer-step">01</span>
                    Panels
                  </p>
                  <span className="inline-flex items-baseline gap-1.5 whitespace-nowrap text-[11px] text-[var(--color-ink-faint)]">
                    <span className="font-semibold tabular-nums text-[var(--color-ink)]">2/2</span>
                    <span>selected</span>
                  </span>
                </div>
                <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-ink-faint)]">
                  Pick provider + model for each side. Same repo, same tasks — the only difference is ACC.
                </p>

                <div className="mt-4 space-y-3">
                  {panels.map((p) => (
                    <PanelConfig
                      key={p.id}
                      panel={p}
                      liveModels={liveModels}
                      modelsLoading={modelsLoading}
                      onPanel={(np) => setPanels((prev) => prev.map((x) => (x.id === np.id ? np : x)))}
                    />
                  ))}
                </div>

                <div className="mt-5 border-t border-[var(--color-line)] pt-3">
                  <button
                    className="flex w-full items-center gap-2 py-2 text-left text-[12px] text-[var(--color-ink-dim)] transition-colors hover:text-[var(--color-ink)]"
                    title="system prompt · shortcut: S"
                    aria-expanded={sysOpen}
                    onClick={() => setSysOpen((v) => !v)}
                  >
                    <Icon name="chevron" className={`size-4 transition-transform ${sysOpen ? 'rotate-180' : ''}`} />
                    <span>Advanced instructions</span>
                    <kbd className="key-hint ml-auto">S</kbd>
                  </button>
                  {sysOpen && (
                    <div className="pt-2">
                      <textarea
                        rows="6"
                        spellCheck="false"
                        aria-label="System prompt"
                        value={systemPrompt}
                        onChange={(e) => setSystemPrompt(e.target.value)}
                        className="control-surface no-scrollbar w-full resize-y p-3.5 font-mono text-[11px] leading-relaxed outline-none focus:border-[var(--color-accent)]/50"
                      />
                      <div className="mt-2 flex justify-end">
                        <button
                          className="flex items-center gap-1.5 text-[11px] text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink)]"
                          onClick={() => setSystemPrompt(DEFAULT_SYSTEM)}
                        >
                          <Icon name="refresh" className="size-3.5" />
                          <span>Reset to default</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* ---- 02 Repository & tasks ---- */}
              <div className="min-w-0 p-4 sm:p-5">
                <div className="flex items-center justify-between gap-3">
                  <label className="composer-label" htmlFor="repo-input">
                    <span className="composer-step">02</span>
                    Repository &amp; tasks
                  </label>
                </div>

                <div className="prompt-shell relative mt-3">
                  <input
                    id="repo-input"
                    type="text"
                    placeholder="Local path or GitHub URL — e.g. ./my-project or https://github.com/user/repo"
                    value={repoInput}
                    onChange={(e) => setRepoInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleLoadRepo()}
                    spellCheck="false"
                    className="no-scrollbar block w-full bg-transparent px-4 py-3.5 text-[13px] leading-relaxed text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)] sm:text-[14px]"
                  />
                </div>
                {repo && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-ink-dim)]">
                    <span className="inline-flex items-center gap-1 rounded-md border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-accent)]">
                      <Icon name="check" className="size-3" />
                      loaded
                    </span>
                    <strong className="text-[var(--color-ink)]">{repo.name}</strong>
                    <span className="truncate text-[var(--color-ink-faint)]">{repo.source}</span>
                    {repo.sha && <code className="font-mono text-[10px] text-[var(--color-ink-faint)]">{repo.sha.slice(0, 10)}</code>}
                  </div>
                )}
                {repoError && (
                  <p className="mt-2 flex items-start gap-1.5 text-[11px] text-red-400" role="alert">
                    <Icon name="alert" className="mt-0.5 size-3.5 shrink-0" />
                    <span className="break-all">{repoError}</span>
                  </p>
                )}
                {backend && !backend.ok && (
                  <p className="mt-2 flex items-start gap-1.5 text-[11px] text-red-400" role="alert">
                    <Icon name="alert" className="mt-0.5 size-3.5 shrink-0" />
                    <span>Backend: {backend.error}</span>
                  </p>
                )}

                {/* Task series */}
                <div className="mt-4">
                  <p className="mb-1.5 text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-faint)]">
                    Benchmark series · {tasks.length} task{tasks.length === 1 ? '' : 's'}
                  </p>
                  <ul className="space-y-1.5">
                    {tasks.map((t, i) => (
                      <li key={i} className="flex items-center gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-2.5 py-1.5">
                        <span className="font-mono text-[10px] tabular-nums text-[var(--color-ink-faint)]">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-ink-dim)]">{t.title}</span>
                        <button
                          onClick={() => removeTask(i)}
                          className="grid size-6 shrink-0 place-items-center rounded-md text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-line)] hover:text-red-400"
                          aria-label={`Remove task ${i + 1}`}
                          title="remove task"
                        >
                          <Icon name="x" className="size-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>

                  {/* Add custom task */}
                  <div className="mt-2.5">
                    <div className="prompt-shell">
                      <textarea
                        rows="3"
                        placeholder="Or write a custom task for both panels…"
                        value={taskDraft}
                        onChange={(e) => setTaskDraft(e.target.value)}
                        spellCheck="false"
                        className="no-scrollbar block w-full resize-y bg-transparent px-4 pb-2 pt-3 text-[13px] leading-relaxed text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)]"
                      />
                    </div>
                    <div
                      className="no-scrollbar mt-1 flex items-center gap-1 overflow-x-auto"
                      aria-label="Example tasks"
                    >
                      <span className="shrink-0 px-1 font-pixel text-[9px] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">Try</span>
                      {TASK_EXAMPLES.map((example) => (
                        <button
                          key={example.label}
                          type="button"
                          onClick={() => useExample(example.prompt)}
                          className="shrink-0 rounded-md px-2.5 py-1.5 text-[11px] text-[var(--color-ink-dim)] transition-colors hover:bg-[var(--color-panel-hi)] hover:text-[var(--color-ink)]"
                        >
                          {example.label}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={addTask}
                        className="shrink-0 rounded-md px-2.5 py-1.5 text-[11px] text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)]/10"
                      >
                        + add to series
                      </button>
                    </div>
                  </div>
                </div>

                {/* Run row */}
                <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <p id="prompt-error" className="hidden text-[11px] text-red-400" role="alert" />
                  <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto sm:flex-nowrap">
                    <button
                      type="button"
                      onClick={toggleBlind}
                      className={`control-surface flex min-h-11 flex-1 items-center justify-center gap-2 px-3 text-[11px] sm:flex-none ${
                        blind.enabled && !blind.revealed ? '!border-[var(--color-accent)]/40 !text-[var(--color-accent)]' : ''
                      }`}
                      title="Hide which panel has ACC until you reveal. Cards are shuffled so you judge quality without knowing who wrote what. Shortcut: B"
                      aria-pressed={blind.enabled}
                    >
                      <Icon name={blind.enabled && !blind.revealed ? 'eye-off' : 'eye'} className="size-4" />
                      <span>{blind.enabled ? (blind.revealed ? 'Blind: revealed' : 'Blind: on') : 'Blind comparison'}</span>
                      <kbd className="key-hint">B</kbd>
                    </button>
                    <button
                      id="run-btn"
                      onClick={startBattle}
                      disabled={!repo || battleStatus === 'running'}
                      className="action-primary group flex min-h-11 flex-1 shrink-0 items-center justify-center gap-2 px-5 text-[13px] font-semibold sm:w-auto sm:flex-none"
                    >
                      <Icon name={battleStatus === 'running' ? 'refresh' : 'play'} className={`size-4 ${battleStatus === 'running' ? 'spin' : ''}`} />
                      <span id="run-label">{battleStatus === 'running' ? 'Running…' : 'Run battle'}</span>
                      <kbd className="key-hint key-hint-inverse">⌘↵</kbd>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* ============================ RESULTS ============================ */}
          <section className="results-stage pt-7 sm:pt-9" aria-labelledby="results-title">
            <header className="flex min-h-11 flex-wrap items-center justify-between gap-3">
              <h2 id="results-title" className="font-pixel text-[14px] tracking-[0.04em] text-[var(--color-ink)]">
                Results
              </h2>
              {results.length > 0 && (
                <div className="result-toolbar flex w-fit max-w-full flex-wrap items-center justify-between gap-1 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]/90 p-1 shadow-xl backdrop-blur" aria-label="Result controls">
                  <div className="flex min-w-0 flex-1 items-center gap-1">
                    <div className="inline-flex shrink-0" role="tablist" aria-label="View mode">
                      <button
                        role="tab"
                        aria-controls="results"
                        data-on={viewMode === 'answer'}
                        aria-selected={viewMode === 'answer'}
                        className="view-tab flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] text-[var(--color-ink-dim)] transition-colors sm:px-3"
                        onClick={() => setViewMode('answer')}
                      >
                        <Icon name="text" className="size-4" />
                        <span className="hidden sm:inline">Answer</span>
                      </button>
                      <button
                        role="tab"
                        aria-controls="results"
                        data-on={viewMode === 'code'}
                        aria-selected={viewMode === 'code'}
                        className="view-tab flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] text-[var(--color-ink-dim)] transition-colors sm:px-3"
                        onClick={() => setViewMode('code')}
                      >
                        <Icon name="code" className="size-4" />
                        <span className="hidden sm:inline">Code</span>
                      </button>
                    </div>
                    <button
                      onClick={toggleBlind}
                      className={`flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] transition-colors hover:bg-[var(--color-panel-hi)] hover:text-[var(--color-ink)] ${
                        blind.enabled && !blind.revealed ? 'text-[var(--color-accent)]' : 'text-[var(--color-ink-dim)]'
                      }`}
                      title="Hide which panel has ACC until you reveal. Shortcut: B"
                      aria-pressed={blind.enabled}
                    >
                      <Icon name={blind.enabled && !blind.revealed ? 'eye-off' : 'eye'} className="size-4" />
                      <span>Blind</span>
                    </button>
                    {blind.enabled && !blind.revealed && (
                      <button
                        onClick={reveal}
                        className="flex min-h-9 items-center gap-1.5 rounded-lg border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-3 text-[12px] text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)]/15"
                      >
                        <Icon name="eye" className="size-4" />
                        <span>Reveal</span>
                      </button>
                    )}
                    <span className="ml-2 hidden text-[11px] tabular-nums text-[var(--color-ink-dim)]" role="status" aria-live="polite">
                      {battleStatus === 'running' && 'battle running…'}
                      {battleStatus === 'done' && 'battle complete'}
                      {battleStatus === 'stopped' && 'stopped'}
                    </span>
                  </div>
                </div>
              )}
            </header>

            <section
              id="results"
              role="tabpanel"
              aria-label="Model results"
              className="grid flex-1 content-start gap-4 py-4 sm:py-5 grid-cols-[repeat(auto-fill,minmax(min(22rem,100%),1fr))]"
            >
              {results.length === 0 && (
                <div id="empty-state" className="col-span-full flex items-center gap-3 rounded-xl border border-dashed border-[var(--color-line)] px-4 py-5 text-[12px] text-[var(--color-ink-faint)]">
                  <Icon name="vs" className="size-4 shrink-0" />
                  <p>Load a repository and run a battle to compare ACC vs no-ACC here.</p>
                </div>
              )}

              {results.map((r, i) => {
                const donePanels = displayOrder
                  .map((p) => ({ id: p.id, ...r.panels[p.id] }))
                  .filter((x) => x && x.status === 'done');
                const winners = computeWinners(donePanels);
                return (
                  <React.Fragment key={i}>
                    {/* task heading spans the full row */}
                    <div className="col-span-full mt-2 flex items-baseline gap-2.5 first:mt-0">
                      <span className="font-pixel text-[11px] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">
                        task {i + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-ink)]">{r.task.title}</span>
                      {winners.size > 0 && (
                        <span className="hidden shrink-0 items-center gap-1.5 text-[10px] text-[var(--color-ink-faint)] sm:flex">
                          <Icon name="trophy" className="size-3.5 text-[var(--color-accent)]" />
                          <span>
                            {[...winners.entries()]
                              .filter(([, w]) => Object.values(w).some(Boolean))
                              .map(([pid, w]) => {
                                const labels = Object.entries(w)
                                  .filter(([, v]) => v)
                                  .map(([k]) => k)
                                  .join(', ');
                                return (
                                  <span key={pid} className={pid === 'acc' ? 'text-[var(--color-accent)]' : 'text-[var(--color-ink-dim)]'}>
                                    {blind.enabled && !blind.revealed ? aliasFor(pid) : pid === 'acc' ? 'ACC' : 'no-ACC'} · {labels}
                                  </span>
                                );
                              })
                              .reduce((acc, el, idx) => [acc, idx > 0 ? '  ' : '', el], [])}
                          </span>
                        </span>
                      )}
                    </div>
                    {displayOrder.map((p) => (
                      <ResultCard
                        key={p.id}
                        panel={p}
                        result={r.panels[p.id]}
                        context={p.acc ? repo?.accContext : repo?.baseContext}
                        viewMode={viewMode}
                        onViewMode={setViewMode}
                        blind={blind.enabled && !blind.revealed}
                        alias={aliasFor(p.id)}
                        best={winners.get(p.id)}
                      />
                    ))}
                    <div className="col-span-full">
                      <Timeline panels={displayOrder} panelsResult={r.panels} />
                    </div>
                  </React.Fragment>
                );
              })}
            </section>
          </section>

          {/* ============================ SUMMARY ============================ */}
          {summary && (
            <section id="battle-summary" className="mb-6 overflow-hidden">
              <header className="flex flex-wrap items-center gap-3 border-b border-[var(--color-line)] px-4 py-3.5 sm:px-5">
                <Icon name="trophy" className="size-4 text-[var(--color-accent)]" />
                <div>
                  <h2 className="font-pixel text-[11px] uppercase tracking-[0.14em] text-[var(--color-ink)]">Battle analysis</h2>
                  <p className="mt-0.5 text-[10px] text-[var(--color-ink-faint)]">Heuristic comparison — ACC vs no-ACC, normalized side by side</p>
                </div>
              </header>
              <div className="scroll-affordance">
                <div id="battle-summary-list" className="overflow-x-auto">
                  <table className="w-full min-w-[42rem] text-left text-[11px]">
                    <thead>
                      <tr className="border-b border-[var(--color-line)] text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-faint)]">
                        <th className="px-4 py-2.5 font-normal">Metric</th>
                        <th className="px-4 py-2.5 font-normal">ACC</th>
                        <th className="px-4 py-2.5 font-normal">no-ACC</th>
                        <th className="px-4 py-2.5 text-right font-normal">Tasks</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b border-[var(--color-line)]">
                        <td className="px-4 py-2.5 text-[var(--color-ink-dim)]">Avg time</td>
                        <td className="px-4 py-2.5 font-mono tabular-nums text-[var(--color-ink)]">{fmtDur(summary.time.acc)}</td>
                        <td className="px-4 py-2.5 font-mono tabular-nums text-[var(--color-ink)]">{fmtDur(summary.time.plain)}</td>
                        <td className="px-4 py-2.5 text-right text-[var(--color-ink-faint)]">{summary.total}</td>
                      </tr>
                      <tr className="border-b border-[var(--color-line)]">
                        <td className="px-4 py-2.5 text-[var(--color-ink-dim)]">Avg tokens</td>
                        <td className="px-4 py-2.5 font-mono tabular-nums text-[var(--color-ink)]">{fmtInt(summary.tokens.acc)}</td>
                        <td className="px-4 py-2.5 font-mono tabular-nums text-[var(--color-ink)]">{fmtInt(summary.tokens.plain)}</td>
                        <td className="px-4 py-2.5 text-right text-[var(--color-ink-faint)]">{summary.total}</td>
                      </tr>
                      <tr className="border-b border-[var(--color-line)]">
                        <td className="px-4 py-2.5 text-[var(--color-ink-dim)]">Avg estimated cost</td>
                        <td className="px-4 py-2.5 font-mono tabular-nums text-[var(--color-ink)]">{fmtCost(summary.cost.acc)}</td>
                        <td className="px-4 py-2.5 font-mono tabular-nums text-[var(--color-ink)]">{fmtCost(summary.cost.plain)}</td>
                        <td className="px-4 py-2.5 text-right text-[var(--color-ink-faint)]">{summary.total}</td>
                      </tr>
                      <tr className="border-b border-[var(--color-line)]">
                        <td className="px-4 py-2.5 text-[var(--color-ink-dim)]">Heuristic passes</td>
                        <td className="px-4 py-2.5 font-mono tabular-nums text-[var(--color-ink)]">{summary.success.acc}/{summary.total}</td>
                        <td className="px-4 py-2.5 font-mono tabular-nums text-[var(--color-ink)]">{summary.success.plain}/{summary.total}</td>
                        <td className="px-4 py-2.5 text-right text-[var(--color-ink-faint)]">{summary.total}</td>
                      </tr>
                      <tr>
                        <td className="px-4 py-3 font-medium text-[var(--color-ink)]">Verdict</td>
                        <td colSpan="3" className="px-4 py-3">
                          <span
                            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] ${
                              summary.accWins > summary.total / 2
                                ? 'border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
                                : summary.accWins < summary.total / 2
                                  ? 'border-red-500/30 bg-red-500/10 text-red-400'
                                  : 'border-[var(--color-line)] text-[var(--color-ink-dim)]'
                            }`}
                          >
                            <Icon name="trophy" className="size-3.5" />
                            {summary.accWins > summary.total / 2
                              ? `ACC ahead — ${summary.accWins}/${summary.total} tasks better`
                              : summary.accWins < summary.total / 2
                                ? `no-ACC ahead — ${summary.total - summary.accWins}/${summary.total} tasks better`
                                : `tie — ${summary.accWins}/${summary.total}`}
                          </span>
                          <button onClick={handleSaveReport} className="ml-3 control-surface px-3 py-1.5 text-[11px]">
                            💾 Save report
                          </button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}
        </main>

        {/* ============================== FOOTER ============================== */}
        <footer className="mt-auto flex flex-col items-start gap-3 border-t border-[var(--color-line)] py-5 text-[11px] text-[var(--color-ink-faint)] sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-center gap-1.5">
            <span className="font-pixel text-[13px] font-semibold text-[var(--color-accent)]">acc</span>
            <span>Agent Code Context · Battle Arena — battle UI adapted from</span>
            <Icon name="heart" className="size-3.5 text-[var(--color-accent)]" />
            <a href="https://github.com/midudev/isbetter.ai" target="_blank" rel="noopener" className="text-[var(--color-ink-dim)] underline-offset-2 transition-colors hover:text-[var(--color-ink)] hover:underline">
              isbetter.ai
            </a>
            <span>by midudev</span>
          </span>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:justify-end">
            <a href="https://github.com/EnzoVezzaro/agents-code-context" target="_blank" rel="noopener" className="underline-offset-2 transition-colors hover:text-[var(--color-ink-dim)] hover:underline">
              GitHub
            </a>
            <span className="hidden border-l border-[var(--color-line-hi)] pl-4 lg:inline">
              Keys and prompts stay in your browser
            </span>
          </div>
        </footer>
      </div>

      {/* ============================ KEY MODAL ============================ */}
      <KeyModal open={keyModal} onClose={() => setKeyModal(false)} onSaved={() => refreshModels()} />

      {/* ========================= HISTORY DRAWER ========================= */}
      <HistoryDrawer
        open={historyOpen}
        history={history}
        onClose={() => setHistoryOpen(false)}
        onClear={clearHistory}
      />
    </div>
  );
}
