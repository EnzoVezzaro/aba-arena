import React, { useEffect, useState } from 'react';
import { githubMe, githubRepos } from './api.js';
import { PROVIDERS, getProvider, loadKeys, saveKey } from './providers.js';
import {
  fmtDur,
  fmtInt,
  fmtCost,
  fmtRate,
  estTokens,
  extractAnswer,
} from './arena.js';
import CodeSandbox from './CodeSandbox.jsx';

/* ------------------------------------------------------------------------ */
/* Shared constants + localStorage helpers                                   */
/* ------------------------------------------------------------------------ */

export const DEFAULT_SYSTEM =
  'You are a senior software engineer benchmarking how well an AI coding agent ' +
  'understands a repository. You are given repository context and a task. Respond ' +
  'concisely and concretely — name specific files, modules, and conventions. Include ' +
  'code where the task asks for it.';

export const TASK_EXAMPLES = [
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

export const HISTORY_KEY = 'aba.history.v1';
export const PENDING_BATTLE_KEY = 'aba.pendingBattle.v1';
export const MAX_HISTORY = 20;

export function makePanel(id, acc, label) {
  return { id, acc, label, provider: 'openai', model: 'gpt-4o', apiKey: '' };
}

export const INITIAL_PANELS = [
  makePanel('acc', true, 'ACC — acc-agents installed'),
  makePanel('plain', false, 'No ACC — plain repository'),
];

export function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

export function saveHistory(history) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
}

export function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/* ------------------------------------------------------------------------ */
/* Icon (isbetter.ai sprite <use>)                                          */
/* ------------------------------------------------------------------------ */

export function Icon({ name, className = 'size-4' }) {
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

export function MetricPills({ result, best }) {
  if (!result || (result.status !== 'done' && result.status !== 'running')) return null;
  const isBest = (k) => best && best[k];
  const gen = result.genMs != null ? result.genMs : result.durationMs;
  const tput = gen > 0 ? (result.outputTokens || 0) / (gen / 1000) : 0;
  const live = result.status === 'running';
  const totalMs = result.timeMs != null ? result.timeMs : result.durationMs;
  const pills = [
    { icon: 'i-bolt', key: 'fast', label: 'total time — request to finish', value: totalMs != null ? fmtDur(totalMs) : live ? '…' : '—', best: isBest('fast') },
    { icon: 'i-clock', key: 'ttft', label: 'time to first token', value: result.ttftMs != null ? fmtDur(result.ttftMs) : live ? '…' : '—', best: isBest('ttft') },
    { icon: 'i-clock-bolt', key: 'gen', label: 'generation time — first to last token', value: live ? '—' : gen != null ? fmtDur(gen) : '—', best: isBest('gen') },
    { icon: 'i-down', key: 'in', label: 'input tokens', value: result.inputTokens != null ? `${fmtInt(result.inputTokens)}${live ? ' est.' : ''}` : live ? fmtInt(estTokens(result.output)) : '—', best: false },
    { icon: 'i-up', key: 'out', label: 'output tokens', value: result.outputTokens != null ? `${fmtInt(result.outputTokens)}${live ? ' est.' : ''}` : live ? fmtInt(estTokens(result.output)) : '—', best: false },
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

export function dotColor(state) {
  if (state === 'loading' || state === 'running' || state === 'streaming')
    return 'bg-[var(--color-accent)] animate-pulse';
  if (state === 'error') return 'bg-red-500';
  return 'bg-emerald-400';
}

export function ResultCard({ panel, result, context, viewMode, onViewMode, blind, alias, best, repoName }) {
  const provider = getProvider(panel.provider);
  // Hidden identity = blind is enabled and not yet revealed.
  const hidden = blind?.enabled && !blind?.revealed;
  const name = hidden ? alias : `${provider.label} · ${panel.model}`;
  const state = result?.status || 'pending';
  const answer = result?.output ? extractAnswer(result.output) : '';
  const elapsed = state === 'running' ? Date.now() - (result._startedAt || Date.now()) : result?.timeMs || 0;
  // In blind mode the ACC identity stays hidden: no accent highlight on the
  // ACC card, and the sandbox Code view (which would expose the .acc install)
  // is locked until the battle is revealed.
  const locked = !!hidden;
  const effectiveView = locked ? 'answer' : viewMode;

  return (
    <article
      className={`result-card flex flex-col overflow-hidden rounded-2xl border bg-[var(--color-panel)] ${
        !locked && panel.acc ? 'border-[var(--color-accent)]/45 shadow-[0_0_0_1px_var(--color-accent)/15,0_10px_30px_-18px_var(--color-accent)/35]' : 'border-[var(--color-line)]'
      }`}
    >
      {/* header */}
      <div className="flex min-h-12 items-center gap-2 border-b border-[var(--color-line)] px-3.5 py-2.5">
        <span className={`size-2 shrink-0 rounded-full ${dotColor(state)}`} aria-hidden="true" />
        <span className="sr-only">{state}</span>
        {!hidden && (
          <span
            className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-pixel text-[9px] uppercase tracking-[0.14em] ${
              panel.acc
                ? 'border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                : 'border border-[var(--color-line-hi)] bg-[var(--color-panel-hi)] text-[var(--color-ink-dim)]'
            }`}
          >
            {panel.acc ? 'ACC' : 'no-ACC'}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--color-ink)]" title={hidden ? '' : panel.model}>
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
          <>
            <div className="flex items-center gap-1 border-b border-[var(--color-line)] px-3 py-1.5">
              <button
                data-on={effectiveView === 'answer'}
                className="view-tab flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] text-[var(--color-ink-dim)] transition-colors"
                onClick={() => onViewMode('answer')}
                aria-selected={effectiveView === 'answer'}
              >
                <Icon name="text" className="size-4" />
                <span>Answer</span>
              </button>
              {!locked && (
                <button
                  data-on={effectiveView === 'code'}
                  className="view-tab flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] text-[var(--color-ink-dim)] transition-colors"
                  onClick={() => onViewMode('code')}
                  aria-selected={effectiveView === 'code'}
                >
                  <Icon name="code" className="size-4" />
                  <span>Code</span>
                </button>
              )}
            </div>
            <div className="h-[calc(100%-2.5rem)]">
              {effectiveView === 'code' ? (
                <CodeSandbox panel={panel} repoName={repoName} />
              ) : (
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
            </div>
          </>
        )}
        {state === 'done' && (
          <>
            <div className="flex items-center gap-1 border-b border-[var(--color-line)] px-3 py-1.5">
              <button
                data-on={effectiveView === 'answer'}
                className="view-tab flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] text-[var(--color-ink-dim)] transition-colors"
                onClick={() => onViewMode('answer')}
                aria-selected={effectiveView === 'answer'}
              >
                <Icon name="text" className="size-4" />
                <span>Answer</span>
              </button>
              {!locked && (
                <button
                  data-on={effectiveView === 'code'}
                  className={`view-tab flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] text-[var(--color-ink-dim)] transition-colors`}
                  onClick={() => onViewMode('code')}
                  aria-selected={effectiveView === 'code'}
                >
                  <Icon name="code" className="size-4" />
                  <span>Code</span>
                </button>
              )}
            </div>
            <div className="h-[calc(100%-2.5rem)]">
              {effectiveView === 'code' ? (
                // Code view = the panel's sandbox: real repository files
                // (including the agent's edits), browsable live.
                <CodeSandbox panel={panel} repoName={repoName} />
              ) : (
                <div className="h-full overflow-auto p-3.5 text-[12px] leading-relaxed text-[var(--color-ink-dim)]">
                  <div className="whitespace-pre-wrap break-words">{answer || result.output}</div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------------ */
/* Searchable select — text filter + keyboard nav (used for providers and    */
/* models, which can be 300+ entries).                                      */
/* ------------------------------------------------------------------------ */

export function SearchSelect({ value, options, onChange, placeholder = 'Search…', ariaLabel }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const rootRef = React.useRef(null);

  const filtered = query
    ? options.filter((o) => o.toLowerCase().includes(query.toLowerCase()))
    : options;

  useEffect(() => {
    const onDown = (e) => {
      if (!open) return;
      if (e.key === 'Escape') {
        setOpen(false);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[highlight]) {
          onChange(filtered[highlight]);
          setOpen(false);
          setQuery('');
        }
      }
    };
    window.addEventListener('keydown', onDown);
    return () => window.removeEventListener('keydown', onDown);
  }, [open, filtered, highlight, onChange]);

  useEffect(() => {
    const onOut = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onOut);
    return () => document.removeEventListener('mousedown', onOut);
  }, []);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="arena-select flex min-h-9 w-full items-center justify-between gap-2 rounded-lg border border-[var(--color-line)] px-2.5 text-left text-[12px] text-[var(--color-ink)] outline-none transition-colors hover:border-[var(--color-line-hi)] focus:border-[var(--color-accent)]/50"
      >
        <span className="min-w-0 flex-1 truncate">{value || placeholder}</span>
        <Icon name="chevron" className={`size-3.5 shrink-0 text-[var(--color-ink-faint)] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-[var(--color-line-hi)] bg-[var(--color-panel)] shadow-xl">
          <div className="flex items-center gap-1.5 border-b border-[var(--color-line)] px-2.5">
            <Icon name="search" className="size-3.5 shrink-0 text-[var(--color-ink-faint)]" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(0);
              }}
              placeholder={placeholder}
              spellCheck="false"
              className="min-h-9 w-full bg-transparent text-[12px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)]"
            />
          </div>
          <div className="no-scrollbar max-h-56 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <p className="px-3 py-2 text-[11px] text-[var(--color-ink-faint)]">no matches</p>
            )}
            {filtered.map((o, i) => (
              <button
                key={o}
                type="button"
                onMouseEnter={() => setHighlight(i)}
                onClick={() => {
                  onChange(o);
                  setOpen(false);
                  setQuery('');
                }}
                className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12px] transition-colors ${
                  i === highlight ? 'bg-[var(--color-panel-hi)] text-[var(--color-ink)]' : 'text-[var(--color-ink-dim)]'
                }`}
              >
                <span className="min-w-0 truncate">{o}</span>
                {o === value && <Icon name="check" className="size-3.5 shrink-0 text-[var(--color-accent)]" />}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Composer panel config (isbetter.ai panel-premium) — ACC panel first +     */
/* highlighted so the framework side is always the benchmark reference.      */
/* ------------------------------------------------------------------------ */

export function PanelConfig({ panel, onPanel, liveModels, modelsLoading }) {
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
          ? 'border-[var(--color-accent)]/40 bg-[var(--color-accent)]/[0.05] shadow-[0_0_0_1px_var(--color-accent)/15,0_10px_30px_-18px_var(--color-accent)/30]'
          : 'border-[var(--color-line)] bg-[var(--color-panel)]'
      }`}
    >
      <div className="mb-2.5 flex items-center gap-2">
        <span
          className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-pixel text-[9px] uppercase tracking-[0.14em] ${
            panel.acc
              ? 'border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
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
          <SearchSelect
            value={getProvider(effectiveProvider).label}
            options={available.map((p) => p.label)}
            placeholder="Select provider…"
            ariaLabel="Select AI provider"
            onChange={(label) => {
              const next = available.find((p) => p.label === label)?.id || effectiveProvider;
              const live = liveModels[next] && liveModels[next].length ? liveModels[next] : getProvider(next).models;
              onPanel({ ...panel, provider: next, model: live[0] || '' });
            }}
          />
        </label>
        <label className="block">
          <span className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-faint)]">
            Model
            {loading && <span className="inline-block size-3 rounded-full border-2 border-[var(--color-line-hi)] border-t-[var(--color-accent)] spin" />}
          </span>
          <SearchSelect
            value={panel.model}
            options={models}
            placeholder="Select model…"
            ariaLabel="Select model"
            onChange={(m) => onPanel({ ...panel, model: m })}
          />
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
/* Settings — AI provider picker, GitHub account connection (repo            */
/* suggestions), and data export/import/clear.                               */
/* ------------------------------------------------------------------------ */

export const GITHUB_KEY = 'aba.github.v1';
export const SETTINGS_KEY = 'aba.settings.v1';

export function loadGithub() {
  try {
    return JSON.parse(localStorage.getItem(GITHUB_KEY) || 'null') || { token: '', login: '', repos: [] };
  } catch {
    return { token: '', login: '', repos: [] };
  }
}

export function saveGithub(g) {
  localStorage.setItem(GITHUB_KEY, JSON.stringify(g));
}

/** Export every ABA localStorage key as a downloadable JSON file. */
export function exportData() {
  const data = {
    exportedAt: new Date().toISOString(),
    app: 'acc-battle-arena',
    data: {},
  };
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('aba.')) data.data[k] = localStorage.getItem(k);
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `aba-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Import an ABA export file: restore keys/history/pending battle. */
export async function importData(file) {
  const text = await file.text();
  const parsed = JSON.parse(text);
  const entries = parsed?.data && typeof parsed.data === 'object' ? parsed.data : parsed;
  let count = 0;
  for (const [k, v] of Object.entries(entries)) {
    if (k.startsWith('aba.')) {
      localStorage.setItem(k, String(v));
      count++;
    }
  }
  return count;
}

/** Clear all ABA data from this browser (keys, history, pending battle). */
export function clearLocalData() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith('aba.')) keys.push(k);
  }
  keys.forEach((k) => localStorage.removeItem(k));
  return keys.length;
}

export function SettingsModal({ open, onClose, onDataChanged }) {
  const [keys] = useState(loadKeys);
  const [provider, setProvider] = useState(() => PROVIDERS.find((p) => p.needsKey)?.id || 'openai');
  const [keyDraft, setKeyDraft] = useState('');
  const [ghToken, setGhToken] = useState('');
  const [gh, setGh] = useState(loadGithub);
  const [ghBusy, setGhBusy] = useState(false);
  const [ghError, setGhError] = useState('');
  const [ghOk, setGhOk] = useState('');
  const [dataMsg, setDataMsg] = useState('');
  const fileRef = React.useRef(null);

  useEffect(() => {
    if (open) {
      setGh(loadGithub());
      setGhToken(loadGithub().token);
      setDataMsg('');
    }
  }, [open]);

  if (!open) return null;

  async function connectGithub() {
    const token = ghToken.trim();
    if (!token) {
      setGhError('Paste a GitHub personal access token first.');
      return;
    }
    setGhBusy(true);
    setGhError('');
    setGhOk('');
    try {
      const me = await githubMe(token);
      const repos = await githubRepos(token);
      const next = { token, login: me.login || me.name || 'connected', repos };
      saveGithub(next);
      setGh(next);
      setGhOk(`Connected as ${me.login} — ${repos.length} repos available as suggestions.`);
      if (onDataChanged) onDataChanged();
    } catch (err) {
      setGhError(err.message);
    } finally {
      setGhBusy(false);
    }
  }

  function disconnectGithub() {
    const next = { token: '', login: '', repos: [] };
    saveGithub(next);
    setGh(next);
    setGhToken('');
    setGhOk('Disconnected.');
    if (onDataChanged) onDataChanged();
  }

  async function handleExport() {
    exportData();
    setDataMsg('Exported — check your downloads.');
  }

  async function handleImport(file) {
    try {
      const n = await importData(file);
      setDataMsg(`Imported ${n} keys — reloading…`);
      setTimeout(() => window.location.reload(), 800);
    } catch (err) {
      setDataMsg(`Import failed: ${err.message}`);
    }
  }

  async function handleClear() {
    if (!window.confirm('Delete ALL data in this browser (API keys, history, pending battle)? This cannot be undone.')) return;
    const n = clearLocalData();
    setDataMsg(`Cleared ${n} items — reloading…`);
    setTimeout(() => window.location.reload(), 600);
  }

  return (
    <div id="settings-modal" className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <div id="settings-backdrop" className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={onClose} />
      <div className="panel-premium absolute left-1/2 top-1/2 max-h-[min(88vh,720px)] w-[min(94vw,560px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-5 shadow-2xl sm:p-6">
        <div className="flex items-center gap-2.5">
          <span className="grid size-10 place-items-center rounded-xl bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
            <Icon name="bolt" className="size-5" />
          </span>
          <div className="flex-1">
            <h2 id="settings-title" className="text-[14px] font-medium text-[var(--color-ink)]">
              Settings
            </h2>
            <p className="mt-0.5 text-[11px] text-[var(--color-ink-faint)]">Providers, GitHub account and local data.</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="grid size-8 place-items-center rounded-md text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-line)] hover:text-[var(--color-ink)]"
          >
            <Icon name="x" className="size-4" />
          </button>
        </div>

        {/* ---- AI provider ---- */}
        <section className="mt-5">
          <h3 className="font-pixel text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-dim)]">AI provider</h3>
          <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-faint)]">Provider</span>
              <SearchSelect
                value={getProvider(provider).label}
                options={PROVIDERS.filter((p) => p.needsKey).map((p) => p.label)}
                placeholder="Select provider…"
                ariaLabel="Select AI provider for settings"
                onChange={(label) => {
                  const p = PROVIDERS.find((x) => x.label === label);
                  setProvider(p ? p.id : provider);
                  setKeyDraft(keys[p ? p.id : provider] || '');
                }}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-faint)]">
                API key {keys[provider] ? '(saved)' : ''}
              </span>
              <div className="control-surface flex items-center gap-2 px-3 focus-within:border-[var(--color-accent)]/45">
                <input
                  type="password"
                  placeholder={`${getProvider(provider).label} API key…`}
                  autoComplete="off"
                  spellCheck="false"
                  value={keyDraft}
                  onChange={(e) => setKeyDraft(e.target.value)}
                  className="w-full bg-transparent py-2.5 font-mono text-[12px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)]"
                />
              </div>
            </label>
          </div>
          <button
            className="action-primary mt-2.5 flex items-center gap-1.5 px-3.5 py-2 text-[11px] font-semibold"
            onClick={() => {
              if (!keyDraft.trim()) return;
              saveKey(provider, keyDraft.trim());
              setDataMsg('API key saved.');
              if (onDataChanged) onDataChanged();
            }}
          >
            <Icon name="key" className="size-3.5" />
            <span>Save key</span>
          </button>
        </section>

        {/* ---- GitHub account ---- */}
        <section className="mt-5">
          <h3 className="font-pixel text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-dim)]">GitHub account</h3>
          {gh.login ? (
            <div className="mt-2.5 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-[12px] text-[var(--color-ink)]">
                  <Icon name="check" className="size-4 text-emerald-400" />
                  <strong>{gh.login}</strong>
                </span>
                <button
                  onClick={disconnectGithub}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[var(--color-ink-faint)] transition-colors hover:text-red-400"
                >
                  <Icon name="x" className="size-3.5" />
                  disconnect
                </button>
              </div>
              <p className="mt-1.5 text-[11px] text-[var(--color-ink-faint)]">
                {gh.repos.length} repos available — type in the repository box and your repos show as suggestions.
              </p>
            </div>
          ) : (
            <div className="mt-2.5">
              <div className="control-surface flex items-center gap-2 px-3 focus-within:border-[var(--color-accent)]/45">
                <Icon name="link" className="size-4 shrink-0 text-[var(--color-ink-faint)]" />
                <input
                  type="password"
                  placeholder="GitHub personal access token (classic · repo, or fine-grained read-only)…"
                  autoComplete="off"
                  spellCheck="false"
                  value={ghToken}
                  onChange={(e) => setGhToken(e.target.value)}
                  className="w-full bg-transparent py-2.5 font-mono text-[12px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)]"
                />
              </div>
              <button
                onClick={connectGithub}
                disabled={ghBusy}
                className="action-primary mt-2.5 flex items-center gap-1.5 px-3.5 py-2 text-[11px] font-semibold disabled:opacity-60"
              >
                <Icon name={ghBusy ? 'refresh' : 'link'} className={`size-3.5 ${ghBusy ? 'spin' : ''}`} />
                <span>{ghBusy ? 'connecting…' : 'Connect GitHub'}</span>
              </button>
            </div>
          )}
          {ghError && <p className="mt-2 flex items-start gap-1.5 text-[11px] text-red-400"><Icon name="alert" className="mt-0.5 size-3.5 shrink-0" />{ghError}</p>}
          {ghOk && <p className="mt-2 flex items-start gap-1.5 text-[11px] text-emerald-400"><Icon name="check" className="mt-0.5 size-3.5 shrink-0" />{ghOk}</p>}
          <p className="mt-2 text-[10px] leading-relaxed text-[var(--color-ink-faint)]">
            Create one at github.com/settings/tokens (classic, scope <code>repo</code>) or a fine-grained token with read-only
            contents. It only lists your repositories — never sent anywhere but GitHub.
          </p>
        </section>

        {/* ---- Data ---- */}
        <section className="mt-5">
          <h3 className="font-pixel text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-dim)]">Data</h3>
          <div className="mt-2.5 grid grid-cols-3 gap-2">
            <button
              onClick={handleExport}
              className="flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-line)] px-2 text-[11px] text-[var(--color-ink-dim)] transition-colors hover:border-[var(--color-line-hi)] hover:text-[var(--color-ink)]"
            >
              <Icon name="down" className="size-3.5" />
              Export
            </button>
            <button
              onClick={() => fileRef.current?.click()}
              className="flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-line)] px-2 text-[11px] text-[var(--color-ink-dim)] transition-colors hover:border-[var(--color-line-hi)] hover:text-[var(--color-ink)]"
            >
              <Icon name="up" className="size-3.5" />
              Load
            </button>
            <button
              onClick={handleClear}
              className="flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-red-500/25 px-2 text-[11px] text-red-400/90 transition-colors hover:border-red-500/50 hover:text-red-400"
            >
              <Icon name="trash" className="size-3.5" />
              Clear
            </button>
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => e.target.files?.[0] && handleImport(e.target.files[0])} />
          </div>
          {dataMsg && <p className="mt-2 text-[11px] text-[var(--color-ink-dim)]">{dataMsg}</p>}
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Key modal (isbetter.ai API key modal)                                     */
/* ------------------------------------------------------------------------ */

export function KeyModal({ open, onClose, onSaved }) {
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

export function HistoryDrawer({ open, history, onClose, onClear, onDelete }) {
  const [deleting, setDeleting] = useState(null); // history id currently being removed
  if (!open) return null;
  async function remove(h) {
    setDeleting(h.id);
    try {
      if (onDelete) await onDelete(h);
    } finally {
      setDeleting(null);
    }
  }
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
            <p className="text-[11px] text-[var(--color-ink-faint)]">stored locally · deleting a run also removes its sandboxes</p>
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
                    <button
                      onClick={() => remove(h)}
                      disabled={deleting === h.id}
                      aria-label={`Delete this battle (${h.repoName})`}
                      title="delete this run — also removes its sandboxes"
                      className="grid size-7 shrink-0 place-items-center rounded-md text-[var(--color-ink-faint)] transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50"
                    >
                      <Icon name={deleting === h.id ? 'refresh' : 'trash'} className={`size-3.5 ${deleting === h.id ? 'spin' : ''}`} />
                    </button>
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
