import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { githubMe, githubRepos } from './api.js';
import { PROVIDERS, getProvider, loadKeys, saveKey, isFreeModel, modelIdList, modelTools } from './providers.js';
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
/* Motion — overlay enter/exit transitions                                   */
/* ------------------------------------------------------------------------ */

/**
 * Keep an overlay (modal/drawer) mounted through its EXIT animation. Returns
 * `{ mounted, visible }`: `visible` flips true one frame after opening so the
 * CSS transition plays; on close it flips false and the overlay unmounts
 * after `duration` ms. Reduced motion is handled globally in styles.css.
 */
export function useOverlay(open, duration = 200) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const t = setTimeout(() => setMounted(false), duration);
    return () => clearTimeout(t);
  }, [open, duration]);
  return { mounted, visible };
}

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
  'i-check': 'text-emerald-400',
  'i-brain': 'text-violet-400',
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
    { icon: 'i-down', key: 'in', label: 'input tokens', value: result.inputTokens != null ? `${fmtInt(result.inputTokens)}${result.tokensEstimated || live ? ' est.' : ''}` : live ? fmtInt(estTokens(result.output)) : '—', best: false },
    { icon: 'i-up', key: 'out', label: 'output tokens', value: result.outputTokens != null ? `${fmtInt(result.outputTokens)}${result.tokensEstimated || live ? ' est.' : ''}` : live ? fmtInt(estTokens(result.output)) : '—', best: false },
    { icon: 'i-gauge', key: 'tput', label: 'throughput — output tokens/sec', value: tput > 0 ? `${fmtRate(tput)} t/s` : '—', best: isBest('tput') },
    { icon: 'i-coin', key: 'cheap', label: 'cost (estimate)', value: result.cost != null ? `${fmtCost(result.cost)} est.` : '—', best: isBest('cheap') },
    // Act tasks run the project automatically after the agent's changes —
    // "runs ✓" means the harness started it successfully (exit 0 or still
    // running at the timeout). A project that no longer starts fails the task.
    ...(result.verified != null
      ? [
          {
            icon: result.verified ? 'i-check' : 'i-alert',
            key: 'verified',
            label: result.verified
              ? `project runs — started after the changes${result.verifyCommand ? ` (${result.verifyCommand})` : ''}`
              : 'project failed to start after the changes',
            value: result.verified ? 'runs ✓' : 'failed ✗',
            best: false,
          },
        ]
      : []),
    ...(result.steps != null
      ? [
          {
            icon: 'i-brain',
            key: 'steps',
            label: 'agent loop steps (read → act → verify)',
            value: `${result.steps}`,
            best: false,
          },
        ]
      : []),
  ];
  const responsive = (icon) => (icon === 'i-down' || icon === 'i-clock-bolt' ? 'hidden sm:flex' : 'flex');
  return (
    <div className="aba-fade-in flex flex-wrap gap-1.5 bg-[var(--color-panel)] px-3 py-2">
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

export function ResultCard({ panel, result, context, viewMode, onViewMode, blind, alias, best, repoName, enterFrom = 'left' }) {
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
      className={`${enterFrom === 'right' ? 'aba-slide-in-right' : 'aba-slide-in-left'} result-card flex flex-col overflow-hidden rounded-2xl border bg-[var(--color-panel)] ${
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
                /* While running, the Answer panel IS the sandbox terminal: the
                   agent's tool calls ($ cmd), their results (output) and any
                   reasoning (·) stream in live, starting with the prompt. */
                <div className="h-full overflow-auto bg-[#0b0f14] p-3 font-mono text-[11px] leading-[1.7] text-[#c9d1d9]">
                  <div className="flex items-center gap-1.5 pb-2 text-[9px] uppercase tracking-[0.18em] text-[#8b949e]">
                    <span className="size-1.5 animate-pulse rounded-full bg-[var(--color-accent)]" />
                    <span>sandbox terminal{repoName ? ` · ${repoName}` : ''}</span>
                  </div>
                  {(result?.term || []).map((l, i) => (
                    <div
                      key={i}
                      className={
                        l.kind === 'cmd'
                          ? 'text-[#79c0ff]'
                          : l.kind === 'reasoning'
                            ? 'italic text-[#8b949e]'
                            : 'whitespace-pre-wrap break-words'
                      }
                    >
                      {l.kind === 'cmd' && <span className="select-none text-[#3fb950]">$ </span>}
                      {l.kind === 'reasoning' && <span className="select-none text-[#8b949e]">· </span>}
                      {l.text}
                    </div>
                  ))}
                  {result?.output ? (
                    <div className="mt-1.5 whitespace-pre-wrap break-words border-t border-[#21262d] pt-1.5 text-[#e6edf3]">
                      {result.output}
                    </div>
                  ) : null}
                  <div>
                    <span className="select-none text-[#3fb950]">$ </span>
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
                /* Finished: the Answer panel KEEPS the sandbox terminal — the
                   same live view from the run, now frozen (no caret), with the
                   final answer appended as the last block. The plain prose
                   view only shows when the run produced no terminal log. */
                <div className="h-full overflow-auto bg-[#0b0f14] p-3 font-mono text-[11px] leading-[1.7] text-[#c9d1d9]">
                  <div className="flex items-center gap-1.5 pb-2 text-[9px] uppercase tracking-[0.18em] text-[#8b949e]">
                    <span className="size-1.5 rounded-full bg-emerald-400" />
                    <span>sandbox terminal{repoName ? ` · ${repoName}` : ''}</span>
                  </div>
                  {(result?.term || []).length > 0 ? (
                    (result.term).map((l, i) => (
                      <div
                        key={i}
                        className={
                          l.kind === 'cmd'
                            ? 'text-[#79c0ff]'
                            : l.kind === 'reasoning'
                              ? 'italic text-[#8b949e]'
                              : 'whitespace-pre-wrap break-words'
                        }
                      >
                        {l.kind === 'cmd' && <span className="select-none text-[#3fb950]">$ </span>}
                        {l.kind === 'reasoning' && <span className="select-none text-[#8b949e]">· </span>}
                        {l.text}
                      </div>
                    ))
                  ) : (
                    <div className="whitespace-pre-wrap break-words text-[#e6edf3]">{answer || result.output}</div>
                  )}
                  {result?.output ? (
                    <div className="mt-1.5 whitespace-pre-wrap break-words border-t border-[#21262d] pt-1.5 text-[#e6edf3]">
                      {result.output}
                    </div>
                  ) : null}
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

export function SearchSelect({ value, options, onChange, placeholder = 'Search…', ariaLabel, isFree, toolUse, warn }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const rootRef = React.useRef(null);
  const menuRef = React.useRef(null);
  // Dropdown position, rendered in a portal fixed to the viewport so no
  // scrollable parent (modal, composer) can clip the list.
  const [menuPos, setMenuPos] = useState(null); // { left, width, top, up }

  // Term-based filter: typing "free" filters to free models only (when the
  // list knows which options are free); every other term matches a substring.
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const filtered = query
    ? options.filter((o) => {
        const s = String(o).toLowerCase();
        return terms.every((t) => {
          if (t === 'free') return isFree ? isFree(o) : s.includes(t);
          return s.includes(t);
        });
      })
    : options;

  // Measure the trigger and place the menu below it (or above when there
  // isn't room); re-measure on scroll/resize so it stays attached.
  useEffect(() => {
    if (!open) return;
    const position = () => {
      const rect = rootRef.current && rootRef.current.getBoundingClientRect();
      if (!rect) return;
      const estHeight = Math.min(filtered.length * 30 + 50, 290);
      const below = window.innerHeight - rect.bottom;
      const up = below < estHeight && rect.top > below;
      setMenuPos({ left: rect.left, width: rect.width, top: rect.bottom + 4, up });
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [open, filtered.length]);

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
      // Ignore clicks inside the trigger AND inside the portal menu — the
      // menu lives in document.body, so it is no longer inside rootRef.
      if (rootRef.current && rootRef.current.contains(e.target)) return;
      if (menuRef.current && menuRef.current.contains(e.target)) return;
      setOpen(false);
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
        className={`arena-select flex min-h-9 w-full items-center justify-between gap-2 rounded-lg border px-2.5 text-left text-[12px] text-[var(--color-ink)] outline-none transition-colors hover:border-[var(--color-line-hi)] focus:border-[var(--color-accent)]/50 ${
          warn ? 'border-red-500/50' : 'border-[var(--color-line)]'
        }`}
      >
        <span className="min-w-0 flex-1 truncate">{value || placeholder}</span>
        {isFree && value && isFree(value) && (
          <span className="shrink-0 rounded border border-emerald-500/40 bg-emerald-500/10 px-1 py-px text-[8px] font-semibold uppercase tracking-wide text-emerald-600">
            free
          </span>
        )}
        {toolUse && value && toolUse(value) === false && (
          <span className="shrink-0 rounded border border-red-500/40 bg-red-500/10 px-1 py-px text-[8px] font-semibold uppercase tracking-wide text-red-400">
            no tools
          </span>
        )}
        <Icon name="chevron" className={`size-3.5 shrink-0 text-[var(--color-ink-faint)] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open &&
        menuPos &&
        createPortal(
          <div
            ref={menuRef}
            className="overflow-hidden rounded-lg border border-[var(--color-line-hi)] bg-[var(--color-panel)] shadow-xl"
            style={{
              position: 'fixed',
              left: menuPos.left,
              width: menuPos.width,
              top: menuPos.top,
              zIndex: 90,
              transform: menuPos.up ? 'translateY(-100%)' : undefined,
            }}
          >
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
                  <span className="min-w-0 flex-1 truncate">{o}</span>
                  {isFree && isFree(o) && (
                    <span className="shrink-0 rounded border border-emerald-500/40 bg-emerald-500/10 px-1 py-px text-[8px] font-semibold uppercase tracking-wide text-emerald-600">
                      free
                    </span>
                  )}
                  {toolUse && toolUse(o) === false && (
                    <span className="shrink-0 rounded border border-red-500/40 bg-red-500/10 px-1 py-px text-[8px] font-semibold uppercase tracking-wide text-red-400" title="This model cannot call tools — act tasks will be blocked">
                      no tools
                    </span>
                  )}
                  {o === value && <Icon name="check" className="size-3.5 shrink-0 text-[var(--color-accent)]" />}
                </button>
              ))}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Composer panel config (isbetter.ai panel-premium) — ACC panel first +     */
/* highlighted so the framework side is always the benchmark reference.      */
/* ------------------------------------------------------------------------ */

export function PanelConfig({ panel, onPanel, liveModels, modelsLoading, onCopyAcc, freebuffRunning }) {
  const keys = loadKeys();
  // Only providers the user has configured (key set, or local no-key). The
  // optional Freebuff provider is only selectable while its local proxy runs.
  const available = PROVIDERS.filter(
    (p) => (p.id === 'freebuff' ? freebuffRunning : !p.needsKey || keys[p.id])
  );
  const provider = getProvider(panel.provider);
  const configured = !provider.needsKey || !!(panel.apiKey || keys[panel.provider]);
  // Live model list from the provider API when available; static fallback
  // otherwise. Live rows are { id, tools } objects — flatten to ids for the
  // dropdown and resolve tool-calling capability for the act gate.
  const models = modelIdList(panel.provider, liveModels[panel.provider]);
  // Tool-calling capability is only known when the LIVE model list loaded
  // (the provider flags it) — the static fallback has no capability data, so
  // the dropdown only marks models when there is a real signal.
  const hasLiveModels = !!(liveModels[panel.provider] && liveModels[panel.provider].length);
  const noToolCalling = hasLiveModels && !modelTools(panel.provider, liveModels[panel.provider], panel.model);
  const toolUse = (m) => (hasLiveModels ? modelTools(panel.provider, liveModels[panel.provider], m) : null);
  const loading = !!modelsLoading[panel.provider];
  // If the current provider lost its key, fall back to the first configured one.
  const effectiveProvider = available.some((p) => p.id === panel.provider)
    ? panel.provider
    : available[0]?.id;
  const effective = getProvider(effectiveProvider);
  return (
    <div
      className={`aba-card-in rounded-xl border p-3.5 ${
        panel.acc
          ? 'border-[var(--color-accent)]/40 bg-[var(--color-accent)]/[0.05] shadow-[0_0_0_1px_var(--color-accent)/15,0_10px_30px_-18px_var(--color-accent)/30]'
          : 'border-[var(--color-line)] bg-[var(--color-panel)]'
      }`}
    >
      <div className="mb-2.5 flex items-center gap-2">
        {/* On the no-ACC side, a shortcut that applies the ACC panel's
           provider/model to this panel so both sides match. */}
        {!panel.acc && onCopyAcc && (
          <button
            type="button"
            onClick={onCopyAcc}
            title="Apply the ACC panel's provider and model to this panel"
            className="inline-flex items-center gap-1 rounded-md border border-dashed border-[var(--color-line-hi)] px-1.5 py-0.5 text-[9px] text-[var(--color-ink-faint)] transition-colors hover:border-[var(--color-accent)]/50 hover:text-[var(--color-accent)]"
          >
            <Icon name="copy" className="size-3" />
            <span>Copy ACC info</span>
          </button>
        )}
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
              onPanel({ ...panel, provider: next, model: modelIdList(next, live)[0] || '' });
            }}
          />
        </label>
        <label className="block">
          <span
            className={`mb-1 flex items-center gap-1 text-[10px] uppercase tracking-[0.1em] ${noToolCalling ? 'text-red-400' : 'text-[var(--color-ink-faint)]'}`}
          >
            Model
            {loading && <span className="inline-block size-3 rounded-full border-2 border-[var(--color-line-hi)] border-t-[var(--color-accent)] spin" />}
          </span>
          <SearchSelect
            value={panel.model}
            options={models}
            placeholder="Select model…"
            ariaLabel="Select model"
            isFree={(m) => isFreeModel(panel.provider, m)}
            toolUse={toolUse}
            warn={noToolCalling}
            onChange={(m) => onPanel({ ...panel, model: m })}
          />
        </label>
      </div>
      {noToolCalling && (
        <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-red-400" role="alert">
          <Icon name="alert" className="mt-0.5 size-3 shrink-0" />
          <span>This model has no tool calling — act tasks are blocked until you pick a model that supports it.</span>
        </p>
      )}
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
  const [ghToken, setGhToken] = useState('');
  const [ghMode, setGhMode] = useState('oauth'); // 'oauth' | 'token' (advanced: paste a PAT)
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
      setGhMode('oauth');
    }
  }, [open]);

  // The sign-in popup posts the result back after GitHub redirects to the
  // callback. Hook must live above the `if (!open) return null` early return
  // so the hook count never changes between renders.
  useEffect(() => {
    const onMsg = (e) => {
      if (!e.data || e.data.type !== 'aba-github-auth') return;
      if (e.data.token) finishGithubAuth(e.data.token);
      else {
        setGhBusy(false);
        setGhError(e.data.error || 'GitHub sign-in failed.');
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { mounted, visible } = useOverlay(open);
  if (!mounted) return null;

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

  // One click on "Connect GitHub": open a popup to the server's
  // /api/github/start — a real same-origin URL opened inside the click gesture,
  // so it is never blocked as a popup. The server 302s to GitHub's authorize
  // page; after you approve, GitHub redirects back to /api/github/callback,
  // which posts the access token to this window. Then repos + account info
  // load automatically — no codes, no extra clicks.
  function handleConnectGithub() {
    setGhError('');
    setGhOk('');
    const win = window.open('/api/github/start', 'github-auth', 'width=900,height=720,popup=yes');
    if (!win) {
      setGhError('The sign-in window was blocked — allow popups for this site and try again.');
      return;
    }
    setGhBusy(true);
  }

  // Token obtained from GitHub — fetch the account + repos and save the
  // connection (same shape as the token-paste path).
  async function finishGithubAuth(token) {
    try {
      const me = await githubMe(token);
      const repos = await githubRepos(token);
      const next = { token, login: me.login || me.name || 'connected', repos };
      saveGithub(next);
      setGh(next);
      setGhOk(`Connected as ${me.login} — ${repos.length} repos available as suggestions.`);
      if (onDataChanged) onDataChanged();
    } catch (err) {
      setGhError(`Signed in, but could not load your profile: ${err.message}`);
    } finally {
      setGhBusy(false);
    }
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
      <div
        id="settings-backdrop"
        className={`absolute inset-0 bg-black/80 backdrop-blur-md transition-opacity duration-200 ${visible ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />
      <div
        className={`panel-premium absolute left-1/2 top-1/2 max-h-[min(88vh,720px)] w-[min(94vw,560px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-5 shadow-2xl transition-all duration-200 ease-out sm:p-6 ${
          visible ? 'opacity-100 scale-100' : 'opacity-0 scale-[0.97]'
        }`}
      >
        <div className="flex items-center gap-2.5">
          <span className="grid size-10 place-items-center rounded-xl bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
            <Icon name="bolt" className="size-5" />
          </span>
          <div className="flex-1">
            <h2 id="settings-title" className="text-[14px] font-medium text-[var(--color-ink)]">
              Settings
            </h2>
            <p className="mt-0.5 text-[11px] text-[var(--color-ink-faint)]">GitHub account and local data.</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="grid size-8 place-items-center rounded-md text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-line)] hover:text-[var(--color-ink)]"
          >
            <Icon name="x" className="size-4" />
          </button>
        </div>

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
              <button
                onClick={handleConnectGithub}
                disabled={ghBusy}
                className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg bg-[#1f2328] px-4 py-2.5 text-[12px] font-semibold text-white transition-colors hover:bg-[#32383f] disabled:opacity-60"
              >
                <Icon name={ghBusy ? 'refresh' : 'github'} className={`size-4 ${ghBusy ? 'spin' : ''}`} />
                <span>{ghBusy ? 'waiting for GitHub…' : 'Connect GitHub'}</span>
              </button>
              {ghMode === 'token' ? (
                <div className="mt-2">
                  <div className="control-surface flex items-center gap-2 px-3 focus-within:border-[var(--color-accent)]/45">
                    <Icon name="link" className="size-4 shrink-0 text-[var(--color-ink-faint)]" />
                    <input
                      type="password"
                      placeholder="GitHub personal access token (classic · repo)…"
                      autoComplete="off"
                      spellCheck="false"
                      autoFocus
                      value={ghToken}
                      onChange={(e) => setGhToken(e.target.value)}
                      className="w-full bg-transparent py-2.5 font-mono text-[12px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)]"
                    />
                  </div>
                  <div className="mt-2.5 flex items-center gap-2">
                    <button
                      onClick={connectGithub}
                      disabled={ghBusy}
                      className="action-primary flex items-center gap-1.5 px-3.5 py-2 text-[11px] font-semibold disabled:opacity-60"
                    >
                      <Icon name={ghBusy ? 'refresh' : 'link'} className={`size-3.5 ${ghBusy ? 'spin' : ''}`} />
                      <span>{ghBusy ? 'connecting…' : 'Connect with token'}</span>
                    </button>
                    <button
                      onClick={() => {
                        setGhMode('oauth');
                        setGhError('');
                        setGhOk('');
                      }}
                      className="flex items-center gap-1.5 rounded-md px-2 py-2 text-[11px] text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink)]"
                    >
                      <Icon name="arrow-left" className="size-3.5" />
                      back
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => {
                    setGhMode('token');
                    setGhError('');
                    setGhOk('');
                  }}
                  className="mt-2 text-[11px] text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink)]"
                >
                  or paste a personal access token
                </button>
              )}
            </div>
          )}
          {ghError && <p className="mt-2 flex items-start gap-1.5 text-[11px] text-red-400"><Icon name="alert" className="mt-0.5 size-3.5 shrink-0" />{ghError}</p>}
          {ghOk && <p className="mt-2 flex items-start gap-1.5 text-[11px] text-emerald-400"><Icon name="check" className="mt-0.5 size-3.5 shrink-0" />{ghOk}</p>}
          <p className="mt-2 text-[10px] leading-relaxed text-[var(--color-ink-faint)]">
            Sign in with your GitHub account — ABA only reads your login and repository list, and it's never sent anywhere but
            GitHub. You can also paste a personal access token (classic, scope <code>repo</code>) instead.
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

export function KeyModal({ open, onClose, onSaved, freebuffRunning }) {
  const [provider, setProvider] = useState(() => PROVIDERS.find((p) => p.needsKey)?.id || 'openai');
  const [keyDraft, setKeyDraft] = useState('');
  // Copy of the saved keys so the "connected providers" list stays in sync
  // without reading localStorage on every render.
  const [keys, setKeys] = useState(loadKeys);
  useEffect(() => {
    if (open) {
      setProvider(PROVIDERS.find((p) => p.needsKey)?.id || 'openai');
      setKeyDraft('');
      setKeys(loadKeys());
    }
  }, [open]);
  const { mounted, visible } = useOverlay(open);
  if (!mounted) return null;

  const saved = !!keys[provider];
  const connected = PROVIDERS.filter((p) => p.needsKey && keys[p.id]);

  function saveCurrentKey() {
    if (!keyDraft.trim()) return;
    saveKey(provider, keyDraft.trim());
    setKeys(loadKeys());
    setKeyDraft('');
    if (onSaved) onSaved();
  }

  function editKey(id) {
    setProvider(id);
    setKeyDraft(loadKeys()[id] || '');
  }

  function revokeKey(id) {
    const p = PROVIDERS.find((x) => x.id === id);
    if (!p) return;
    if (!window.confirm(`Revoke the ${p.label} API key? It will be removed from this browser.`)) return;
    saveKey(id, '');
    setKeys(loadKeys());
    if (provider === id) setKeyDraft('');
    if (onSaved) onSaved();
  }

  return (
    <div id="key-modal" className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="key-modal-title">
      <div
        id="key-backdrop"
        className={`absolute inset-0 bg-black/80 backdrop-blur-md transition-opacity duration-200 ${visible ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />
      <div
        className={`panel-premium absolute left-1/2 top-1/2 max-h-[min(88vh,720px)] w-[min(94vw,480px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-5 shadow-2xl transition-all duration-200 ease-out sm:p-6 ${
          visible ? 'opacity-100 scale-100' : 'opacity-0 scale-[0.97]'
        }`}
      >
        <div className="flex items-center gap-2.5">
          <span className="grid size-10 place-items-center rounded-xl bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
            <Icon name="key" className="size-5" />
          </span>
          <div className="flex-1">
            <h2 id="key-modal-title" className="text-[14px] font-medium text-[var(--color-ink)]">
              API keys
            </h2>
            <p className="mt-0.5 text-[11px] text-[var(--color-ink-faint)]">
              Keys stay in this browser and are only sent to their provider.
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid size-8 place-items-center rounded-md text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-line)] hover:text-[var(--color-ink)]"
          >
            <Icon name="x" className="size-4" />
          </button>
        </div>

        {/* ---- AI provider (Settings-style picker) ---- */}
        {/* Optional Freebuff proxy status — no key needed, models load from
           the local proxy's /v1/models automatically. */}
        {freebuffRunning && (
          <p className="mt-4 flex items-start gap-1.5 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel)] px-2.5 py-2 text-[10.5px] leading-relaxed text-[var(--color-ink-dim)]">
            <Icon name="bolt" className="mt-0.5 size-3.5 shrink-0 text-[var(--color-accent)]" />
            <span>
              <strong className="font-medium text-[var(--color-ink)]">Freebuff</strong> proxy is running — no API key needed.
              Pick it as a provider in the panels; its models load automatically.
            </span>
          </p>
        )}

        <section className="mt-5">
          <h3 className="font-pixel text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-dim)]">AI provider</h3>
          <div className="mt-2.5 grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-faint)]">Provider</span>
              <SearchSelect
                value={getProvider(provider).label}
                options={PROVIDERS.filter((p) => p.needsKey).map((p) => p.label)}
                placeholder="Select provider…"
                ariaLabel="Select AI provider"
                onChange={(label) => {
                  const p = PROVIDERS.find((x) => x.label === label);
                  if (!p) return;
                  setProvider(p.id);
                  setKeyDraft(loadKeys()[p.id] || '');
                }}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-faint)]">
                API key {saved ? '(saved)' : ''}
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
            onClick={saveCurrentKey}
          >
            <Icon name="key" className="size-3.5" />
            <span>Save key</span>
          </button>
        </section>

        {/* ---- Connected providers ---- */}
        <section className="mt-5">
          <h3 className="font-pixel text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-dim)]">Connected providers</h3>
          {connected.length === 0 ? (
            <p className="mt-2.5 text-[11px] text-[var(--color-ink-faint)]">No providers connected yet — save a key above.</p>
          ) : (
            <div className="mt-2.5 space-y-1.5">
              {connected.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2"
                >
                  <span className="flex min-w-0 items-center gap-2 text-[12px] text-[var(--color-ink)]">
                    <Icon name="check" className="size-3.5 shrink-0 text-emerald-400" />
                    <span className="truncate">{p.label}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => editKey(p.id)}
                      aria-label={`Edit ${p.label} key`}
                      title="Edit key"
                      className="grid size-7 place-items-center rounded-md text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-panel-hi)] hover:text-[var(--color-ink)]"
                    >
                      <Icon name="edit" className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => revokeKey(p.id)}
                      aria-label={`Revoke ${p.label} key`}
                      title="Revoke (delete) key"
                      className="grid size-7 place-items-center rounded-md text-[var(--color-ink-faint)] transition-colors hover:bg-red-500/10 hover:text-red-400"
                    >
                      <Icon name="trash" className="size-3.5" />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* History drawer (isbetter.ai history drawer)                               */
/* ------------------------------------------------------------------------ */

export function HistoryDrawer({ open, history, onClose, onClear, onDelete, onStop, onResume, onOpen, onImport }) {
  const [deleting, setDeleting] = useState(null); // history id currently being removed
  const { mounted, visible } = useOverlay(open, 240);
  const fileInputRef = useRef(null);
  if (!mounted) return null;
  async function remove(h) {
    setDeleting(h.id);
    try {
      if (onDelete) await onDelete(h);
    } finally {
      setDeleting(null);
    }
  }
  function handleImportFile(e) {
    const file = e.target?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (onImport) onImport(data);
      } catch {
        alert('Invalid report file');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }
  return (
    <div id="history-drawer" className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="history-title">
      <div
        id="history-backdrop"
        className={`absolute inset-0 bg-black/80 backdrop-blur-md transition-opacity duration-200 ${visible ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
      />
      <aside
        id="history-panel"
        className={`absolute right-0 top-0 flex h-full w-[min(94vw,480px)] flex-col border-l border-[var(--color-line-hi)] bg-[var(--color-panel)] shadow-2xl transition-transform duration-200 ease-out ${
          visible ? 'translate-x-0 opacity-100' : 'translate-x-full opacity-0'
        }`}
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
          <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleImportFile} />
          <button
            onClick={() => fileInputRef.current?.click()}
            aria-label="Import a battle report"
            className="flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-2 py-1.5 text-[11px] text-[var(--color-ink-faint)] transition-colors hover:border-[var(--color-accent)]/40 hover:text-[var(--color-accent)]"
            title="Import a saved battle report"
          >
            <Icon name="restore" className="size-3.5" />
            <span>load</span>
          </button>
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
              {history.map((h) => {
                const running = h.status === 'running';
                const stopped = h.status === 'stopped';
                const errored = h.status === 'error';
                return (
                  <div key={h.id} className="rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] px-3.5 py-3">
                    <div className="flex items-center justify-between gap-2">
                      {running ? (
                        <button
                          onClick={() => onResume?.(h)}
                          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12px] font-medium text-[var(--color-ink)] transition-colors hover:text-[var(--color-accent)]"
                          title="Resume this battle"
                        >
                          <Icon name="play" className="size-3.5 shrink-0 text-[var(--color-accent)]" />
                          <span className="truncate">{h.repoName}</span>
                        </button>
                      ) : (
                        <button
                          onClick={() => onOpen?.(h)}
                          className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-[12px] font-medium text-[var(--color-ink)] transition-colors hover:text-[var(--color-accent)]"
                          title="View this battle"
                        >
                          <Icon name="eye" className="size-3.5 shrink-0 text-[var(--color-ink-faint)]" />
                          <span className="truncate">{h.repoName}</span>
                        </button>
                      )}
                      {running ? (
                        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-accent)]">
                          <span className="size-1.5 rounded-full bg-[var(--color-accent)] animate-pulse" />
                          running
                        </span>
                      ) : stopped ? (
                        <span className="shrink-0 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-400">
                          stopped
                        </span>
                      ) : errored ? (
                        <span className="shrink-0 rounded-md border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-400">
                          failed
                        </span>
                      ) : h.verdict ? (
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
                      ) : (
                        <span className="shrink-0 rounded-md border border-[var(--color-line)] px-1.5 py-0.5 text-[10px] text-[var(--color-ink-faint)]">
                          completed
                        </span>
                      )}
                      {running && (
                        <button
                          onClick={() => onStop?.(h)}
                          aria-label={`Stop this battle (${h.repoName})`}
                          title="stop this battle — it stays in history as stopped"
                          className="grid size-7 shrink-0 place-items-center rounded-md text-[var(--color-ink-faint)] transition-colors hover:bg-red-500/10 hover:text-red-400"
                        >
                          <Icon name="stop" className="size-3.5" />
                        </button>
                      )}
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
                      {new Date(h.ts).toLocaleString()} · {h.taskCount} tasks{h.accWins != null ? ` · ${h.accWins}/${h.taskCount} ACC` : ''}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
