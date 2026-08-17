/**
 * Integration: the full user flow, end to end.
 *
 *   1. Load repo          → ACC init, build, fill, graph, context
 *   2. Battle page        → sandboxes ready, contexts populated
 *   3. Run harness        → agent streams terminal output (plan task)
 *   4. Results            → agent finishes, output captured
 *
 * Server: running on :4317  |  Repo: table-of-cannabinoids
 * Model:  nvidia/llama-3.3-nemotron-super-49b-v1.5  (free, tools)
 *
 * Run:  npx vitest run src/__tests__/integration.test.mjs
 */

import { describe, it, expect, beforeAll } from 'vitest';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── .env ──────────────────────────────────────────────────────────────────
const envFile = path.join(import.meta.dirname, '..', '..', '.env');
try {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
} catch { /* no .env */ }

const PORT       = 4317;
const BASE       = `http://127.0.0.1:${PORT}`;
const SANDBOX    = path.join(os.homedir(), '.aba-sandbox');
const NVIDIA_KEY = process.env.TEST_NVIDIA_KEY || '';
const MODEL      = 'nvidia/nemotron-3-nano-30b-a3b';
const REPO_URL   = 'https://github.com/EnzoVezzaro/table-of-cannabinoids';

/* ── shared state across the flow ─────────────────────────────────────── */
let result = null;          // filled after step 1, used by steps 2-4

/* ── HTTP helpers ─────────────────────────────────────────────────────── */

function ndjson(urlPath, body, timeout = 300000) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout,
    }, (res) => {
      let buf = '';
      const events = [];
      let last = null;
      const flush = () => {
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const l of lines) {
          if (!l.trim()) continue;
          try { const e = JSON.parse(l); events.push(e); last = e; } catch { /* partial line */ }
        }
      };
      res.on('data', (d) => { buf += d.toString(); flush(); });
      res.on('end', () => { flush(); resolve({ status: res.statusCode, events, last }); });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function get(urlPath, timeout = 10000) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${urlPath}`, { timeout }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    }).on('error', reject);
  });
}

function postJSON(urlPath, body, timeout = 10000) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${urlPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout,
    }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/* ════════════════════════════════════════════════════════════════════════ */
/*  STEP 1 · LOAD REPO — ACC init → build → fill → graph → context        */
/* ════════════════════════════════════════════════════════════════════════ */

describe('Step 1 — Load repo + ACC pipeline', () => {

  it('loads the repo and runs all ACC steps', async () => {
    const { status, events, last } = await ndjson('/api/repo', { source: REPO_URL });

    expect(status).toBe(200);
    expect(last).toBeDefined();
    expect(last.type).toBe('done');

    const steps = events.filter((e) => e.type === 'step');

    // Step 1 — import
    const imp = steps.find((s) => s.step === 1 && s.ok === true);
    expect(imp).toBeDefined();
    expect(last.repo.name).toBe('table-of-cannabinoids');

    // Step 2 — sandboxes created
    expect(steps.find((s) => s.step === 2 && s.ok)).toBeTruthy();

    // ACC pipeline: all five steps succeeded
    expect(steps.find((s) => s.label === 'acc init'                && s.ok)).toBeTruthy();
    expect(steps.find((s) => s.label === 'acc build (contracts)'   && s.ok)).toBeTruthy();
    expect(steps.find((s) => s.label === 'acc fill (fill directive)' && s.ok)).toBeTruthy();
    expect(steps.find((s) => s.label === 'acc graph (scan)'        && s.ok)).toBeTruthy();
    expect(steps.find((s) => s.label === 'acc context (prepare)'   && s.ok)).toBeTruthy();

    // Step 7 — harness installed + self-check
    const harness = steps.find((s) => s.step === 7 && s.ok);
    expect(harness).toBeTruthy();
    expect(harness.detail).toContain('self-check passed');

    // Contexts are populated
    expect(last.baseContext.length).toBeGreaterThan(50);
    expect(last.accContext.length).toBeGreaterThan(50);
    expect(last.accPipeline.length).toBeGreaterThanOrEqual(5);
    expect(last.harness.installed).toBe(true);

    result = last;
    console.log(`  ✓ battleId=${result.repo.battleId}  acc=${result.accContext.length}  plain=${result.baseContext.length}  accSteps=${result.accPipeline.length}`);
  }, 300000);
});

/* ════════════════════════════════════════════════════════════════════════ */
/*  STEP 2 · BATTLE PAGE — sandboxes ready, file trees accessible          */
/* ════════════════════════════════════════════════════════════════════════ */

describe('Step 2 — Battle page (sandboxes ready)', () => {

  it('ACC sandbox has .acc directory', async () => {
    const { body } = await get('/api/sandbox/acc/tree?path=/');
    expect(body.tree.map((e) => e.path)).toContain('.acc');
  });

  it('plain sandbox does NOT have .acc', async () => {
    const { body } = await get('/api/sandbox/plain/tree?path=/');
    expect(body.tree.map((e) => e.path)).not.toContain('.acc');
  });

  it('both sandboxes have repo files', async () => {
    const acc   = await get('/api/sandbox/acc/tree?path=/');
    const plain = await get('/api/sandbox/plain/tree?path=/');
    for (const f of ['cannabinoids.js', 'index.html', 'README.md', 'script.js']) {
      expect(acc.body.tree.map((e) => e.path)).toContain(f);
      expect(plain.body.tree.map((e) => e.path)).toContain(f);
    }
  });

  it('both sandboxes have .aba-agent.cjs installed', async () => {
    expect(result).not.toBeNull();
    expect(fs.existsSync(path.join(SANDBOX, 'battles', result.repo.battleId, 'acc',   '.aba-agent.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(SANDBOX, 'battles', result.repo.battleId, 'plain', '.aba-agent.cjs'))).toBe(true);
  });

  it('can read file content from sandbox', async () => {
    const { body } = await get('/api/sandbox/acc/file?path=cannabinoids.js');
    expect(body.content).toBeDefined();
    expect(body.content.length).toBeGreaterThan(10);
  });

  it('ACC file does NOT leak to plain sandbox', async () => {
    await postJSON('/api/sandbox/acc/file?path=_isolation_test.txt', { content: 'ACC only' });
    const { status } = await get('/api/sandbox/plain/file?path=_isolation_test.txt');
    expect(status).toBe(404);
  });

  it('rejects path escapes', async () => {
    const { status } = await get('/api/sandbox/acc/file?path=../../etc/passwd');
    expect(status).toBe(403);
  });
});

/* ════════════════════════════════════════════════════════════════════════ */
/*  STEP 3 + 4 · RUN HARNESS — agent streams output, then results         */
/* ════════════════════════════════════════════════════════════════════════ */

describe('Step 3+4 — Run harness → results', () => {

  it('ACC panel — agent reads files and produces a summary', async () => {
    if (!NVIDIA_KEY) { console.log('  SKIP: TEST_NVIDIA_KEY not set'); return; }
    expect(result).not.toBeNull();

    const { status, events, last } = await ndjson('/api/agent/run', {
      panel: 'acc',
      provider: 'nvidia',
      model: MODEL,
      apiKey: NVIDIA_KEY,
      mode: 'plan',
      task: 'List the files and summarize what this repository does in 2 sentences.',
      context: result.accContext,
      maxSteps: 8,
      maxTokens: 2000,
    }, 300000);

    // Log errors before asserting so we can see what happened
    if (status !== 200 || !last || last.type !== 'done') {
      console.log('  FAILED — status:', status, 'last:', JSON.stringify(last)?.slice(0, 300));
      console.log('  events:', JSON.stringify(events.slice(0, 10)));
    }

    expect(status).toBe(200);
    expect(last).toBeDefined();
    expect(last.type).toBe('done');
    expect(last.steps).toBeGreaterThan(0);

    // Terminal output shows file listings and a summary
    const cmds = events.filter((e) => e.type === 'cmd');
    expect(cmds.length).toBeGreaterThan(0);

    const outs = events.filter((e) => e.type === 'out');
    expect(outs.length).toBeGreaterThan(0);

    console.log(`  ✓ ACC plan: ${last.steps} steps  ${last.timeMs}ms`);
    console.log(`    terminal cmds: ${cmds.map((c) => c.text).join(' | ')}`);
    console.log(`    output: "${last.output.slice(0, 200)}"`);
  }, 310000);

  it('plain panel — same task, no ACC context', async () => {
    if (!NVIDIA_KEY) { console.log('  SKIP: TEST_NVIDIA_KEY not set'); return; }
    expect(result).not.toBeNull();

    const { status, events, last } = await ndjson('/api/agent/run', {
      panel: 'plain',
      provider: 'nvidia',
      model: MODEL,
      apiKey: NVIDIA_KEY,
      mode: 'plan',
      task: 'List the files and summarize what this repository does in 2 sentences.',
      context: result.baseContext,
      maxSteps: 8,
      maxTokens: 2000,
    }, 300000);

    if (status !== 200 || !last || last.type !== 'done') {
      console.log('  FAILED — status:', status, 'last:', JSON.stringify(last)?.slice(0, 300));
      console.log('  events:', JSON.stringify(events.slice(0, 10)));
    }

    expect(status).toBe(200);
    expect(last).toBeDefined();
    expect(last.type).toBe('done');
    expect(last.steps).toBeGreaterThan(0);

    console.log(`  ✓ Plain plan: ${last.steps} steps  ${last.timeMs}ms`);
    console.log(`    output: "${last.output.slice(0, 200)}"`);
  }, 310000);
});
