import React, { useEffect, useMemo, useRef, useState } from 'react';
import { checkSuccess } from './tasks.js';
import {
  fmtDur,
  fmtInt,
  fmtCost,
  estTokens,
  computeWinners,
} from './arena.js';
import { getProvider, loadKeys, estimateCost } from './providers.js';
import { estimateUsage } from './estimate.js';
import { Icon, ResultCard, PENDING_BATTLE_KEY, loadHistory, saveHistory } from './components.jsx';
import { loadRepo, saveReport, loadReport, sandboxTree, runAgent, deleteBattle } from './api.js';
import Timeline from './Timeline.jsx';
import IconSprite from './icons.jsx';
import CodeExplorer from './CodeExplorer.jsx';

// Hard cap per panel — provider blocks (rate limits, quota) must not hang the
// battle forever. The panel is aborted and reported as failed, results show.
const PANEL_TIMEOUT_MS = 120000;
// Inactivity cap — if a panel streams nothing for this long (stuck provider,
// half-open connection, tool-only response that never resumes), it is aborted
// so the battle moves on instead of appearing to run forever.
const IDLE_TIMEOUT_MS = 45000;

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

// Persist a history entry by id — a battle shows up as "running" the moment it
// starts and the same entry is updated in place (not duplicated) as it stops or
// completes, keeping its original start time.
function upsertHistory(patch) {
  const h = loadHistory();
  const idx = h.findIndex((x) => x.id === patch.id);
  if (idx >= 0) {
    h[idx] = { ...h[idx], ...patch, ts: h[idx].ts || patch.ts };
  } else {
    h.unshift(patch);
  }
  saveHistory(h);
}

function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// The panel that wins one round (task): success first, then time. Neither
// panel wins when both failed or the times tie.
function roundWinner(r) {
  const a = r.panels.acc;
  const p = r.panels.plain;
  if (!a || !p) return null;
  if (a.status !== 'done' && p.status !== 'done') return null;
  if (a.status !== 'done') return 'plain';
  if (p.status !== 'done') return 'acc';
  if (a.success !== p.success) return a.success ? 'acc' : 'plain';
  if (a.timeMs == null || p.timeMs == null) return null;
  if (a.timeMs === p.timeMs) return null;
  return a.timeMs < p.timeMs ? 'acc' : 'plain';
}

export default function BattlePage({ onBack }) {
  // ?battle=<id> replays a FINISHED run from history: results come from the
  // saved report instead of a live run, so the pending battle is ignored.
  const [viewReportId] = useState(() => new URLSearchParams(window.location.search).get('battle'));
  const [viewError, setViewError] = useState('');
  const [battle, setBattle] = useState(() => (viewReportId ? null : loadPendingBattle()));
  const [results, setResults] = useState([]);
  // idle | running | done | stopped | loading. A finished battle (marked
  // 'done' in the pending snapshot) starts as 'done' so a reload replays the
  // saved report instead of re-running the battle.
  const [battleStatus, setBattleStatus] = useState(() => {
    if (viewReportId) return 'loading';
    const pending = loadPendingBattle();
    if (pending?.status === 'done' || pending?.status === 'stopped') return pending.status;
    return 'idle';
  });
  const [viewMode, setViewMode] = useState('answer');
  // Per-card view overrides — each sandbox's Code/Answer buttons only affect
  // that card. Key: `${taskIndex}:${panelId}` → 'answer' | 'code'.
  const [cardViews, setCardViews] = useState({});
  // Blind mode is OFF by default: the battle shows real panel names and full
  // features (per-card Code view, sandbox file browsers). Opt in via the
  // toolbar to shuffle the panels under aliases for judging; revealing
  // discloses which side runs the ACC framework.
  const [blind, setBlind] = useState(() => {
    const pending = loadPendingBattle();
    const ids = (pending?.panels || []).map((p) => p.id);
    // Blind mode ON by default: the battle hides which panel runs ACC under
    // aliases (Panel A / Panel B) for judging. The toolbar's Reveal button
    // discloses identity — and Shuffle re-assigns aliases without revealing.
    return { enabled: true, order: shuffle(ids.length ? ids : ['acc', 'plain']), revealed: false };
  });
  const [explorerPanel, setExplorerPanel] = useState(null); // null | panel object
  // Shuffle animation state — true briefly while the aliases swap so the
  // panel cards play the shuffle flip animation.
  const [shuffling, setShuffling] = useState(false);
  const shuffleTimerRef = useRef(null);

  const abortRef = useRef(new Set());
  const battleRef = useRef(battle);
  battleRef.current = battle;
  const startedRef = useRef(false);
  const stoppedRef = useRef(false);
  // Resolvers that reject in-flight panels when the battle is stopped — a
  // Stop click must release the panels immediately, not wait on the provider.
  const stopHandlersRef = useRef(new Set());

  const panels = battle?.panels || [];
  const tasks = battle?.tasks || [];
  const repo = battle?.repo || null;

  /* ------------------------- battle runner ------------------------------- */
  // Each panel runs the agent harness INSIDE its own isolated sandbox copy
  // of the repo (installed at repo load). The server spawns the harness with
  // this panel's provider/model/key and streams its events here — the two
  // sides can never touch each other's files or the original repository.


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
    let output = '';
    let lastChunkAt = Date.now();
    let verified = null;
    let verifyInfo = null;
    // Sandbox terminal log: the agent's activity as terminal lines
    // ({kind:'cmd'|'out'|'reasoning', text}) — shown in the Answer panel
    // while the panel runs.
    const term = [];

    // Consume the harness event stream inside a promise. The stream is ALSO
    // raced against watchdog promises below — a provider that stops responding
    // must never hang the battle forever.
    const consume = (async () => {
      const mode = task.mode === 'plan' ? 'plan' : 'act';
      const done = await runAgent(
        {
          panel: panel.id,
          provider: panel.provider,
          model: panel.model,
          apiKey: key || '',
          mode,
          task: task.prompt,
          context,
          system: systemPrompt(battleRef.current),
          // Act tasks verify the project still runs (the harness asks the
          // agent to start it); plan tasks are plans only — nothing to run.
          // The ACC sandbox is configured once at repo load (acc init/build/
          // fill), so no task needs to set the framework up again.
          verify: mode === 'act',
          maxSteps: 12,
        },
        {
          signal: controller.signal,
          onEvent: (evt) => {
            if (evt.type === 'delta') {
              output += evt.text || '';
              lastChunkAt = Date.now();
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
            } else if (evt.type === 'verify') {
              verified = evt.ok === true;
              verifyInfo = {
                command: evt.command || '',
                output: evt.output || '',
                exitCode: evt.exitCode ?? null,
              };
            } else if (evt.type === 'cmd' || evt.type === 'out' || evt.type === 'reasoning') {
              term.push({ kind: evt.type, text: evt.text || '' });
              // Any activity counts as alive — a reasoning model "thinks" for
              // long stretches with no answer text, and tool calls run while
              // the model is quiet. Only a truly dead provider should trip
              // the idle watchdog.
              lastChunkAt = Date.now();
              if (onLive) onLive({ term: [...term] });
            }
          },
        }
      );
      const doneAt = Date.now();
      const elapsed = done.timeMs != null ? done.timeMs : doneAt - startedAt;
      if (typeof done.verified === 'boolean') verified = done.verified;
      const answerOk = checkSuccess(output, task);
      // Act tasks fail the benchmark when the project no longer runs; plan
      // tasks are judged on the answer alone.
      const success = mode === 'act' ? answerOk && verified === true : answerOk;
      // Provider-reported usage is the default; some providers (free models)
      // never report it, so fall back to estimates from the exact text sent
      // and received (ui/src/estimate.js). Estimated values are flagged so
      // the UI can mark them "(est.)".
      const reportedInput = done.inputTokens ?? null;
      const reportedOutput = done.outputTokens ?? null;
      let inputTokens = reportedInput;
      let outputTokens = reportedOutput;
      if (inputTokens == null) inputTokens = estimateUsage({ system: systemPrompt(battleRef.current), prompt: task.prompt, context }).inputTokens;
      if (outputTokens == null) outputTokens = estimateUsage({ output }).outputTokens;
      const tokensEstimated = inputTokens !== reportedInput || outputTokens !== reportedOutput;
      const cost = inputTokens != null || outputTokens != null
        ? estimateCost(panel.model, inputTokens ?? 0, outputTokens ?? 0, panel.provider)
        : null;
      return {
        status: 'done',
        output,
        timeMs: elapsed,
        ttftMs: firstTokenAt ? firstTokenAt - startedAt : elapsed,
        genMs: firstTokenAt ? doneAt - firstTokenAt : 0,
        inputTokens,
        outputTokens,
        tokensEstimated,
        cost,
        success,
        verified,
        verifyCommand: verifyInfo?.command || '',
        verifyOutput: verifyInfo?.output || '',
        verifyExitCode: verifyInfo?.exitCode ?? null,
        steps: done.steps != null ? done.steps : null,
        samples,
        term,
      };
    })();

    // Reject the panel immediately when the battle is stopped.
    let release;
    const stopped = new Promise((_, reject) => {
      release = () => reject(new Error('battle stopped'));
    });
    stopHandlersRef.current.add(release);

    // Hard deadline: the whole panel (all agent steps) must finish in time.
    let hardTimer;
    const hardLimit = new Promise((_, reject) => {
      hardTimer = setTimeout(() => {
        try {
          controller.abort();
        } catch {
          // ignore
        }
        reject(new Error(`Timed out after ${Math.round(PANEL_TIMEOUT_MS / 1000)}s — the provider did not respond.`));
      }, PANEL_TIMEOUT_MS);
    });

    // Inactivity watchdog: no new chunk for a while means the provider is
    // stuck (or the agent loop stalled) — abort instead of waiting forever.
    let idleTimer;
    const idleLimit = new Promise((_, reject) => {
      const check = () => {
        if (Date.now() - lastChunkAt >= IDLE_TIMEOUT_MS) {
          try {
            controller.abort();
          } catch {
            // ignore
          }
          reject(new Error(`No response for ${Math.round(IDLE_TIMEOUT_MS / 1000)}s — the provider stopped streaming.`));
          return;
        }
        idleTimer = setTimeout(check, IDLE_TIMEOUT_MS);
      };
      check();
    });

    try {
      return await Promise.race([consume, hardLimit, idleLimit, stopped]);
    } finally {
      clearTimeout(hardTimer);
      clearTimeout(idleTimer);
      stopHandlersRef.current.delete(release);
      abortRef.current.delete(controller);
      // The abandoned consume loop (if a watchdog won the race) may still
      // reject later — swallow it so it never surfaces as an unhandled error.
      consume.catch(() => {});
    }
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
      if (prev.enabled) return { ...prev, enabled: false, revealed: true };
      const order = prev.order || shuffle(panels.map((p) => p.id));
      return { enabled: true, order, revealed: false };
    });
  }

  // Re-shuffle the aliases while blind mode is active: each panel gets a new
  // alias, so a judge can re-run the assignment without revealing identity.
  function shufflePanels() {
    setShuffling(true);
    setBlind((prev) => {
      const ids = panels.map((p) => p.id);
      // With two panels a plain Fisher-Yates is a coin flip — half the clicks
      // would keep the same order and look like the button is broken. Keep
      // drawing until the order actually changes (with 2 panels the only
      // meaningful shuffle is a swap), so every click visibly re-shuffles.
      let order = shuffle(ids);
      let guard = 0;
      while (guard++ < 10 && String(order) === String(prev.order || ids)) {
        order = shuffle(ids);
      }
      return { ...prev, order };
    });
    if (shuffleTimerRef.current) clearTimeout(shuffleTimerRef.current);
    shuffleTimerRef.current = setTimeout(() => setShuffling(false), 650);
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

  // Blind mode is active until revealed: the ACC/no-ACC identity stays hidden
  // everywhere (card headers, winners, timeline, summary, file explorers).
  const blinded = blind.enabled && !blind.revealed;
  const panelLabel = (panelId) =>
    blinded ? aliasFor(panelId) : panelId === 'acc' ? 'ACC' : 'no-ACC';

  // Effective view for one card: its own override, or the toolbar default.
  const viewFor = (taskIndex, panelId) => cardViews[`${taskIndex}:${panelId}`] || viewMode;
  // A card's own Code/Answer buttons only affect that card.
  const setCardView = (taskIndex, panelId, mode) =>
    setCardViews((prev) => ({ ...prev, [`${taskIndex}:${panelId}`]: mode }));
  // The toolbar Answer/Code applies to every card — drop per-card overrides.
  const setGlobalView = (mode) => {
    setViewMode(mode);
    setCardViews({});
  };

  async function startBattle() {
    if (!repo || battleStatus === 'running') return;
    stoppedRef.current = false;
    const runId = battle?.id || battle?.repo?.battleId || String(Date.now());
    upsertHistory({
      id: runId,
      battleId: battle?.repo?.battleId || runId,
      ts: Date.now(),
      repoName: battle?.repo?.name,
      repoSource: battle?.repo?.source,
      taskCount: tasks.length,
      status: 'running',
    });
    const panelInit = Object.fromEntries(panels.map((p) => [p.id, { status: 'pending' }]));
    // The ACC sandbox was configured once at repo load (acc init/build/fill),
    // so the battle runs the user's tasks on both ready sandboxes directly.
    // Track the final results locally as well — the React state updates are
    // batched, so reading state right after the loop would miss the last
    // task's finished panels when persisting history.
    const next = tasks.map((t) => ({ task: t, panels: { ...panelInit } }));
    setResults(next);
    setCardViews({});
    setBattleStatus('running');

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      // Panels run ONE AT A TIME (never in parallel) — free/rate-limited
      // providers (NVIDIA NIM, …) reject simultaneous requests with 429 Too
      // Many Requests. The ACC panel finishes its task before the plain panel
      // starts the same one.
      for (const panel of panels) {
        if (stoppedRef.current) break;
        const context = panel.acc ? repo.accContext : repo.baseContext;
        const live = { status: 'running', output: '', term: [], _startedAt: Date.now() };
        next[i].panels[panel.id] = live;
        setPanelResult(i, panel.id, live);
        try {
          const out = await runPanel(
            panel,
            context,
            task,
            (output) => {
              live.output = output;
              setPanelResult(i, panel.id, { status: 'running', output });
            },
            (patch) => {
              Object.assign(live, patch);
              setPanelResult(i, panel.id, patch);
            }
          );
          next[i].panels[panel.id] = out;
          setPanelResult(i, panel.id, out);
        } catch (err) {
          const msg = String(err?.message || err?.name || 'failed');
          const aborted = err?.name === 'AbortError' || /aborted|timed out|timeout|no response|stopped/i.test(msg);
          const errResult = { status: 'error', error: aborted ? msg : `Provider error: ${msg}` };
          next[i].panels[panel.id] = errResult;
          setPanelResult(i, panel.id, errResult);
        }
      }
      if (stoppedRef.current) break;
    }
    if (!stoppedRef.current) {
      // Save the report first so a reload (which replays it) never finds an
      // empty one — then mark the pending snapshot done.
      await persistBattle(next);
      markPendingDone();
    }
    setBattleStatus((prev) => (prev === 'stopped' ? 'stopped' : 'done'));
  }

  // The battle finished — tag the pending snapshot so a reload replays the
  // saved report instead of re-running the whole battle.
  function markPendingDone() {
    try {
      const pending = JSON.parse(localStorage.getItem(PENDING_BATTLE_KEY) || 'null');
      if (pending) {
        pending.status = 'done';
        localStorage.setItem(PENDING_BATTLE_KEY, JSON.stringify(pending));
      }
    } catch {
      // malformed pending battle — ignore
    }
  }

  function stopBattle() {
    stoppedRef.current = true;
    for (const c of abortRef.current) c.abort();
    abortRef.current.clear();
    for (const release of stopHandlersRef.current) release();
    stopHandlersRef.current.clear();
    // Persist whatever results we have so far (report + history).
    persistBattle(results, 'stopped');
    const id = battle?.id || battle?.repo?.battleId;
    if (id) upsertHistory({ id, status: 'stopped' });
    localStorage.removeItem(PENDING_BATTLE_KEY);
    setBattleStatus('stopped');
  }

  async function deleteBattleAndGoBack() {
    if (!window.confirm('Delete this battle and its sandboxes?')) return;
    const id = battle?.repo?.battleId || battle?.id;
    stoppedRef.current = true;
    for (const c of abortRef.current) c.abort();
    abortRef.current.clear();
    for (const release of stopHandlersRef.current) release();
    stopHandlersRef.current.clear();
    try {
      if (id) await deleteBattle(id);
    } catch {
      // server gone — still navigate back
    }
    localStorage.removeItem(PENDING_BATTLE_KEY);
    onBack();
  }

  function persistBattle(final, statusOverride) {
    if (!final.length || !repo) return;
    const comparable = final;
    if (!comparable.length) return;
    const done = comparable.filter((r) => r.panels.acc?.status === 'done' || r.panels.plain?.status === 'done');
    // For stopped or errored battles, still save — just without a verdict.
    const hasResults = done.length > 0 || comparable.some((r) =>
      Object.values(r.panels).some((p) => p?.status === 'done' || p?.status === 'error')
    );
    if (!hasResults) return;
    const accWins = done.filter((r) => {
      const a = r.panels.acc;
      const p = r.panels.plain;
      if (!a || !p || a.status !== 'done' || p.status !== 'done') return false;
      if (a.success !== p.success) return a.success;
      return a.timeMs < p.timeMs;
    }).length;
    const battleStatus = statusOverride || (stoppedRef.current ? 'stopped' : 'done');
    const id = battle?.id || battle?.repo?.battleId || String(Date.now());
    upsertHistory({
      id,
      battleId: repo.battleId || id,
      ts: Date.now(),
      repoName: repo.name,
      repoSource: repo.source,
      taskCount: comparable.length,
      accWins: done.length > 0 ? accWins : undefined,
      verdict: done.length > 0
        ? (accWins > comparable.length / 2 ? 'ACC ahead' : accWins < comparable.length / 2 ? 'no-ACC ahead' : 'tie')
        : undefined,
      status: battleStatus,
    });
    return saveReport({
      battleId: repo.battleId || id,
      repo,
      panels,
      tasks,
      results: final,
      savedAt: new Date().toISOString(),
    }).catch(() => {});
  }

  /* --------------------------- summary ---------------------------------- */

  const summary = useMemo(() => {
    if (results.length === 0) return null;
    // Count every task; panels that errored are failures (not dropped), so a
    // blocked panel shows as a loss instead of vanishing from the analysis.
    const comparable = results;
    if (comparable.length === 0) return null;
    const total = comparable.length;
    const accDone = comparable.filter((r) => r.panels.acc?.status === 'done');
    const plainDone = comparable.filter((r) => r.panels.plain?.status === 'done');
    const acc = accDone.map((r) => r.panels.acc);
    const plain = plainDone.map((r) => r.panels.plain);
    const avg = (arr, f) => {
      const vals = arr.map(f).filter((v) => v != null && Number.isFinite(v));
      return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
    };
    const accWins = comparable.filter((r) => {
      const a = r.panels.acc;
      const p = r.panels.plain;
      if (!a || !p) return false;
      if (a.status !== 'done' && p.status !== 'done') return false; // both failed → nobody wins
      if (a.status !== 'done') return false; // acc failed → plain wins
      if (p.status !== 'done') return true; // plain failed → acc wins
      if (a.success !== p.success) return a.success;
      return (a.timeMs ?? Infinity) < (p.timeMs ?? Infinity);
    }).length;
    return {
      accWins,
      total,
      time: { acc: avg(acc, (r) => r.timeMs), plain: avg(plain, (r) => r.timeMs) },
      tokens: {
        acc: avg(acc, (r) => (r.inputTokens != null || r.outputTokens != null ? (r.inputTokens ?? 0) + (r.outputTokens ?? 0) : null)),
        plain: avg(plain, (r) => (r.inputTokens != null || r.outputTokens != null ? (r.inputTokens ?? 0) + (r.outputTokens ?? 0) : null)),
      },
      cost: { acc: avg(acc, (r) => r.cost), plain: avg(plain, (r) => r.cost) },
      success: { acc: acc.filter((r) => r.success).length, plain: plain.filter((r) => r.success).length },
      // True when any finished panel's numbers came from the estimation
      // fallback (provider reported no usage) — the table marks them '~'.
      tokensEstimated: acc.some((r) => r.tokensEstimated) || plain.some((r) => r.tokensEstimated),
    };
  }, [results]);

  function handleExportReport() {
    const report = {
      battleId: repo.battleId || battle?.id,
      repo,
      panels,
      tasks,
      results,
      savedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `battle-${repo.battleId || battle?.id || 'export'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* --------------------------- lifecycle -------------------------------- */

  useEffect(() => {
    // Guard against React StrictMode double-invoking the effect in dev.
    if (startedRef.current) return;
    // Replay mode: ?battle=<id> — load the saved report and render it as a
    // completed battle. Never starts a live run.
    if (viewReportId) {
      startedRef.current = true;
      loadReport(viewReportId)
        .then((r) => {
          if (!r?.repo) throw new Error('saved report is missing its repository');
          const b = { id: viewReportId, repo: r.repo, panels: r.panels || [], tasks: r.tasks || [] };
          setBattle(b);
          battleRef.current = b;
          setResults(r.results || []);
          setBattleStatus('done');
        })
        .catch((err) => setViewError(err.message || String(err)));
      return;
    }
    if (repo && (battleStatus === 'done' || battleStatus === 'stopped')) {
      // The battle already finished (pending snapshot marked done) — replay
      // the saved report instead of re-running it. If the report is gone
      // (server restarted), stay done with whatever results are left; never
      // restart the battle.
      startedRef.current = true;
      const id = battle?.repo?.battleId || battle?.id;
      loadReport(id)
        .then((r) => {
          if (r?.results) setResults(r.results);
          setBattleStatus('done');
        })
        .catch(() => setBattleStatus('done'));
      return;
    }
    if (repo && battleStatus === 'idle') {
      startedRef.current = true;
      // The sandbox APIs need the repo loaded server-side (server state is
      // lost on restart/refresh). If it's missing, re-load it so the Code
      // view and the agent tools keep working during the battle.
      sandboxTree('acc')
        .catch(() => {
          if (!repo.source) return;
          return loadRepo(repo.source).then((d) => {
            const fresh = {
              ...d.repo,
              baseContext: d.baseContext,
              accContext: d.accContext,
              accPipeline: d.accPipeline || [],
            };
            setBattle({ ...battle, repo: fresh });
            battleRef.current = { ...battle, repo: fresh };
          });
        })
        .finally(() => startBattle())
        // The re-load can fail (server restarted, source unreachable) — the
        // panels will surface that as per-panel errors. Never let it become
        // an unhandled rejection that blanks the whole page.
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Toggle the glowing top-border animation while the battle is running.
  useEffect(() => {
    if (battleStatus === 'running') {
      document.body.classList.add('battle-running');
    } else {
      document.body.classList.remove('battle-running');
    }
    return () => document.body.classList.remove('battle-running');
  }, [battleStatus]);

  // Clear the shuffle animation timer on unmount.
  useEffect(() => () => clearTimeout(shuffleTimerRef.current), []);

  /* --------------------------- render ----------------------------------- */

  if (!battle || !repo) {
    const viewing = !!viewReportId;
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
              {viewing
                ? viewError
                  ? `Could not load this battle: ${viewError}`
                  : 'Loading battle…'
                : 'There is no battle queued. Configure one in the arena first.'}
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

  // Which panel holds the better value for a metric (null on tie or missing).
  // Used to accent the winning side in the averages — never when blinded,
  // since accent is the ACC identity color.
  const better = (accV, plainV, lowerBetter) => {
    if (accV == null || plainV == null || !Number.isFinite(accV) || !Number.isFinite(plainV)) return null;
    if (accV === plainV) return null;
    return (lowerBetter ? accV < plainV : accV > plainV) ? 'acc' : 'plain';
  };
  // Winning value: bold always, accent-colored for ACC unless blinded (the
  // accent is the ACC identity color, so blind mode keeps winners neutral).
  const highlight = (side) => {
    if (!side) return 'text-[var(--color-ink)]';
    if (!blinded && side === 'acc') return 'font-semibold text-[var(--color-accent)]';
    return 'font-semibold text-[var(--color-ink)]';
  };

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
          <div className="flex items-center gap-2">
            {!blinded && (
              <>
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
              </>
            )}
            {battleStatus === 'running' && (
              <button
                onClick={stopBattle}
                className="control-surface flex min-h-9 items-center gap-1.5 px-3 text-[11px] text-red-400 transition-colors hover:border-red-500/40 hover:bg-red-500/10"
                title="Stop this battle"
              >
                <Icon name="stop" className="size-3.5" />
                <span className="hidden sm:inline">Stop</span>
              </button>
            )}
            {battleStatus !== 'idle' && (
              <button
                onClick={deleteBattleAndGoBack}
                className="control-surface flex min-h-9 items-center gap-1.5 px-3 text-[11px] text-[var(--color-ink-faint)] transition-colors hover:border-red-500/40 hover:bg-red-500/10 hover:text-red-400"
                title="Delete this battle and its sandboxes"
              >
                <Icon name="trash" className="size-3.5" />
                <span className="hidden sm:inline">Delete</span>
              </button>
            )}
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
              {repo.name} —{' '}
              <em className={`not-italic ${blinded ? 'text-[var(--color-ink-dim)]' : 'text-[var(--color-accent)]'}`}>
                {blinded ? 'blind battle' : 'ACC vs no-ACC'}
              </em>
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
                        onClick={() => setGlobalView('answer')}
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
                        onClick={() => setGlobalView('code')}
                      >
                        <Icon name="code" className="size-4" />
                        <span className="hidden sm:inline">Code</span>
                      </button>
                    </div>
                    <button
                      onClick={toggleBlind}
                      className={`flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 text-[11px] transition-colors hover:bg-[var(--color-panel-hi)] hover:text-[var(--color-ink)] ${
                        blinded ? 'text-[var(--color-accent)]' : 'text-[var(--color-ink-dim)]'
                      }`}
                      title={blinded ? 'Show which panel runs ACC' : 'Hide which panel runs ACC (blind mode)'}
                      aria-pressed={!blinded}
                    >
                      <Icon name={blinded ? 'eye' : 'eye-off'} className="size-4" />
                      <span>{blinded ? 'Reveal' : 'Blind'}</span>
                    </button>
                    {blinded && (
                      <button
                        onClick={shufflePanels}
                        className="flex min-h-9 items-center gap-1.5 rounded-lg border border-[var(--color-line)] px-3 text-[12px] text-[var(--color-ink-dim)] transition-colors hover:border-[var(--color-accent)]/40 hover:text-[var(--color-accent)]"
                        title="Re-assign which alias is which panel, without revealing identity"
                      >
                        <Icon name="shuffle" className={`size-4 ${shuffling ? 'aba-spin' : ''}`} />
                        <span>Shuffle</span>
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
              className={`grid flex-1 content-start gap-4 py-4 sm:py-5 grid-cols-[repeat(auto-fill,minmax(min(22rem,100%),1fr))] ${shuffling ? 'shuffling' : ''}`}
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
                        {`task ${i + 1}`}
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
                                  <span
                                    key={pid}
                                    className={
                                      blind.enabled && !blind.revealed
                                        ? 'text-[var(--color-ink-dim)]'
                                        : pid === 'acc'
                                          ? 'text-[var(--color-accent)]'
                                          : 'text-[var(--color-ink-dim)]'
                                    }
                                  >
                                    {blind.enabled && !blind.revealed ? aliasFor(pid) : pid === 'acc' ? 'ACC' : 'no-ACC'} · {labels}
                                  </span>
                                );
                              })
                              .reduce((acc, el, idx) => [acc, idx > 0 ? '  ' : '', el], [])}
                          </span>
                        </span>
                      )}
                    </div>
                    {displayOrder.map((p, idx) => (
                      <ResultCard
                        key={p.id}
                        panel={p}
                        result={r.panels[p.id]}
                        context={p.acc ? repo?.accContext : repo?.baseContext}
                        viewMode={viewFor(i, p.id)}
                        onViewMode={(mode) => setCardView(i, p.id, mode)}
                        blind={blind}
                        alias={aliasFor(p.id)}
                        best={winners.get(p.id)}
                        repoName={repo?.name}
                        // Same entrance as the history panel (slide + fade in
                        // from the side) — mirrored so each card comes in
                        // from its own edge.
                        enterFrom={idx === 0 ? 'left' : 'right'}
                      />
                    ))}
                    <div className="col-span-full">
                      <Timeline panels={displayOrder} panelsResult={r.panels} labelFor={blinded ? panelLabel : null} />
                    </div>
                  </React.Fragment>
                );
              })}
            </section>
          </section>

          {/* ============================ SUMMARY ============================ */}
          {summary && (
            <section id="battle-summary" className="aba-fade-in mb-6 overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)]">
              <header className="flex flex-wrap items-center gap-3 border-b border-[var(--color-line)] px-4 py-3.5 sm:px-5">
                <Icon name="trophy" className="size-4 text-[var(--color-accent)]" />
                <div>
                  <h2 className="font-pixel text-[11px] uppercase tracking-[0.14em] text-[var(--color-ink)]">Battle analysis</h2>
                  <p className="mt-0.5 text-[10px] text-[var(--color-ink-faint)]">
                    Heuristic comparison — {blinded ? 'blinded panels' : 'ACC vs no-ACC'}, per round and averaged
                  </p>
                </div>
              </header>

              {/* Per-round metrics — every task with both panels' numbers */}
              <div className="scroll-affordance border-b border-[var(--color-line)]">
                <div id="battle-summary-rounds" className="overflow-x-auto">
                  <table className="w-full min-w-[58rem] text-left text-[11px]">
                    <thead>
                      <tr className="border-b border-[var(--color-line)] bg-[var(--color-panel-hi)]/50 text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-faint)]">
                        <th className="px-4 py-2.5 font-normal">Round</th>
                        <th colSpan={4} className="border-l border-[var(--color-line)] px-4 py-2.5 text-center font-normal">
                          {panelLabel('acc')}
                        </th>
                        <th colSpan={4} className="border-l border-[var(--color-line)] px-4 py-2.5 text-center font-normal">
                          {panelLabel('plain')}
                        </th>
                      </tr>
                      <tr className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-faint)]">
                        <th className="px-4 py-2 font-normal" />
                        <th className="border-l border-[var(--color-line)] px-2 py-2 text-right font-normal">time</th>
                        <th className="px-2 py-2 text-right font-normal" title="input/output tokens">tokens in/out</th>
                        <th className="px-2 py-2 text-right font-normal" title="estimated cost = input×$1 + output×$3 per 1M tokens (fallback pricing)">cost</th>
                        <th className="px-2 py-2 text-center font-normal">pass</th>
                        <th className="border-l border-[var(--color-line)] px-2 py-2 text-right font-normal">time</th>
                        <th className="px-2 py-2 text-right font-normal" title="input/output tokens">tokens in/out</th>
                        <th className="px-2 py-2 text-right font-normal" title="estimated cost = input×$1 + output×$3 per 1M tokens (fallback pricing)">cost</th>
                        <th className="px-2 py-2 text-center font-normal">pass</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.map((r, i) => {
                        const winner = roundWinner(r);
                        // Per-panel cell values for one round.
                        const cells = (panelId) => {
                          const x = r.panels[panelId];
                          if (!x || x.status !== 'done') {
                            return { time: '—', tokens: '—', cost: '—', pass: x?.status === 'error' ? 'fail' : null };
                          }
                          const hasTokens = x.inputTokens != null || x.outputTokens != null;
                          return {
                            time: fmtDur(x.timeMs),
                            // Shown as input/output so the cost math is visible:
                            // output tokens are priced 3× input, so two runs with
                            // the same total can cost very differently.
                            tokens: hasTokens
                              ? `${x.tokensEstimated ? '~' : ''}${fmtInt(x.inputTokens ?? 0)}/${fmtInt(x.outputTokens ?? 0)}`
                              : '—',
                            cost: x.cost != null ? `${x.tokensEstimated ? '~' : ''}${fmtCost(x.cost)}` : '—',
                            pass: x.success ? 'pass' : 'fail',
                          };
                        };
                        const a = cells('acc');
                        const p = cells('plain');
                        const passBadge = (v) =>
                          v === 'pass' ? (
                            <span className="inline-flex size-4 items-center justify-center rounded-full bg-emerald-400/15 text-emerald-400">
                              <Icon name="check" className="size-2.5" />
                            </span>
                          ) : v === 'fail' ? (
                            <span className="inline-flex size-4 items-center justify-center rounded-full bg-red-500/15 text-red-400">
                              <Icon name="x" className="size-2.5" />
                            </span>
                          ) : (
                            <span className="text-[var(--color-ink-faint)]">—</span>
                          );
                        return (
                          <tr key={i} className="border-b border-[var(--color-line)] last:border-0 transition-colors hover:bg-[var(--color-panel-hi)]/40">
                            <td className="px-4 py-2.5">
                              <div className="flex items-center gap-2">
                                <span className="font-pixel text-[10px] uppercase tracking-[0.14em] text-[var(--color-ink-faint)]">{i + 1}</span>
                                <span className="max-w-[14rem] truncate text-[var(--color-ink)]" title={r.task.title}>{r.task.title}</span>
                                {winner && (
                                  <Icon
                                    name="trophy"
                                    className={`size-3.5 shrink-0 ${!blinded && winner === 'acc' ? 'text-[var(--color-accent)]' : 'text-[var(--color-ink-dim)]'}`}
                                    title={`${panelLabel(winner)} wins this round`}
                                  />
                                )}
                              </div>
                            </td>
                            <td className="border-l border-[var(--color-line)] px-2 py-2.5 text-right font-mono tabular-nums text-[var(--color-ink)]">{a.time}</td>
                            <td className="px-2 py-2.5 text-right font-mono tabular-nums text-[var(--color-ink)]" title={a.tokens !== '—' ? 'input/output tokens' : undefined}>{a.tokens}</td>
                            <td className="px-2 py-2.5 text-right font-mono tabular-nums text-[var(--color-ink)]">{a.cost}</td>
                            <td className="px-2 py-2.5 text-center">{passBadge(a.pass)}</td>
                            <td className="border-l border-[var(--color-line)] px-2 py-2.5 text-right font-mono tabular-nums text-[var(--color-ink)]">{p.time}</td>
                            <td className="px-2 py-2.5 text-right font-mono tabular-nums text-[var(--color-ink)]" title={p.tokens !== '—' ? 'input/output tokens' : undefined}>{p.tokens}</td>
                            <td className="px-2 py-2.5 text-right font-mono tabular-nums text-[var(--color-ink)]">{p.cost}</td>
                            <td className="px-2 py-2.5 text-center">{passBadge(p.pass)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="px-4 py-2 text-[10px] leading-relaxed text-[var(--color-ink-faint)]">
                  tokens shown as <code className="font-mono">input/output</code> · cost uses the provider's
                  published rates, falling back to the genai-prices catalog then a generic $1/$3 per 1M (output is
                  typically 3× input, so a run with fewer total tokens but mostly output can cost nearly as much as a
                  longer one). Free and local models show $0. Provider-reported usage replaces these estimates when
                  available.
                </p>
              </div>

              {/* Averages — one tile per metric, better side accented */}
              <div className="grid gap-px bg-[var(--color-line)] sm:grid-cols-2 lg:grid-cols-4">
                {[
                  {
                    label: 'Avg time',
                    acc: fmtDur(summary.time.acc),
                    plain: fmtDur(summary.time.plain),
                    accRaw: summary.time.acc,
                    plainRaw: summary.time.plain,
                    lowerBetter: true,
                  },
                  {
                    label: `Avg tokens${summary.tokensEstimated ? ' (est.)' : ''}`,
                    acc: `${summary.tokensEstimated ? '~' : ''}${fmtInt(summary.tokens.acc)}`,
                    plain: `${summary.tokensEstimated ? '~' : ''}${fmtInt(summary.tokens.plain)}`,
                    accRaw: summary.tokens.acc,
                    plainRaw: summary.tokens.plain,
                    lowerBetter: true,
                  },
                  {
                    label: `Avg cost${summary.tokensEstimated ? ' (est.)' : ''}`,
                    acc: `${summary.tokensEstimated ? '~' : ''}${fmtCost(summary.cost.acc)}`,
                    plain: `${summary.tokensEstimated ? '~' : ''}${fmtCost(summary.cost.plain)}`,
                    accRaw: summary.cost.acc,
                    plainRaw: summary.cost.plain,
                    lowerBetter: true,
                  },
                  {
                    label: 'Heuristic passes',
                    acc: `${summary.success.acc}/${summary.total}`,
                    plain: `${summary.success.plain}/${summary.total}`,
                    accRaw: summary.success.acc,
                    plainRaw: summary.success.plain,
                    lowerBetter: false,
                  },
                ].map((t) => {
                  const b = better(t.accRaw, t.plainRaw, t.lowerBetter);
                  return (
                    <div key={t.label} className="bg-[var(--color-panel)] px-4 py-3">
                      <p className="text-[10px] uppercase tracking-[0.1em] text-[var(--color-ink-faint)]">{t.label}</p>
                      <div className="mt-2 space-y-1.5">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-[10px] text-[var(--color-ink-dim)]">{panelLabel('acc')}</span>
                          <span className={`font-mono text-[11px] tabular-nums ${highlight(b)}`}>{t.acc}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-[10px] text-[var(--color-ink-dim)]">{panelLabel('plain')}</span>
                          <span className={`font-mono text-[11px] tabular-nums ${highlight(b)}`}>{t.plain}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Verdict — the final call, with the export action */}
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-line)] bg-[var(--color-panel-hi)]/40 px-4 py-3.5 sm:px-5">
                <span
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px] ${
                    summary.accWins > summary.total / 2
                      ? 'border-[var(--color-accent)]/30 bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
                      : summary.accWins < summary.total / 2
                        ? 'border-red-500/30 bg-red-500/10 text-red-400'
                        : 'border-[var(--color-line)] text-[var(--color-ink-dim)]'
                  }`}
                >
                  <Icon name="trophy" className="size-3.5" />
                  {summary.accWins > summary.total / 2
                    ? `${panelLabel('acc')} ahead — ${summary.accWins}/${summary.total} tasks better`
                    : summary.accWins < summary.total / 2
                      ? `${panelLabel('plain')} ahead — ${summary.total - summary.accWins}/${summary.total} tasks better`
                      : `tie — ${summary.accWins}/${summary.total}`}
                </span>
                <button onClick={handleExportReport} className="control-surface flex items-center gap-1.5 px-3 py-1.5 text-[11px]">
                  <Icon name="download" className="size-3.5" />
                  <span>Export report</span>
                </button>
              </div>
            </section>
          )}
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
