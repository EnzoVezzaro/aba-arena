import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  health,
  loadRepo,
  sandboxTree,
  sandboxRead,
  runAgent,
} from '../api.js';
import { DEFAULT_TASKS, checkSuccess } from '../tasks.js';
import { computeWinners, extractAnswer, extractCode } from '../arena.js';
import { makePanel, INITIAL_PANELS } from '../components.jsx';
import { fetchProviderModels } from '../providers.js';

describe('E2E: Battle Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe('Health check', () => {
    it('calls /api/health', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      });

      const result = await health();
      expect(result.ok).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/health',
        expect.objectContaining({ headers: expect.any(Object) })
      );
    });
  });

  describe('Load repo', () => {
    it('loads repo with source', async () => {
      const mockResponse = {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn()
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode(JSON.stringify({ type: 'step', step: 'import', label: 'Importing' }) + '\n'),
              })
              .mockResolvedValueOnce({
                done: false,
                value: new TextEncoder().encode(JSON.stringify({ type: 'done', repo: { name: 'test' }, context: 'ctx' }) + '\n'),
              })
              .mockResolvedValueOnce({ done: true }),
          }),
        },
      };
      globalThis.fetch.mockResolvedValue(mockResponse);

      const events = [];
      const result = await loadRepo(
        { type: 'local', pathOrUrl: './test' },
        {},
        (e) => events.push(e)
      );

      expect(result).toBeDefined();
      expect(result.type).toBe('done');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('step');
    });
  });

  describe('Sandbox tree', () => {
    it('fetches sandbox tree for panel', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ tree: [{ name: 'file.js', type: 'file' }] }),
      });

      const result = await sandboxTree('acc');
      expect(result.tree).toBeDefined();
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/sandbox/acc/tree'),
        expect.any(Object)
      );
    });
  });

  describe('Sandbox read', () => {
    it('reads file from sandbox', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ content: 'file content' }),
      });

      const result = await sandboxRead('acc', 'file.js');
      expect(result.content).toBe('file content');
    });
  });

  describe('Run agent', () => {
    it('streams agent events', async () => {
      const events = [
        { type: 'delta', text: 'Hello' },
        { type: 'delta', text: ' World' },
        { type: 'done', success: true },
      ];

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          events.forEach((e) => {
            controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
          });
          controller.close();
        },
      });

      globalThis.fetch.mockResolvedValue({
        ok: true,
        body: stream,
      });

      const receivedEvents = [];
      const result = await runAgent(
        {
          panelId: 'acc',
          context: 'test context',
          task: 'test task',
          model: 'gpt-4o',
          provider: 'openai',
        },
        {
          signal: AbortSignal.timeout(5000),
          onEvent: (e) => receivedEvents.push(e),
        }
      );

      expect(receivedEvents.length).toBe(2);
      expect(result).toEqual({ type: 'done', success: true });
    });
  });

  describe('Task success checking', () => {
    it('validates all default tasks', () => {
      DEFAULT_TASKS.forEach((task) => {
        expect(task.title).toBeDefined();
        expect(task.prompt).toBeDefined();
        expect(task.hints).toBeDefined();
        expect(task.minChars).toBeGreaterThan(0);
        expect(['plan', 'act']).toContain(task.mode);
      });
    });

    it('checks success with matching hint', () => {
      const task = DEFAULT_TASKS[0];
      const output = 'This repository has a modular architecture with components and services working together. It follows coding conventions and style rules for consistent development patterns.';
      expect(checkSuccess(output, task)).toBe(true);
    });

    it('fails success check with short output', () => {
      const task = DEFAULT_TASKS[0];
      expect(checkSuccess('short', task)).toBe(false);
    });
  });

  describe('Winner computation', () => {
    it('computes winners from completed panels', () => {
      const panels = [
        { id: 'acc', timeMs: 100, genMs: 100, cost: 0.01, outputTokens: 1000 },
        { id: 'plain', timeMs: 200, genMs: 200, cost: 0.02, outputTokens: 500 },
      ];

      const winners = computeWinners(panels);
      expect(winners.get('acc').fast).toBe(true);
      expect(winners.get('acc').cheap).toBe(true);
      expect(winners.get('acc').tput).toBe(true);
    });

    it('handles ties correctly', () => {
      const panels = [
        { id: 'acc', timeMs: 100, cost: 0.01 },
        { id: 'plain', timeMs: 100, cost: 0.01 },
      ];

      const winners = computeWinners(panels);
      expect(winners.get('acc').fast).toBe(false);
      expect(winners.get('plain').fast).toBe(false);
    });
  });

  describe('Answer extraction', () => {
    it('extracts prose from mixed content', () => {
      const text = 'Here is my answer:\n```js\nconst x = 1;\n```\nThat was the code.';
      const answer = extractAnswer(text);
      expect(answer).toContain('Here is my answer:');
      expect(answer).toContain('That was the code.');
      expect(answer).not.toContain('const x = 1;');
    });

    it('extracts code blocks', () => {
      const text = '```js\nconst x = 1;\n```';
      const code = extractCode(text);
      expect(code).toBe('const x = 1;');
    });

    it('handles HTML documents', () => {
      const html = '<!DOCTYPE html>\n<html><body>Hello</body></html>';
      const code = extractCode(html);
      expect(code).toContain('<!DOCTYPE html>');
    });
  });

  describe('Panel configuration', () => {
    it('creates valid panels', () => {
      const accPanel = makePanel('acc', true, 'ACC Panel');
      const plainPanel = makePanel('plain', false, 'Plain Panel');

      expect(accPanel.acc).toBe(true);
      expect(plainPanel.acc).toBe(false);
      expect(accPanel.id).toBe('acc');
      expect(plainPanel.id).toBe('plain');
    });

    it('has correct initial panels', () => {
      expect(INITIAL_PANELS).toHaveLength(2);
      expect(INITIAL_PANELS[0].acc).toBe(true);
      expect(INITIAL_PANELS[1].acc).toBe(false);
    });
  });

  describe('Battle history persistence', () => {
    it('saves and loads battle history', async () => {
      const { saveHistory, loadHistory } = await import('../components.jsx');
      const battle = {
        id: 'test-battle-1',
        ts: Date.now(),
        repoName: 'test-repo',
        taskCount: 4,
        status: 'done',
      };

      saveHistory([battle]);
      const history = loadHistory();
      expect(history).toHaveLength(1);
      expect(history[0].id).toBe('test-battle-1');
    });

    it('limits history to MAX_HISTORY', async () => {
      const { saveHistory, loadHistory, MAX_HISTORY } = await import('../components.jsx');
      const battles = Array.from({ length: MAX_HISTORY + 10 }, (_, i) => ({
        id: `battle-${i}`,
        ts: Date.now() + i,
      }));

      saveHistory(battles);
      const history = loadHistory();
      expect(history.length).toBeLessThanOrEqual(MAX_HISTORY);
    });

    it('flags models without tool calling from the live OpenRouter list', async () => {
      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              { id: 'openai/gpt-4o', supported_parameters: ['temperature', 'tools'] },
              { id: 'vendor/reasoner-x', supported_parameters: ['temperature'] },
              { id: 'legacy/reasoner', supported_parameters: { tools: false } },
            ],
          }),
      });
      const rows = await fetchProviderModels('openrouter', '');
      const byId = Object.fromEntries(rows.map((r) => [r.id, r.tools]));
      expect(byId['openai/gpt-4o']).toBe(null); // tools supported → unknown-but-capable
      expect(byId['vendor/reasoner-x']).toBe(false); // array without 'tools'
      expect(byId['legacy/reasoner']).toBe(false); // legacy object format
    });

    it('loads a saved battle report (reopen a finished run)', async () => {
      const { loadReport } = await import('../api.js');
      const report = { repo: { name: 'demo' }, panels: [], tasks: [], results: [] };
      globalThis.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(report),
      });

      const loaded = await loadReport('battle-abc123');
      expect(loaded.repo.name).toBe('demo');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/api/report?id=battle-abc123',
        expect.objectContaining({ headers: expect.any(Object) })
      );
    });
  });
});
