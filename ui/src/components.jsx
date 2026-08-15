import React, { useEffect, useState } from 'react';
import { PROVIDERS, getProvider, loadKeys, saveKey } from './providers.js';
import {
  fmtDur,
  fmtInt,
  fmtCost,
  fmtRate,
  estTokens,
  extractCode,
  extractAnswer,
} from './arena.js';

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

export function dotColor(state) {
  if (state === 'loading' || state === 'running' || state === 'streaming')
    return 'bg-[var(--color-accent)] animate-pulse';
  if (state === 'error') return 'bg-red-500';
  return 'bg-emerald-400';
}

export function ResultCard({ panel, result, context, viewMode, onViewMode, blind, alias, best }) {
  const provider = getProvider(panel.provider);
  const name = blind ? alias : `${provider.label} · ${panel.model}`;
  const state = result?.status || 'pending';
  const code = result?.output ? extractCode(result.output) : '';
  const answer = result?.output ? extractAnswer(result.output) : '';
  const elapsed = state === 'running' ? Date.now() - (result._startedAt || Date.now()) : result?.timeMs || 0;

  return (
    <article
      className={`result-card flex flex-col overflow-hidden rounded-2xl border bg-[var(--color-panel)] ${
        panel.acc ? 'border-[var(--color-accent)]/45 shadow-[0_0_0_1px_var(--color-accent)/15,0_10px_30px_-18px_var(--color-accent)/35]' : 'border-[var(--color-line)]'
      }`}
    >
      {/* header */}
      <div className="flex min-h-12 items-center gap-2 border-b border-[var(--color-line)] px-3.5 py-2.5">
        <span className={`size-2 shrink-0 rounded-full ${dotColor(state)}`} aria-hidden="true" />
        <span className="sr-only">{state}</span>
        {!blind && (
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
        {panel.acc && (
          <span className="inline-flex items-center gap-1 rounded-md bg-[var(--color-accent)] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-black">
            <Icon name="sparkles" className="size-3" />
            framework
          </span>
        )}
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

export function HistoryDrawer({ open, history, onClose, onClear }) {
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
