/**
 * Report API tests — save + load a finished battle report.
 *
 * The server stores reports under ~/.aba-sandbox/reports/battle-<id>.json,
 * keyed by battleId so the history panel can reopen a finished run. Point
 * HOME at a temp dir before importing the server so nothing touches the
 * developer's real sandbox.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aba-report-test-'));
process.env.HOME = tmp;

let server;
let base;

async function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const u = new URL(urlPath, base);
    const r = http.request(
      u,
      {
        method,
        headers: payload ? { 'Content-Type': 'application/json' } : {},
      },
      (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {
            /* non-JSON body */
          }
          resolve({ status: res.statusCode, body: json, raw: data });
        });
      }
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

beforeAll(async () => {
  const { createServer } = await import('../server.cjs');
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('report save/load round-trip', () => {
  it('saves and reloads a report by battleId', async () => {
    const report = {
      battleId: 'abc123',
      repo: { name: 'demo', source: '/tmp/demo', battleId: 'abc123' },
      panels: [{ id: 'acc', acc: true }],
      tasks: [{ title: 'task one' }],
      results: [],
      savedAt: '2026-08-16T00:00:00.000Z',
    };
    const saved = await req('POST', '/api/report', report);
    expect(saved.status).toBe(200);
    expect(saved.body.ok).toBe(true);
    expect(saved.body.file).toContain('battle-abc123.json');

    const loaded = await req('GET', '/api/report?id=abc123');
    expect(loaded.status).toBe(200);
    expect(loaded.body.repo.name).toBe('demo');
    expect(loaded.body.tasks[0].title).toBe('task one');
  });

  it('names the report by repo.battleId when battleId is nested only', async () => {
    const report = { repo: { name: 'demo', battleId: 'xyz789' }, results: [] };
    const saved = await req('POST', '/api/report', report);
    expect(saved.body.file).toContain('battle-xyz789.json');
    const loaded = await req('GET', '/api/report?id=xyz789');
    expect(loaded.status).toBe(200);
  });

  it('rejects an invalid battle id', async () => {
    const res = await req('GET', '/api/report?id=../escape');
    expect(res.status).toBe(400);
  });

  it('404s for a battle with no saved report', async () => {
    const res = await req('GET', '/api/report?id=nosuchbattle');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('no saved report');
  });
});

describe('agent run error forwarding', () => {
  // Load a tiny git repo (the importer needs a commit sha), then replace the
  // sandbox harness with a fake one that emits a REAL error event and exits
  // 1 — the case a provider rejection produces. The server must forward the
  // real message and NOT append the generic "harness exited with code 1"
  // fallback (which would overwrite it client-side).
  it('keeps the harness error message when the harness exits non-zero', async () => {
    const repoDir = fs.mkdtempSync(path.join(tmp, 'repo-'));
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'fake', scripts: { start: 'echo ok' } }));
    fs.writeFileSync(path.join(repoDir, 'index.js'), 'module.exports = 1;\n');
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    execFileSync('git', ['add', '-A'], { cwd: repoDir });
    execFileSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: repoDir });

    // POST /api/repo streams NDJSON; the done event carries the battleId.
    const load = await new Promise((resolve, reject) => {
      const r = http.request(
        new URL('/api/repo', base),
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (res) => {
          let data = '';
          res.on('data', (d) => (data += d));
          res.on('end', () => resolve(data));
        }
      );
      r.on('error', reject);
      r.write(JSON.stringify({ source: repoDir, type: 'local' }));
      r.end();
    });
    const doneEvt = load
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((e) => e.type === 'done');
    expect(doneEvt).toBeTruthy();
    const battleId = doneEvt.repo.battleId;

    // Replace the acc sandbox's harness with a fake that errors loudly.
    const harnessPath = path.join(tmp, '.aba-sandbox', 'battles', battleId, 'acc', '.aba-agent.cjs');
    fs.writeFileSync(
      harnessPath,
      `process.stdout.write(JSON.stringify({ type: 'error', message: 'the real provider error' }) + '\\n');\nprocess.exit(1);\n`
    );

    const run = await new Promise((resolve, reject) => {
      const r = http.request(
        new URL('/api/agent/run', base),
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (res) => {
          let data = '';
          res.on('data', (d) => (data += d));
          res.on('end', () => resolve(data));
        }
      );
      r.on('error', reject);
      r.write(
        JSON.stringify({
          panel: 'acc',
          provider: 'ollama', // needsKey: false — no API key required
          model: 'fake-model',
          mode: 'plan',
          task: 'do it',
          context: 'ctx',
        })
      );
      r.end();
    });

    const events = run
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const errors = events.filter((e) => e.type === 'error');
    expect(errors.length).toBe(1);
    expect(errors[0].message).toBe('the real provider error');
    expect(run).not.toContain('harness exited with code');
  });
});
