import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PROVIDERS, getProvider, loadKeys, fetchProviderModels } from './providers.js';
import { DEFAULT_TASKS } from './tasks.js';
import { health, loadRepo } from './api.js';
import IconSprite from './icons.jsx';
import {
  Icon,
  PanelConfig,
  KeyModal,
  HistoryDrawer,
  DEFAULT_SYSTEM,
  TASK_EXAMPLES,
  HISTORY_KEY,
  PENDING_BATTLE_KEY,
  INITIAL_PANELS,
  loadHistory,
  saveHistory,
} from './components.jsx';

const navigateToBattle = () => {
  window.location.href = '/battle';
};

/* ------------------------------------------------------------------------ */
/* App — home / arena config page. Configure the benchmark, then Run battle  */
/* navigates to /battle where both panels stream in realtime. The ACC panel  */
/* is always FIRST and highlighted — it is the framework reference side.     */
/* ------------------------------------------------------------------------ */

export default function App() {
  const [repoInput, setRepoInput] = useState('');
  const [repo, setRepo] = useState(null);
  const [repoError, setRepoError] = useState('');
  const [loadingRepo, setLoadingRepo] = useState(false);
  const [loadElapsed, setLoadElapsed] = useState(0); // seconds while loading
  const [backend, setBackend] = useState(null);

  const [panels, setPanels] = useState(INITIAL_PANELS);
  const [tasks, setTasks] = useState(DEFAULT_TASKS.map((t) => ({ ...t })));
  const [taskDraft, setTaskDraft] = useState('');
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM);
  const [sysOpen, setSysOpen] = useState(false);

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

  useEffect(() => {
    setHistory(loadHistory());
    health().then(setBackend).catch((e) => setBackend({ error: e.message }));
    refreshModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keyboard shortcuts (isbetter.ai style): K keys, H history.
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey) return;
      if (e.key === 'k' || e.key === 'K') setKeyModal((v) => !v);
      if (e.key === 'h' || e.key === 'H') setHistoryOpen((v) => !v);
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
    setLoadElapsed(0);
    setRepoError('');
    const t0 = Date.now();
    const timer = setInterval(() => setLoadElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    try {
      const data = await loadRepo(source);
      setRepo({
        ...data.repo,
        baseContext: data.baseContext,
        accContext: data.accContext,
        accPipeline: data.accPipeline || [],
      });
    } catch (err) {
      setRepoError(err.message);
    } finally {
      clearInterval(timer);
      setLoadingRepo(false);
    }
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

  /* Run → persist the pending battle and navigate to /battle ------------- */

  function runBattle() {
    if (!repo) {
      setRepoError('Load a repository first — paste a local path or GitHub URL above.');
      return;
    }
    if (panels.some((p) => !p.model)) {
      setRepoError('Pick a model for every panel.');
      return;
    }
    // Snapshot the battle config so /battle can run it with realtime streaming.
    // RegExp hints don't survive JSON.stringify — store them as strings and
    // checkSuccess() rebuilds them on load.
    localStorage.setItem(
      PENDING_BATTLE_KEY,
      JSON.stringify({
        ts: Date.now(),
        repo: {
          name: repo.name,
          source: repo.source,
          sha: repo.sha,
          baseContext: repo.baseContext,
          accContext: repo.accContext,
          accPipeline: repo.accPipeline || [],
        },
        panels,
        tasks: tasks.map((t) => ({
          ...t,
          hints: (t.hints || []).map((h) => (h instanceof RegExp ? h.source : h)),
        })),
        systemPrompt,
      })
    );
    navigateToBattle();
  }

  function clearHistory() {
    localStorage.removeItem(HISTORY_KEY);
    setHistory([]);
  }

  const accPipeline = repo?.accPipeline || [];

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
              Benchmark the <strong className="font-semibold text-[var(--color-ink)]">ACC framework</strong> — the first panel always runs with ACC
              installed (highlighted); the other side gets the plain repository. Same repo, same prompts. Compare answer, code,
              speed, and cost in real time.
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
                  The <strong className="font-semibold text-[var(--color-accent)]">ACC panel is always first</strong> and highlighted — it runs the
                  framework. The other panel runs without it.
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
                  <button
                    type="button"
                    onClick={handleLoadRepo}
                    disabled={loadingRepo}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg bg-[var(--color-panel-hi)] px-2.5 py-1.5 text-[11px] font-medium text-[var(--color-ink-dim)] transition-colors hover:bg-[var(--color-line-hi)] hover:text-[var(--color-ink)] disabled:opacity-50"
                  >
                    {loadingRepo ? `loading… ${loadElapsed}s` : 'Load'}
                  </button>
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
                {accPipeline.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                    {accPipeline.map((s) => (
                      <span key={s.step + s.label} className="inline-flex items-center gap-1.5 text-[10px] text-[var(--color-ink-faint)]">
                        <span className={`size-1.5 rounded-full ${s.ok ? 'bg-emerald-400' : 'bg-red-500'}`} />
                        {s.label}
                      </span>
                    ))}
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
                      id="run-btn"
                      onClick={runBattle}
                      disabled={!repo || loadingRepo}
                      className="action-primary group flex min-h-11 flex-1 shrink-0 items-center justify-center gap-2 px-5 text-[13px] font-semibold sm:w-auto sm:flex-none"
                      title={repo ? 'Run the benchmark — ACC panel vs no-ACC panel' : 'Load a repository first'}
                    >
                      <Icon name="play" className="size-4" />
                      <span id="run-label">Run battle</span>
                      <kbd className="key-hint key-hint-inverse">⌘↵</kbd>
                    </button>
                  </div>
                </div>
                {!repo && (
                  <p className="mt-2 text-[11px] text-[var(--color-ink-faint)]">
                    Load a repository first — the benchmark runs on the battle page with live streaming.
                  </p>
                )}
              </div>
            </div>
          </section>
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
