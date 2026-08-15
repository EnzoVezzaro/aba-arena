import React, { useEffect, useMemo, useRef, useState } from 'react';
import { streamText, tool } from 'ai';
import { z } from 'zod';
import { getProvider, loadKeys, estimateCost } from './providers.js';
import { checkSuccess } from './tasks.js';
import {
  fmtDur,
  fmtInt,
  fmtCost,
  estTokens,
  computeWinners,
} from './arena.js';
import { Icon, ResultCard, PENDING_BATTLE_KEY } from './components.jsx';
import { saveReport, sandboxTree, sandboxRead, sandboxWrite } from './api.js';
import Timeline from './Timeline.jsx';
import IconSprite from './icons.jsx';
import CodeExplorer from './CodeExplorer.jsx';

const systemPrompt = (battle) =>
  battle?.systemPrompt ||
  'You are a senior software engineer benchmarking how well an AI coding agent ' +
    'understands a repository. You are given repository context and a task. Respond ' +
    'concisely and concretely — name specific files, modules, and conventions. Include ' +
    'code where the task asks for it.';

function loadPendingBattle() {
  try {
    return JSON.parse(localStorage.getItem(PENDING_BATTLE_KEY) || 'null');
  } catch {
    return null;
  }
}

function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export default function BattlePage({ onBack }) {
  const [battle] = useState(loadPendingBattle);
  const [results, setResults] = useState([]);
  const [battleStatus, setBattleStatus] = useState('idle'); // idle | running | done | stopped
  const [viewMode, setViewMode] = useState('answer');
  const [blind, setBlind] = useState({ enabled: false, order: null, revealed: true });
  const [savedReport, setSavedReport] = useState('');
  const [explorerPanel, setExplorerPanel] = useState(null); // null | panel object

  const abortRef = useRef(new Set());
  const resultsRef = useRef(results);
  resultsRef.current = results;
  const battleRef = useRef(battle);
  battleRef.current = battle;
  const startedRef = useRef(false);

  const panels = battle?.panels || [];
  const tasks = battle?.tasks || [];
  const repo = battle?.repo || null;

  /* ------------------------- agent tools -------------------------------- */
  // Each panel's agent works inside its own isolated sandbox copy of the
  // repo. Tools read/write files through the backend — the two sides can
  // never touch each other's files or the original repository.
  function agentTools(panelId) {
    return {
      list_files: tool({
        description:
          'List the files and folders in the repository sandbox. Use this to explore the codebase before editing. Returns a tree of paths.',
        parameters: z.object({ path: z.string().optional().describe('subdirectory to list, relative to repo root (e.g. src)') }),
        execute: async ({ path: sub = '' }) => {
          try {
            const t = await sandboxTree(panelId);
            const pick = (nodes, prefix) => {
              for (const n of nodes) {
                if (n.type === 'dir') {
                  const full = n.path;
                  if (sub === '' || sub === '/' || full === sub || full.startsWith(sub + '/')) {
                    const child = pick(n.children || [], sub);
                    if (child) return child;
                  }
                } else if (sub === '' || n.path === sub) {
                  return n;
                }
              }
              return sub ? { path: sub, type: 'missing' } : nodes;
            };
            const found = pick(t.tree || [], sub);
            const flat = (nodes, out = []) => {
              for (const n of nodes) {
                out.push(`${n.type === 'dir' ? '[d]' : '[f]'} ${n.path}${n.type === 'file' && n.size != null ? ' (' + n.size + 'b)' : ''}`);
                if (n.children) flat(n.children, out);
              }
              return out;
            };
            const lines = flat(Array.isArray(found) ? found : [found]);
            return lines.length ? lines.join('\n') : `no files at ${sub || '/'}`;
          } catch (e) {
            return `error listing files: ${e.message}`;
          }
        },
      }),
      read_file: tool({
        description:
          'Read the full contents of a file from the repository sandbox. Use this before editing so you see the real code.',
        parameters: z.object({ path: z.string().describe('path to the file, relative to repo root (e.g. src/index.js)') }),
        execute: async ({ path: filePath }) => {
          try {
            const r = await sandboxRead(panelId, filePath);
            return `--- ${r.path} ---\n${r.content}`;
          } catch (e) {
            return `error reading ${filePath}: ${e.message}`;
          }
        },
      }),
      write_file: tool({
        description:
          'Write a file in the repository sandbox (creates or overwrites). Use this to make the code changes the task requires.',
        parameters: z.object({
          path: z.string().describe('path to the file, relative to repo root (e.g. src/index.js)'),
          content: z.string().describe('the complete new file content'),
        }),
        execute: async ({ path: filePath, content }) => {
          try {
            await sandboxWrite(panelId, filePath, content);
            return `wrote ${filePath} (${content.length} bytes)`;
          } catch (e) {
            return `error writing ${filePath}: ${e.message}`;
          }
        },
      }),
    };
  }

  /* ------------------------- battle runner ------------------------------- */

  async function runPanel(panel, context, task, onDelta, onLive) {
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
    // AI SDK v4: streamText() returns a result object (textStream iterable +
    // usage promise) — it is NOT a promise, so consume it directly.
    // The agent gets tools to explore and EDIT its own isolated sandbox copy
    // of the repo (maxSteps lets it iterate: read → change → verify).
    const result = streamText({
      model: model(panel.model),
      system: systemPrompt(battleRef.current),
      prompt: `${context}\n\nTASK:\n${task.prompt}\n\nYou are working inside an isolated copy of the repository. Use the provided tools (list_files, read_file, write_file) to explore the real code and make the changes the task asks for. When you write code, ALSO explain in your final answer what you changed and why.`,
      temperature: 0.3,
      tools: agentTools(panel.id),
      maxSteps: 12,
      abortSignal: controller.signal,
    });
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
    // Keep missing usage as null (not 0) so the UI shows '—' instead of
    // fake '0 tokens' / '$0' values when the provider reports nothing.
    const inputTokens = u?.inputTokens != null ? u.inputTokens : null;
    const outputTokens = u?.outputTokens != null ? u.outputTokens : null;
    const cost =
      inputTokens != null || outputTokens != null
        ? estimateCost(panel.model, inputTokens ?? 0, outputTokens ?? 0)
        : null;
    return {
      status: 'done',
      output,
      timeMs: elapsed,
      ttftMs: firstTokenAt ? firstTokenAt - startedAt : elapsed,
      genMs: firstTokenAt ? doneAt - firstTokenAt : 0,
      inputTokens,
      outputTokens,
      cost,
      success,
      samples,
    };
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
      const order = prev.order || shuffle(panels.map((p) => p.id));
      return { enabled: true, order, revealed: false };
    });
  }

  function reveal() {
    setBlind((prev) => ({ ...prev, revealed: true }));
  }

  const displayOrder = useMemo(() => {
    const ids = blind.enabled && blind.order ? blind.order : panels.map((p) => p.id);
    return ids.map((id) => panels.find((p) => p.id === id)).filter(Boolean);
  }, [panels, blind]);

  const aliasFor = (panelId) => {
    if (!blind.enabled) return '';
    const idx = (blind.order || panels.map((p) => p.id)).indexOf(panelId);
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

  function stopBattle() {
    for (const c of abortRef.current) c.abort();
    abortRef.current.clear();
    setBattleStatus('stopped');
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
  }

  /* --------------------------- summary ---------------------------------- */

  const summary = useMemo(() => {
    if (results.length === 0) return null;
    const done = results.filter((r) => r.panels.acc?.status === 'done' && r.panels.plain?.status === 'done');
    if (done.length === 0) return null;
    const acc = done.map((r) => r.panels.acc);
    const plain = done.map((r) => r.panels.plain);
    const avg = (arr, f) => {
      const vals = arr.map(f).filter((v) => v != null && Number.isFinite(v));
      return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
    };
    const accWins = done.filter((r) => {
      const a = r.panels.acc;
      const p = r.panels.plain;
      if (a.success !== p.success) return a.success;
      return (a.timeMs ?? Infinity) < (p.timeMs ?? Infinity);
    }).length;
    return {
      accWins,
      total: done.length,
      time: { acc: avg(acc, (r) => r.timeMs), plain: avg(plain, (r) => r.timeMs) },
      tokens: {
        acc: avg(acc, (r) => (r.inputTokens != null || r.outputTokens != null ? (r.inputTokens ?? 0) + (r.outputTokens ?? 0) : null)),
        plain: avg(plain, (r) => (r.inputTokens != null || r.outputTokens != null ? (r.inputTokens ?? 0) + (r.outputTokens ?? 0) : null)),
      },
      cost: { acc: avg(acc, (r) => r.cost), plain: avg(plain, (r) => r.cost) },
      success: { acc: acc.filter((r) => r.success).length, plain: plain.filter((r) => r.success).length },
    };
  }, [results]);

  async function handleSaveReport() {
    try {
      const r = await saveReport({ repo, panels, tasks, results, savedAt: new Date().toISOString() });
      setSavedReport(r.file);
    } catch (e) {
      setSavedReport(`failed: ${e.message}`);
    }
  }

  /* --------------------------- lifecycle -------------------------------- */

  useEffect(() => {
    // Guard against React StrictMode double-invoking the effect in dev.
    if (startedRef.current) return;
    if (repo && battleStatus === 'idle') {
      startedRef.current = true;
      startBattle();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* --------------------------- render ----------------------------------- */

  if (!battle || !repo) {
    return (
      <div className="grid-bg min-h-screen">
        <IconSprite />
        <div className="app-shell flex min-h-screen flex-col items-center justify-center gap-4 py-24 text-center">
          <span className="grid size-14 place-items-center rounded-2xl border border-[var(--color-line)] text-[var(--color-ink-faint)]">
            <Icon name="history" className="size-7" />
          </span>
          <div className="max-w-sm">
            <p className="font-pixel text-[13px] tracking-[0.1em] text-[var(--color-ink-dim)]">battle not found</p>
            <p className="mt-2 text-[12px] leading-relaxed text-[var(--color-ink-faint)]">
              There is no battle queued. Configure one in the arena first.
            </p>
            <button onClick={onBack} className="action-primary mt-4 inline-flex items-center gap-1.5 px-4 py-2 text-[12px] font-semibold">
              <Icon name="bolt" className="size-4" />
              <span>back to the arena</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  const accPipeline = repo.accPipeline || [];

  return (
    <div className="grid-bg min-h-screen">
      <IconSprite />
      <div className="app-shell flex min-h-screen flex-col">
        {/* ============================== HEADER ============================== */}
        <header className="flex min-h-14 items-center justify-between gap-3 py-2.5">
          <button
            onClick={onBack}
            className="control-surface flex min-h-9 items-center gap-2 px-3 text-[11px]"
            title="Back to the arena"
          >
            <Icon name="arrow-left" className="size-4" />
            <span className="hidden sm:inline">Arena</span>
          </button>
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-[0.65rem] border border-[var(--color-accent)]/20 bg-[var(--color-accent)]/[0.06]">
              <img src="/favicon.svg" alt="" className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-[14px] font-bold tracking-[-0.03em] text-[var(--color-ink)]">
                <span className="font-pixel text-[12px] font-semibold tracking-normal text-[var(--color-accent)]">acc</span>
                <span className="ml-2">Battle</span>
              </p>
              <p className="truncate font-mono text-[10px] text-[var(--color-ink-faint)]">
                {repo.name} {repo.sha ? `· ${String(repo.sha).slice(0, 10)}` : ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setExplorerPanel(panels.find((p) => p.acc) || panels[0])}
              className="control-surface flex min-h-9 items-center gap-2 px-3 text-[11px]"
              title="Browse the ACC panel's sandbox files"
            >
              <Icon name="code" className="size-4 text-[var(--color-accent)]" />
              <span className="hidden sm:inline">ACC files</span>
            </button>
            <button
              onClick={() => setExplorerPanel(panels.find((p) => !p.acc) || panels[1])}
              className="control-surface flex min-h-9 items-center gap-2 px-3 text-[11px]"
              title="Browse the no-ACC panel's sandbox files"
            >
              <Icon name="folder" className="size-4" />
              <span className="hidden sm:inline">plain files</span>
            </button>
            <span
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] uppercase tracking-[0.14em] ${
                battleStatus === 'running'
                  ? 'border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
                  : battleStatus === 'done'
                    ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-400'
                    : 'border-[var(--color-line)] text-[var(--color-ink-faint)]'
              }`}
              role="status"
              aria-live="polite"
            >
              <span className={`size-1.5 rounded-full ${battleStatus === 'running' ? 'animate-pulse bg-[var(--color-accent)]' : battleStatus === 'done' ? 'bg-emerald-400' : 'bg-[var(--color-ink-faint)]'}`} />
              {battleStatus === 'running' ? 'running…' : battleStatus === 'done' ? 'complete' : 'ready'}
            </span>
          </div>
        </header>

        <main className="flex-1 pb-8">
          {/* ========================= BATTLE INTRO ========================= */}
          <section className="arena-intro py-5">
            <h1 className="max-w-3xl text-balance text-[clamp(1.6rem,3.5vw,2.6rem)] font-semibold leading-[1.05] tracking-[-0.05em] text-[var(--color-ink)]">
              {repo.name} — <em className="not-italic text-[var(--color-accent)]">ACC vs no-ACC</em>
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-[var(--color-ink-dim)]">
              <span className="inline-flex items-center gap-1 rounded-md border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-[var(--color-accent)]">
                <Icon name="check" className="size-3" />
                loaded
              </span>
              <span className="truncate">{repo.source}</span>
              {repo.sha && <code className="font-mono text-[10px] text-[var(--color-ink-faint)]">{String(repo.sha).slice(0, 10)}</code>}
              <span className="text-[var(--color-ink-faint)]">·</span>
              <span>{tasks.length} task{tasks.length === 1 ? '' : 's'} · {panels.length} panel{panels.length === 1 ? '' : 's'}</span>
            </div>
            {accPipeline.length > 0 && (
              <details className="mt-4 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-3">
                <summary className="cursor-pointer font-pixel text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-dim)]">
                  ACC pipeline — how the framework was prepared
                </summary>
                <ol className="mt-3 space-y-1.5">
                  {accPipeline.map((s) => (
                    <li key={s.step + s.label} className="flex items-center gap-2 text-[11px] text-[var(--color-ink-dim)]">
                      <span className={`size-1.5 shrink-0 rounded-full ${s.ok ? 'bg-emerald-400' : 'bg-red-500'}`} />
                      <span className="font-mono text-[10px] tabular-nums text-[var(--color-ink-faint)]">{s.step}.</span>
                      <span className="font-medium text-[var(--color-ink)]">{s.label}</span>
                      {s.detail && <span className="truncate text-[var(--color-ink-faint)]">— {s.detail}</span>}
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </section>

          {/* ============================ RESULTS ============================ */}
          <section className="results-stage pt-4" aria-labelledby="results-title">
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
                  <p>Running the battle — results appear here as they stream in.</p>
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
                        repoName={repo?.name}
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
                          {savedReport && (
                            <span className="ml-2 font-mono text-[10px] text-emerald-400">{savedReport}</span>
                          )}
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

      {/* ======================== CODE EXPLORER ======================== */}
      <CodeExplorer
        open={!!explorerPanel}
        panel={explorerPanel}
        repoName={repo?.name || ''}
        onClose={() => setExplorerPanel(null)}
      />
    </div>
  );
}
