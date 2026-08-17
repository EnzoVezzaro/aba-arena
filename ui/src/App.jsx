import React, { useEffect, useRef, useState } from 'react';
import { PROVIDERS, getProvider, loadKeys, fetchProviderModels, PUBLIC_MODELS_PROVIDERS, modelIdList, modelTools } from './providers.js';
import { DEFAULT_TASKS } from './tasks.js';
import { health, loadRepo, deleteBattle, deleteAllBattles, fsList } from './api.js';
import IconSprite from './icons.jsx';
import {
  Icon,
  PanelConfig,
  KeyModal,
  HistoryDrawer,
  SettingsModal,
  useOverlay,
  DEFAULT_SYSTEM,
  HISTORY_KEY,
  PENDING_BATTLE_KEY,
  INITIAL_PANELS,
  loadHistory,
  saveHistory,
  loadGithub,
} from './components.jsx';

const navigateToBattle = () => {
  window.location.href = '/battle';
};

/* Repository autocomplete — a free-text input (local path or URL) with the
   connected GitHub account's repos as searchable suggestions, keyboard
   navigable like the provider/model selects. */
function RepoAutocomplete({ value, onChange, onLoad, repos, busy, loadingLabel, placeholder, onFindFolder }) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef(null);
  const q = value.toLowerCase();
  const list = repos.filter(
    (r) => !q || r.full.toLowerCase().includes(q) || (r.language || '').toLowerCase().includes(q)
  );

  useEffect(() => {
    const onOut = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onOut);
    return () => document.removeEventListener('mousedown', onOut);
  }, []);

  function onKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (open && list.length) {
        // Pick fills the input only — the user presses Load to load it.
        onChange(list[Math.min(highlight, list.length - 1)].full);
        setOpen(false);
      } else {
        onLoad();
      }
    } else if (e.key === 'ArrowDown' && open && list.length) {
      e.preventDefault();
      setHighlight((h) => (h + 1) % list.length);
    } else if (e.key === 'ArrowUp' && open && list.length) {
      e.preventDefault();
      setHighlight((h) => (h - 1 + list.length) % list.length);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <div className="prompt-shell relative mt-3">
        <input
          id="repo-input"
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
            setHighlight(0);
          }}
          onFocus={() => {
            setOpen(true);
            setHighlight(0);
          }}
          onKeyDown={onKeyDown}
          spellCheck="false"
          className="no-scrollbar block w-full bg-transparent px-4 py-3.5 text-[13px] leading-relaxed text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)] sm:text-[14px]"
        />
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
          <button
            type="button"
            onClick={onFindFolder}
            title="Load a project from a folder on this machine"
            aria-label="Find folder"
            className="grid size-8 place-items-center rounded-lg bg-[var(--color-panel-hi)] text-[var(--color-ink-dim)] transition-colors hover:bg-[var(--color-line-hi)] hover:text-[var(--color-ink)]"
          >
            <Icon name="folder" className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => onLoad()}
            disabled={busy}
            className="flex h-8 items-center rounded-lg bg-[var(--color-panel-hi)] px-2.5 text-[11px] font-medium text-[var(--color-ink-dim)] transition-colors hover:bg-[var(--color-line-hi)] hover:text-[var(--color-ink)] disabled:opacity-50"
          >
            {busy ? loadingLabel : 'Load'}
          </button>
        </div>
      </div>
      {open && list.length > 0 && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-[var(--color-line-hi)] bg-[var(--color-panel)] shadow-xl">
          <ul className="no-scrollbar max-h-56 overflow-y-auto py-1">
            {list.map((r, i) => (
              <li key={r.full}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onChange(r.full);
                    setOpen(false);
                  }}
                  onMouseEnter={() => setHighlight(i)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                    i === highlight ? 'bg-[var(--color-panel-hi)] text-[var(--color-ink)]' : 'text-[var(--color-ink-dim)]'
                  }`}
                >
                  <Icon name="folder" className="size-3.5 shrink-0 text-[var(--color-ink-faint)]" />
                  <span className="min-w-0 flex-1 truncate text-[12px]">{r.full}</span>
                  {r.language && (
                    <span className="shrink-0 rounded-md bg-[var(--color-panel-hi)] px-1.5 py-0.5 text-[9px] uppercase text-[var(--color-ink-faint)]">
                      {r.language}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

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
  // ACC-sandbox setup progress — the server streams one step per phase
  // (import → sandboxes → acc init/build/fill → harness) while loading.
  const [setupSteps, setSetupSteps] = useState([]);
  const [setupError, setSetupError] = useState('');
  const [backend, setBackend] = useState(null);

  const [panels, setPanels] = useState(INITIAL_PANELS);
  const [tasks, setTasks] = useState(DEFAULT_TASKS.map((t) => ({ ...t })));
  const [taskDraft, setTaskDraft] = useState('');
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM);
  const [sysOpen, setSysOpen] = useState(false);

  const [history, setHistory] = useState([]);
  const [keyModal, setKeyModal] = useState(false);
  // Optional local Freebuff proxy (aba/freebuff) — the Freebuff provider only
  // appears in the pickers while the proxy is actually running on :8080.
  const [freebuffRunning, setFreebuffRunning] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [github, setGithub] = useState(loadGithub);
  const [liveModels, setLiveModels] = useState({}); // providerId -> model ids (fetched with key)
  const [modelsLoading, setModelsLoading] = useState({}); // providerId -> true while fetching

  // Folder picker — browse the machine running ABA and load a local project.
  const [folderOpen, setFolderOpen] = useState(false);
  const [folderPath, setFolderPath] = useState('');
  const [folderParent, setFolderParent] = useState('');
  const [folderDirs, setFolderDirs] = useState([]);
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState('');

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
        const list = modelIdList(providerId, live);
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
    // Providers with a key, local providers, and providers whose model list
    // endpoint is public (NVIDIA, OpenRouter) — fetch live models for all of
    // them so the dropdown shows the full list even before a key is saved.
    const targets = PROVIDERS.filter((p) => !p.needsKey || keys[p.id] || PUBLIC_MODELS_PROVIDERS.has(p.id));
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
    // Poll the local Freebuff proxy (cheap localhost check) so the provider
    // appears in the pickers the moment the proxy comes up (and disappears
    // when it stops). Never auto-starts it — that's the user's call.
    let lastFreebuff = false;
    const poll = async () => {
      try {
        const res = await fetch('/api/freebuff/status');
        const j = await res.json();
        if (j.running !== lastFreebuff) {
          lastFreebuff = !!j.running;
          setFreebuffRunning(!!j.running);
          if (j.running) refreshModels();
        }
      } catch {
        if (lastFreebuff) {
          lastFreebuff = false;
          setFreebuffRunning(false);
        }
      }
    };
    poll();
    const t = setInterval(poll, 10000);
    return () => clearInterval(t);
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

  async function handleLoadRepo(source, githubRepo) {
    const src = (typeof source === 'string' ? source : repoInput).trim();
    if (!src) return;
    setLoadingRepo(true);
    setLoadElapsed(0);
    setSetupSteps([]);
    setSetupError('');
    setRepoError('');
    const t0 = Date.now();
    const timer = setInterval(() => setLoadElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    try {
      // When the text matches one of the connected account's repos (typed or
      // picked), clone it as GitHub with the account token so private repos
      // work. Anything else (URL or local path) loads normally.
      const matched = github.repos.find((r) => r.full === src);
      const opts = matched || githubRepo ? { type: 'github', token: github.token } : {};
      const data = await loadRepo(src, opts, (evt) => {
        // The ACC sandbox is set up once, at load — stream its phases live.
        // Steps are keyed by label (graph + context share step number 6).
        if (evt.type === 'step') {
          setSetupSteps((prev) => [...prev.filter((s) => s.label !== evt.label), evt]);
        }
      });
      setRepo({
        ...data.repo,
        baseContext: data.baseContext,
        accContext: data.accContext,
        accPipeline: data.accPipeline || [],
      });
    } catch (err) {
      setRepoError(err.message);
      setSetupError(err.message);
    } finally {
      clearInterval(timer);
      setLoadingRepo(false);
    }
  }

  /* Find folder ----------------------------------------------------------- */

  async function navigateFolder(path) {
    setFolderBusy(true);
    setFolderError('');
    try {
      const r = await fsList(path);
      setFolderPath(r.path);
      setFolderParent(r.parent || '');
      setFolderDirs(r.dirs || []);
    } catch (err) {
      setFolderError(err.message);
    } finally {
      setFolderBusy(false);
    }
  }

  function openFolderBrowser() {
    setFolderOpen(true);
    navigateFolder('');
  }

  function loadFromFolder() {
    if (!folderPath) return;
    setFolderOpen(false);
    setRepoInput(folderPath);
    handleLoadRepo(folderPath);
  }

  /* Tasks --------------------------------------------------------------- */

  function addTask() {
    const text = taskDraft.trim();
    if (!text) return;
    // Custom tasks default to 'act' — the agent edits the code, then the
    // harness starts the project to verify it still runs.
    setTasks((prev) => [...prev, { title: text.slice(0, 60), prompt: text, hints: [], minChars: 80, mode: 'act' }]);
    setTaskDraft('');
  }

  function setTaskMode(i, mode) {
    setTasks((prev) => prev.map((t, idx) => (idx === i ? { ...t, mode } : t)));
  }

  function removeTask(i) {
    setTasks((prev) => prev.filter((_, idx) => idx !== i));
  }

  // Apply the ACC panel's provider/model (and key, if one was set on the
  // panel) to the no-ACC panel so both sides run the same model config.
  function handleCopyAcc() {
    const accPanel = panels.find((p) => p.acc);
    if (!accPanel) return;
    setPanels((prev) =>
      prev.map((p) =>
        p.acc ? p : { ...p, provider: accPanel.provider, model: accPanel.model, apiKey: accPanel.apiKey || '' }
      )
    );
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
    // Act tasks edit the code through the harness's tools — a model without
    // tool calling can't run them. Block the battle until the user changes
    // the model or switches those tasks to plan.
    if (actBlocked) {
      const who = actBlockedPanels.map((p) => p.label).join(' and ');
      setRepoError(
        `${who} ${actBlockedPanels.length === 1 ? "doesn't" : "don't"} support tool calling, so act tasks can't run. Change the model or switch those tasks to plan.`
      );
      return;
    }
    // Snapshot the battle config so /battle can run it with realtime streaming.
    // RegExp hints don't survive JSON.stringify — store them as strings and
    // checkSuccess() rebuilds them on load.
    localStorage.setItem(
      PENDING_BATTLE_KEY,
      JSON.stringify({
        id: repo.battleId || `b${Date.now().toString(36)}`,
        ts: Date.now(),
        repo: {
          name: repo.name,
          source: repo.source,
          sha: repo.sha,
          battleId: repo.battleId,
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

  // Delete one run: remove it from local history AND delete its sandboxes +
  // report on the server (the server keeps each battle isolated on disk).
  async function deleteHistoryItem(h) {
    const id = h.battleId || h.id;
    try {
      await deleteBattle(id);
    } catch {
      // Server already gone (restarted, sandbox wiped) — still remove locally.
    }
    clearPendingIfMatch(h);
    const next = history.filter((x) => x.id !== h.id);
    setHistory(next);
    saveHistory(next);
  }

  // Stop a running battle from history: mark it stopped and clear its pending
  // battle so returning to /battle does not auto-restart it.
  function stopHistoryItem(h) {
    const next = history.map((x) => (x.id === h.id ? { ...x, status: 'stopped' } : x));
    setHistory(next);
    saveHistory(next);
    clearPendingIfMatch(h);
  }

  // Open a finished run from history: /battle?battle=<id> replays the saved
  // report (results, timeline, summary) instead of running anything live.
  function openHistoryBattle(h) {
    const id = h.battleId || h.id;
    window.location.href = `/battle?battle=${encodeURIComponent(id)}`;
  }

  // If the pending (running) battle matches this history entry, drop it.
  function clearPendingIfMatch(h) {
    try {
      const pending = JSON.parse(localStorage.getItem(PENDING_BATTLE_KEY) || 'null');
      if (pending && (pending.id === h.id || pending.repo?.battleId === h.battleId)) {
        localStorage.removeItem(PENDING_BATTLE_KEY);
      }
    } catch {
      // malformed pending battle — ignore
    }
  }

  // Clear all: wipe local history AND every server-side battle + report.
  async function clearHistory() {
    try {
      await deleteAllBattles();
    } catch {
      // Server unreachable — still clear locally.
    }
    localStorage.removeItem(PENDING_BATTLE_KEY);
    setHistory([]);
    saveHistory([]);
  }

  const accPipeline = repo?.accPipeline || [];

  // Act-capability gate: act tasks need tool calling on EVERY panel (both
  // sides run the same tasks). Offending models get red marks and run is
  // blocked until the user changes the model or switches the task to plan.
  const actBlockedPanels = panels.filter((p) => !modelTools(p.provider, liveModels[p.provider], p.model));
  const actBlocked = tasks.some((t) => (t.mode || 'act') === 'act') && actBlockedPanels.length > 0;

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
            <button
              onClick={() => setSettingsOpen(true)}
              aria-label="Open settings"
              className="control-surface relative flex min-h-9 items-center gap-2 px-2.5 text-[11px] sm:px-3"
              title="Settings — providers, GitHub, data"
            >
              <Icon name="bolt" className="size-4" />
              <span className="hidden sm:inline">Settings</span>
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
                      freebuffRunning={freebuffRunning}
                      onCopyAcc={handleCopyAcc}
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

                <RepoAutocomplete
                  value={repoInput}
                  onChange={setRepoInput}
                  onLoad={handleLoadRepo}
                  onFindFolder={openFolderBrowser}
                  repos={github.login ? github.repos : []}
                  busy={loadingRepo}
                  loadingLabel={`loading… ${loadElapsed}s`}
                  placeholder={
                    github.login
                      ? `Search your GitHub repos or paste any URL — e.g. ${github.login}/repo…`
                      : 'Local path or GitHub URL — e.g. ./my-project or https://github.com/user/repo'
                  }
                />
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
                  {actBlocked && (
                    <p className="mb-2 flex items-start gap-1.5 rounded-lg border border-red-500/40 bg-red-500/[0.06] px-2.5 py-2 text-[11px] leading-relaxed text-red-400" role="alert">
                      <Icon name="alert" className="mt-0.5 size-3.5 shrink-0" />
                      <span>
                        <strong className="font-semibold">{actBlockedPanels.map((p) => p.label).join(' & ')}</strong>{' '}
                        {actBlockedPanels.length === 1 ? 'uses a model without tool calling' : 'use models without tool calling'} — act tasks
                        are blocked. Change the model or switch the red tasks to{' '}
                        <em className="not-italic font-semibold">plan</em>.
                      </span>
                    </p>
                  )}
                  <ul className="space-y-1.5">
                    {tasks.map((t, i) => (
                      <li
                        key={i}
                        className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 ${
                          actBlocked && (t.mode || 'act') === 'act'
                            ? 'border-red-500/40 bg-red-500/[0.06]'
                            : 'border-[var(--color-line)] bg-[var(--color-panel)]'
                        }`}
                      >
                        <span className="font-mono text-[10px] tabular-nums text-[var(--color-ink-faint)]">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-ink-dim)]">{t.title}</span>
                        <span className="flex shrink-0 items-center gap-0.5 rounded-md bg-[var(--color-panel-hi)] p-0.5">
                          {['plan', 'act'].map((m) => (
                            <button
                              key={m}
                              type="button"
                              onClick={() => setTaskMode(i, m)}
                              title={m === 'plan' ? 'Plan only — the agent writes a plan, no code changes' : 'Act — the agent edits the code, then the harness starts the project to verify it still runs'}
                              className={`rounded px-1.5 py-0.5 font-pixel text-[8px] uppercase tracking-[0.12em] transition-colors ${
                                (t.mode || 'act') === m
                                  ? m === 'act'
                                    ? actBlocked
                                      ? 'bg-red-500/15 text-red-400'
                                      : 'bg-[var(--color-accent)]/20 text-[var(--color-accent)]'
                                    : 'bg-[var(--color-line-hi)] text-[var(--color-ink)]'
                                  : 'text-[var(--color-ink-faint)] hover:text-[var(--color-ink-dim)]'
                              }`}
                            >
                              {m}
                            </button>
                          ))}
                        </span>
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
                    <div className="mt-1.5 flex justify-end">
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
            <span>Agent Code Context · Battle Arena —</span>
            <a
              href="https://EnzoVezzaro.github.io/agents-code-context/"
              target="_blank"
              rel="noopener"
              className="text-[var(--color-ink-dim)] underline-offset-2 transition-colors hover:text-[var(--color-ink)] hover:underline"
            >
              landing page
            </a>
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

      {/* ========================== FIND FOLDER MODAL ====================== */}
      {(() => {
        const { mounted, visible } = useOverlay(folderOpen);
        if (!mounted) return null;
        return (
          <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-labelledby="folder-title">
            <div
              className={`absolute inset-0 bg-black/80 backdrop-blur-md transition-opacity duration-200 ${visible ? 'opacity-100' : 'opacity-0'}`}
              onClick={() => setFolderOpen(false)}
            />
            <div
              className={`panel-premium absolute left-1/2 top-1/2 w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 p-5 shadow-2xl transition-all duration-200 ease-out sm:p-6 ${
                visible ? 'opacity-100 scale-100' : 'opacity-0 scale-[0.97]'
              }`}
            >
            <div className="flex items-center gap-2.5">
              <span className="grid size-10 place-items-center rounded-xl bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
                <Icon name="folder" className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 id="folder-title" className="text-[14px] font-medium text-[var(--color-ink)]">
                  Find folder
                </h2>
                <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--color-ink-faint)]">{folderPath || 'loading…'}</p>
              </div>
              <button
                onClick={() => setFolderOpen(false)}
                aria-label="Close"
                className="grid size-8 place-items-center rounded-md text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-line)] hover:text-[var(--color-ink)]"
              >
                <Icon name="x" className="size-4" />
              </button>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <button
                onClick={() => navigateFolder(folderParent)}
                disabled={!folderParent || folderBusy}
                className="control-surface flex items-center gap-1 px-3 py-1.5 text-[11px] disabled:opacity-40"
              >
                <Icon name="arrow-left" className="size-3.5" />
                up
              </button>
              <span className="text-[10px] text-[var(--color-ink-faint)]">browse the machine running ABA — pick the project folder</span>
            </div>
            <div className="no-scrollbar mt-2 max-h-[40vh] overflow-y-auto rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-1.5">
              {folderBusy && <p className="px-2 py-3 text-center text-[11px] text-[var(--color-ink-faint)]">loading…</p>}
              {!folderBusy && folderError && <p className="px-2 py-3 text-center text-[11px] text-red-400">{folderError}</p>}
              {!folderBusy && !folderError && folderDirs.length === 0 && (
                <p className="px-2 py-3 text-center text-[11px] text-[var(--color-ink-faint)]">(no subfolders)</p>
              )}
              {!folderBusy &&
                !folderError &&
                folderDirs.map((d) => (
                  <button
                    key={d}
                    onClick={() => navigateFolder(folderPath === '/' ? `/${d}` : `${folderPath}/${d}`)}
                    className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] text-[var(--color-ink-dim)] transition-colors hover:bg-[var(--color-panel-hi)] hover:text-[var(--color-ink)]"
                  >
                    <Icon name="folder" className="size-3.5 shrink-0 text-[var(--color-ink-faint)]" />
                    <span className="truncate">{d}</span>
                  </button>
                ))}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button className="control-surface px-4 py-2 text-[12px]" onClick={() => setFolderOpen(false)}>
                Cancel
              </button>
              <button
                onClick={loadFromFolder}
                disabled={folderBusy || !folderPath}
                className="action-primary flex items-center gap-1.5 px-4 py-2 text-[12px] font-semibold disabled:opacity-50"
              >
                <Icon name="play" className="size-3.5" />
                Load this folder
              </button>
            </div>
          </div>
          </div>
        );
      })()}

      {/* ==================== ACC SANDBOX SETUP OVERLAY =================== */}
      {/* While a repo loads, only the ACC sandbox setup is shown: the server
          runs acc init/build/fill once at load and streams each phase here.
          When the environment is ready, the arena (both panels) appears. */}
      {loadingRepo && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-6" role="status" aria-live="polite">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-md" />
          <div className="panel-premium relative w-[min(92vw,560px)] overflow-hidden p-5 sm:p-6">
            <div className="flex items-center gap-2.5">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
                <Icon name="bolt" className="size-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-[14px] font-medium text-[var(--color-ink)]">Setting up the ACC sandbox</h2>
                <p className="mt-0.5 truncate font-mono text-[10px] text-[var(--color-ink-faint)]">{repoInput || '…'}</p>
              </div>
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-[var(--color-ink-faint)]">{loadElapsed}s</span>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
              The ACC sandbox is prepared once — <code className="font-mono">acc init</code>,{' '}
              <code className="font-mono">acc build</code> and <code className="font-mono">acc fill</code> — before the battle
              starts. The plain sandbox is copied in parallel; both panels appear as soon as this finishes.
            </p>
            <ul className="mt-4 space-y-2">
              {setupSteps.length === 0 && (
                <li className="flex items-center gap-2.5 text-[12px] text-[var(--color-ink-faint)]">
                  <span className="size-3 shrink-0 animate-spin rounded-full border-2 border-[var(--color-line-hi)] border-t-[var(--color-accent)]" />
                  connecting to the server…
                </li>
              )}
              {setupSteps.map((s) => (
                <li key={s.label} className="flex items-center gap-2.5 text-[12px]">
                  <span className="grid size-4 shrink-0 place-items-center">
                    {s.ok === null ? (
                      <span className="size-3 animate-spin rounded-full border-2 border-[var(--color-line-hi)] border-t-[var(--color-accent)]" />
                    ) : s.ok ? (
                      <Icon name="check" className="size-3.5 text-emerald-400" />
                    ) : (
                      <Icon name="alert" className="size-3.5 text-red-400" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[var(--color-ink-dim)]">{s.label}</span>
                  {s.detail && <span className="max-w-[45%] truncate text-[10px] text-[var(--color-ink-faint)]">{s.detail}</span>}
                </li>
              ))}
            </ul>
            {setupError && (
              <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-400" role="alert">
                {setupError}
              </p>
            )}
            <div className="mt-4 h-1 overflow-hidden rounded-full bg-[var(--color-line)]">
              <div
                className="h-full rounded-full bg-[var(--color-accent)] transition-all duration-300"
                style={{ width: `${Math.min(100, Math.round((Math.max(0, ...setupSteps.filter((s) => s.ok === true).map((s) => s.step)) / 7) * 100))}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* ============================ KEY MODAL ============================ */}
      <KeyModal open={keyModal} onClose={() => setKeyModal(false)} onSaved={() => refreshModels()} freebuffRunning={freebuffRunning} />

      {/* ========================== SETTINGS MODAL ========================= */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onDataChanged={() => {
          setGithub(loadGithub());
          refreshModels();
        }}
      />

      {/* ========================= HISTORY DRAWER ========================= */}
      <HistoryDrawer
        open={historyOpen}
        history={history}
        onClose={() => setHistoryOpen(false)}
        onClear={clearHistory}
        onDelete={deleteHistoryItem}
        onStop={stopHistoryItem}
        onResume={navigateToBattle}
        onOpen={openHistoryBattle}
      />
    </div>
  );
}
