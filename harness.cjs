#!/usr/bin/env node
/**
 * ABA agent harness — the coding agent that runs INSIDE each sandbox.
 *
 * Modeled on mini-coding-agent's agentic loop (read → think → act → verify),
 * but wired to the AI SDK with a CUSTOM BASE URL so every ABA provider works
 * (OpenAI, NVIDIA, Groq, OpenRouter, …) — the same providers.js config the
 * browser uses. The harness is copied into each battle sandbox at repo load
 * ("installed in the sandbox"); the server spawns it with the panel's
 * provider/model/key and streams its NDJSON events to the battle page.
 *
 * Config via env (set by the server when spawning):
 *   ABA_BASE_URL   — custom OpenAI-compatible base URL (e.g. .../v1)
 *   ABA_API_KEY    — provider key
 *   ABA_MODEL      — model id
 *   ABA_KIND       — 'openai-compatible' | 'anthropic'
 *   ABA_MODE       — 'plan' | 'act'
 *   ABA_TASK       — the task prompt
 *   ABA_CONTEXT    — repository context (baseContext / accContext)
 *   ABA_SYSTEM     — optional system prompt override
 *   ABA_VERIFY     — '1' to run the "start the project" check after act
 *   ABA_MAX_STEPS  — max agent loop steps (default 12)
 *
 * Events emitted to stdout as NDJSON (one JSON object per line):
 *   {"type":"delta","text":"..."}          streamed answer text
 *   {"type":"reasoning","text":"..."}      model reasoning (shown dimmed)
 *   {"type":"cmd","text":"..."}            a tool call as a terminal command ($ …)
 *   {"type":"out","text":"..."}            a tool result as terminal output
 *   {"type":"verify","ok":true,"command":"npm start","output":"...","exitCode":0}
 *   {"type":"done","output":"...","verified":true,"timeMs":123,"steps":4}
 *   {"type":"error","message":"..."}
 *
 * Special modes:
 *   --selfcheck  — no LLM call: verify the harness boots, tools resolve and
 *                  the sandbox dir is listable. Prints {"type":"selfcheck","ok":true}.
 */

const { tool, streamText } = require('ai');
const { createOpenAICompatible } = require('@ai-sdk/openai-compatible');
const { createAnthropic } = require('@ai-sdk/anthropic');
const { z } = require('zod');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CWD = process.cwd();

/* ------------------------------------------------------------------ util */

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function fmtErr(e) {
  return String((e && e.message) || e || 'unknown error');
}

function summarizeArgs(args) {
  if (args == null) return '';
  const s = typeof args === 'string' ? args : JSON.stringify(args);
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

// Render a tool call as the command line the user would type in the terminal.
function renderCmd(name, args = {}) {
  if (name === 'bash' || name === 'start') return String(args.command || '');
  if (name === 'write_file') {
    const len = String(args.content || '').length;
    return `write_file ${args.path}${len ? ` (${len} bytes)` : ''}`;
  }
  const arg = args.path || args.command || '';
  return `${name}${arg ? ` ${arg}` : ''}`;
}

// Emit the agent's activity as terminal events — model reasoning (·), tool
// calls ($ cmd) and their results (output). The battle page renders these as
// the sandbox terminal in the Answer panel while a panel is running.
function emitStep(step) {
  if (step && typeof step.reasoning === 'string' && step.reasoning.trim()) {
    emit({ type: 'reasoning', text: step.reasoning.slice(0, 2000) });
  }
  for (const tc of step?.toolCalls || []) {
    emit({ type: 'cmd', text: renderCmd(tc.toolName, tc.args) });
  }
  for (const tr of step?.toolResults || []) {
    let out = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result);
    if (out.length > 2000) out = out.slice(0, 2000) + '\n… truncated';
    emit({ type: 'out', text: out });
  }
}

/* ------------------------------------------------------------------ tools */

// All tools operate relative to the sandbox dir (the process cwd). Paths are
// confined lexically so a tool call can never escape the sandbox.
function safeResolve(rel) {
  const target = path.resolve(CWD, String(rel || '').replace(/^\/+/, ''));
  if (target !== CWD && !target.startsWith(CWD + path.sep)) {
    throw new Error('path escapes the sandbox');
  }
  return target;
}

function listTree(root, prefix = '') {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  entries
    .filter((e) => !['.git', 'node_modules', 'dist', 'build', 'coverage'].includes(e.name))
    .sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
    .forEach((e) => {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        const children = listTree(path.join(root, e.name), rel);
        out.push(`[d] ${rel}/`);
        out.push(...children);
      } else {
        let size = 0;
        try {
          size = fs.statSync(path.join(root, e.name)).size;
        } catch {
          /* ignore */
        }
        out.push(`[f] ${rel} (${size}b)`);
      }
    });
  return out;
}

const SKIP_TOOL = /\.git|node_modules|\/dist\/|\.DS_Store/i;

function buildTools(mode) {
  const tools = {
    list_files: tool({
      description:
        'List the files and folders in the repository (relative to the repo root). Use this to explore the codebase before editing. Returns a tree of paths.',
      parameters: z.object({
        path: z.string().optional().describe('subdirectory to list, relative to repo root (e.g. src)'),
      }),
      execute: async ({ path: sub = '' }) => {
        const target = safeResolve(sub);
        const tree = listTree(target, sub.replace(/^\/+/, ''));
        return tree.length ? tree.join('\n') : `no files at ${sub || '/'}`;
      },
    }),
    read_file: tool({
      description: 'Read the full contents of a file from the repository. Use this before editing so you see the real code.',
      parameters: z.object({
        path: z.string().describe('path to the file, relative to repo root (e.g. src/index.js)'),
      }),
      execute: async ({ path: filePath }) => {
        if (SKIP_TOOL.test(filePath)) return 'that path is not readable in the sandbox';
        const target = safeResolve(filePath);
        if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return `no such file: ${filePath}`;
        const content = fs.readFileSync(target, 'utf8');
        return `--- ${filePath} ---\n${content}`;
      },
    }),
  };

  if (mode === 'act') {
    tools.write_file = tool({
      description:
        'Write a file in the repository (creates parent directories; overwrites existing files). Use this to make the code changes the task requires.',
      parameters: z.object({
        path: z.string().describe('path to the file, relative to repo root (e.g. src/index.js)'),
        content: z.string().describe('the complete new file content'),
      }),
      execute: async ({ path: filePath, content }) => {
        if (SKIP_TOOL.test(filePath)) return 'that path is not writable in the sandbox';
        const target = safeResolve(filePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, String(content), 'utf8');
        return `wrote ${filePath} (${String(content).length} bytes)`;
      },
    });
    tools.delete_file = tool({
      description: 'Delete a file from the repository.',
      parameters: z.object({
        path: z.string().describe('path to the file, relative to repo root'),
      }),
      execute: async ({ path: filePath }) => {
        if (SKIP_TOOL.test(filePath)) return 'that path is not deletable in the sandbox';
        const target = safeResolve(filePath);
        if (!fs.existsSync(target)) return `no such file: ${filePath}`;
        fs.rmSync(target, { force: true });
        return `deleted ${filePath}`;
      },
    });
    tools.bash = tool({
      description:
        'Run a shell command inside the repository (e.g. npm test, npm run build, git status). Use this to run tests, build, or start the project. Returns exit code + output.',
      parameters: z.object({
        command: z.string().describe('the shell command to run'),
        timeoutMs: z.number().optional().describe('kill the command after this many ms (default 30000)'),
      }),
      execute: ({ command, timeoutMs = 30000 }) => runBash(command, timeoutMs),
    });
  }

  return tools;
}

// Bash tool: capture exit code + output. A command that is still running when
// the timeout hits (e.g. a dev server) is reported with exitCode null and
// timedOut true — the verify step treats a still-alive process as "running".
function runBash(command, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: CWD, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, Math.max(1000, Number(timeoutMs) || 30000));
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, timedOut: false, output: `failed to run: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const trimmed = out.trim().slice(-4000);
      resolve({ exitCode: timedOut ? null : code, timedOut, output: trimmed || '(no output)' });
    });
  });
}

/* ------------------------------------------------------------------ agent */

const SYSTEM_PLAN = `You are a senior software engineer producing an implementation plan for a task in a repository. You have read-only access to explore the code (list_files, read_file). DO NOT modify, create, or delete any files — this is a PLAN-ONLY task. Study the relevant code, then produce a clear, concrete plan: which files to touch, in what order, what to change, and how to validate the result. Name specific files and follow the repository's existing conventions.`;

const SYSTEM_ACT = `You are a senior software engineer implementing a task in an isolated copy of a repository. You can explore the code (list_files, read_file), edit it (write_file, delete_file), and run commands (bash). Work inside this repository copy — make the code changes the task asks for. Read files before editing them. Follow the repository's existing conventions. When you are done, explain in your final answer what you changed and why.`;

function buildSystem(mode) {
  return mode === 'plan' ? SYSTEM_PLAN : SYSTEM_ACT;
}

function buildPrompt(mode, task, context) {
  const role = mode === 'plan' ? 'produce a plan' : 'implement the task';
  return `${context || ''}\n\nTASK:\n${task}\n\nYou are working inside an isolated copy of the repository (your cwd). Use the provided tools to explore and ${
    mode === 'act' ? 'make the changes the task asks for' : 'study the relevant code'
  }. ${mode === 'plan' ? 'Do NOT modify any files.' : ''}`;
}

function createModel(kind, baseURL, apiKey) {
  if (kind === 'anthropic') {
    const provider = createAnthropic({ apiKey, baseURL });
    return provider.languageModel(process.env.ABA_MODEL);
  }
  const provider = createOpenAICompatible({
    name: 'aba-harness',
    baseURL: baseURL || 'https://api.openai.com/v1',
    apiKey: apiKey || 'none',
  });
  // The AI SDK v4 provider is a callable function: provider(modelId).
  return provider(process.env.ABA_MODEL);
}

async function runAgent() {
  if (process.env.ABA_TRACE === '1') console.error('[harness] runAgent start');
  const mode = process.env.ABA_MODE === 'plan' ? 'plan' : 'act';
  const verify = process.env.ABA_VERIFY === '1' && mode === 'act';
  const maxSteps = Number(process.env.ABA_MAX_STEPS || 12);
  const system = process.env.ABA_SYSTEM || buildSystem(mode);
  const task = process.env.ABA_TASK || '';
  const context = process.env.ABA_CONTEXT || '';
  if (!task) {
    emit({ type: 'error', message: 'no task provided' });
    process.exit(1);
  }

  if (process.env.ABA_TRACE === '1') console.error('[harness] mode=' + mode + ' model=' + process.env.ABA_MODEL + ' url=' + process.env.ABA_BASE_URL);
  const model = createModel(process.env.ABA_KIND || 'openai-compatible', process.env.ABA_BASE_URL, process.env.ABA_API_KEY);
  const tools = buildTools(mode);
  const startedAt = Date.now();
  let output = '';
  let steps = 0;
  // Every onStepFinish fires once per agent loop step — count them here so
  // the done event reports the real step count immediately (the SDK's
  // result.steps promise only resolves after the stream fully closes).
  const onStep = (step) => {
    steps++;
    emitStep(step);
  };

  try {
    if (process.env.ABA_TRACE === '1') console.error('[harness] calling streamText');
    const result = streamText({
      model,
      system,
      prompt: buildPrompt(mode, task, context),
      temperature: 0.3,
      tools,
      maxSteps,
      maxTokens: Number(process.env.ABA_MAX_TOKENS || 4000),
      maxRetries: 0,
      onStepFinish: onStep,
    });
    const { textStream } = result;
    if (process.env.ABA_TRACE === '1') console.error('[harness] iterating textStream');
    for await (const chunk of textStream) {
      output += chunk;
      emit({ type: 'delta', text: chunk });
    }
    if (process.env.ABA_TRACE === '1') console.error('[harness] textStream done, output len=' + output.length);
  } catch (err) {
    emit({ type: 'error', message: fmtErr(err) });
    process.exit(1);
  }

  // Verify: ask the agent to start the project. The agent decides the command
  // (reads package.json scripts, runs the right one). A command that exits 0
  // OR is still running at the timeout counts as "the project runs".
  let verified = null;
  let verifyInfo = null;
  if (verify) {
    emit({ type: 'delta', text: '\n\n--- verify: starting the project ---\n' });
    try {
      const record = {};
      const vTools = {
        list_files: buildTools('act').list_files,
        read_file: buildTools('act').read_file,
        bash: tool({
          description:
            'Run a shell command inside the repository (e.g. npm start, npm run dev, npm test, npm run build). Use this to start the project and confirm it runs. Returns exit code + output. A command that keeps running (server) is reported with exitCode null and timedOut true — that still means it started.',
          parameters: z.object({
            command: z.string().describe('the shell command to run'),
            timeoutMs: z.number().optional().describe('kill after this many ms (default 25000)'),
          }),
          execute: async ({ command, timeoutMs = 25000 }) => {
            const r = await runBash(command, timeoutMs);
            record.result = r;
            record.command = command;
            return `exitCode=${r.exitCode == null ? 'still-running' : r.exitCode}\n${r.output}`;
          },
        }),
      };
      const vResult = streamText({
        model,
        system:
          'You are verifying that a repository still runs after code changes. Read package.json (or the project manifest) to find the start/test/build script, then use the bash tool to run it and confirm the project works. A process that stays running (a server) counts as success. Report concisely whether the project runs and what command you used.',
        prompt: `Start the project and confirm it runs. This is an isolated copy of the repository (your cwd). Use bash to run the appropriate command (check package.json scripts: start, dev, test, build). Report the exact command and whether it succeeded.`,
        temperature: 0,
        tools: vTools,
        maxSteps: 5,
        maxTokens: Number(process.env.ABA_MAX_TOKENS || 4000),
        maxRetries: 0,
        onStepFinish: onStep,
      });
      const { textStream: vText } = vResult;
      for await (const chunk of vText) {
        emit({ type: 'delta', text: chunk });
      }
      const r = record.result;
      verified = !!r && (r.exitCode === 0 || r.exitCode == null);
      verifyInfo = {
        ok: verified,
        command: record.command || '',
        output: r ? r.output.slice(-800) : '',
        exitCode: r ? r.exitCode : null,
      };
      emit({ type: 'verify', ok: verified, command: verifyInfo.command, output: verifyInfo.output, exitCode: verifyInfo.exitCode });
    } catch (err) {
      emit({ type: 'error', message: `verify failed: ${fmtErr(err)}` });
      verified = false;
    }
  }

  emit({
    type: 'done',
    output,
    verified,
    mode,
    timeMs: Date.now() - startedAt,
    steps,
  });
}

/* ------------------------------------------------------------------- main */

if (process.argv.includes('--selfcheck')) {
  const tree = listTree(CWD, '');
  emit({
    type: 'selfcheck',
    ok: true,
    cwd: CWD,
    entries: tree.length,
    tools: ['list_files', 'read_file', ...(process.env.ABA_MODE === 'act' ? ['write_file', 'delete_file', 'bash'] : [])],
  });
  process.exit(0);
}

runAgent().catch((err) => {
  emit({ type: 'error', message: fmtErr(err) });
  process.exit(1);
});
