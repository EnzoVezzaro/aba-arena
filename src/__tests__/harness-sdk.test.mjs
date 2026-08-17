/**
 * Harness × AI SDK regression test.
 *
 * Spins up a FAKE OpenAI-compatible /v1/chat/completions server (SSE) and
 * runs the REAL harness (src/harness.cjs) against it with the SDK resolved
 * from ui/node_modules (NODE_PATH — same as the sandbox spawn). The fake
 * stream includes `reasoning_content` deltas and a `tool_calls` chunk, so
 * this exercises the AI SDK v5 parts the harness depends on: text-delta,
 * reasoning-delta (with `text`, not `textDelta`) and the tool loop.
 *
 * No external provider, no keys — the whole LLM path is local.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HARNESS = path.join(ROOT, 'src', 'harness.cjs');
const UI_NODE_MODULES = path.join(ROOT, 'ui', 'node_modules');

function sse(...chunks) {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
}

function deltaChunk(partial) {
  return { id: '1', object: 'chat.completion.chunk', created: 0, model: 'fake', choices: [{ index: 0, delta: partial, finish_reason: null }] };
}

function buildFakeServer() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const payload = JSON.parse(body || '{}');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const hasToolResult = (payload.messages || []).some((m) => m.role === 'tool');
      if (hasToolResult) {
        // Second round trip: the harness executed list_files — reply with the
        // final answer (plus a reasoning delta to prove reasoning-delta flows).
        res.end(
          sse(
            deltaChunk({ reasoning_content: 'reasoning about the tree' }),
            deltaChunk({ content: 'Here is the plan.' }),
            deltaChunk({})
          )
        );
        return;
      }
      // First round trip: stream a tool call for list_files.
      res.end(
        sse(
          deltaChunk({ reasoning_content: 'thinking which tool to use' }),
          deltaChunk({
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'list_files', arguments: '{"path":""}' },
              },
            ],
          }),
          deltaChunk({})
        )
      );
    });
  });
}

async function runHarness(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HARNESS], {
      cwd: env.CWD,
      env: { ...process.env, NODE_PATH: UI_NODE_MODULES, ...env },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
    setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('harness timed out'));
    }, 30000);
  });
}

// A fake server that answers EVERY request with HTTP 400 — like NVIDIA NIM
// rejecting a request (e.g. a model that doesn't support the requested
// params). AI SDK v5 surfaces this as an `error` part in fullStream and then
// closes the stream NORMALLY; the harness must not swallow it into a fake
// "done" with empty output (the silent-failure bug this test guards).
function buildErrorServer() {
  return http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'model does not support tool calling', type: 'invalid_request_error' } }));
    });
  });
}

let server;
let base;
let errorServer;
let errorBase;
let sandboxDir;

beforeAll(async () => {
  server = buildFakeServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/v1`;
  errorServer = buildErrorServer();
  await new Promise((r) => errorServer.listen(0, '127.0.0.1', r));
  errorBase = `http://127.0.0.1:${errorServer.address().port}/v1`;
  sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aba-harness-sdk-'));
  fs.mkdirSync(path.join(sandboxDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(sandboxDir, 'package.json'), JSON.stringify({ name: 'fake-repo', scripts: { start: 'echo ok' } }));
  fs.writeFileSync(path.join(sandboxDir, 'src', 'index.js'), 'module.exports = 42;\n');
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => errorServer.close(r));
  fs.rmSync(sandboxDir, { recursive: true, force: true });
});

describe('harness on AI SDK v5 (fake OpenAI-compatible endpoint)', () => {
  it('streams text + reasoning, runs the tool loop and finishes with done', async () => {
    const { code, out } = await runHarness({
      CWD: sandboxDir,
      ABA_KIND: 'openai-compatible',
      ABA_BASE_URL: base,
      ABA_API_KEY: 'test-key',
      ABA_MODEL: 'fake-model',
      ABA_MODE: 'plan',
      ABA_TASK: 'Produce a plan.',
      ABA_CONTEXT: 'context',
      ABA_MAX_STEPS: '3',
      ABA_MAX_TOKENS: '2000',
      ABA_TRACE: '1',
    });
    expect(code).toBe(0);
    const events = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const types = events.map((e) => e.type);
    // The tool loop ran: the harness emitted the list_files call as a cmd…
    expect(events.find((e) => e.type === 'cmd' && e.text.startsWith('list_files'))).toBeTruthy();
    // …then the fake answered; the final text delta reached the output.
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeTruthy();
    expect(done.output).toContain('Here is the plan.');
    expect(done.steps).toBeGreaterThanOrEqual(2);
    // reasoning_content deltas surfaced as reasoning events (v5: reasoning-delta)
    expect(events.some((e) => e.type === 'reasoning' && e.text.length > 0)).toBe(true);
    expect(types.filter((t) => t === 'error')).toEqual([]);
  });

  it('surfaces a provider HTTP error instead of a fake done with empty output', async () => {
    const { code, out } = await runHarness({
      CWD: sandboxDir,
      ABA_KIND: 'openai-compatible',
      ABA_BASE_URL: errorBase,
      ABA_API_KEY: 'test-key',
      ABA_MODEL: 'z-ai/glm-5.2',
      ABA_MODE: 'plan',
      ABA_TASK: 'Summarize the repo.',
      ABA_CONTEXT: 'context',
      ABA_MAX_STEPS: '3',
      ABA_MAX_TOKENS: '2000',
    });
    // The harness must exit non-zero with an error event — never a
    // "successful" done carrying an empty output.
    expect(code).not.toBe(0);
    const events = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const err = events.find((e) => e.type === 'error');
    expect(err).toBeTruthy();
    expect(err.message).toContain('model does not support tool calling');
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });
});
