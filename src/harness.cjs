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

const { tool, streamText, stepCountIs } = require('ai');
// Use the OPENAI-COMPATIBLE adapter (not @ai-sdk/openai) for custom base
// URLs: the openai provider drops `reasoning_content` deltas (it buffers the
// whole response into one final text-delta), so reasoning models look dead
// while they think. The compatible adapter streams reasoning live.
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

// Consume the model's FULL stream (text + reasoning) and emit terminal
// events for both. Reasoning models (e.g. NVIDIA's muse-glimmer) stream long
// silent `reasoning_content` blocks before any content — if the harness only
// reads textStream the battle page sees nothing during the thinking phase
// and the client's idle watchdog aborts a perfectly healthy run. Surfacing
// the reasoning keeps the terminal alive AND shows the agent thinking live.
// Reasoning deltas are batched into readable chunks (~60+ chars, ~350ms) so
// the terminal gets a progressive stream of "· …" lines, not hundreds of
// single-character events.
async function streamFull(result) {
  let output = '';
  let reasoning = '';
  let lastReasoningAt = 0;
  for await (const part of result.fullStream) {
    // AI SDK v5: fullStream parts carry their payload in `text` (text-delta
    // and reasoning-delta), not `textDelta` — and reasoning deltas are named
    // 'reasoning-delta' (v4 called them 'reasoning').
    // AI SDK v5 enqueues provider failures (HTTP 400/500, malformed
    // responses, …) as {type:'error'} parts instead of throwing — the stream
    // then closes NORMALLY. If we ignore the part the harness would report
    // "done" with an empty output (silently failed run). Surface it: throw
    // so the caller's try/catch emits {type:'error'} and exits non-zero.
    if (part.type === 'error') {
      const e = part.error;
      throw e instanceof Error ? e : new Error(fmtErr(e));
    }
    if (part.type === 'text-delta') {
      if (reasoning) {
        emit({ type: 'reasoning', text: reasoning });
        reasoning = '';
      }
      const t = part.text || '';
      output += t;
      emit({ type: 'delta', text: t });
    } else if (part.type === 'reasoning-delta') {
      const t = part.text || '';
      if (!t) continue;
      reasoning += t;
      const now = Date.now();
      if (reasoning.length >= 60 && now - lastReasoningAt >= 350) {
        emit({ type: 'reasoning', text: reasoning });
        reasoning = '';
        lastReasoningAt = now;
      }
    }
  }
  if (reasoning) emit({ type: 'reasoning', text: reasoning });
  return output;
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
  // AI SDK v5 StepResult: `reasoning` is an array of parts (use reasoningText
  // for the joined string) and tool calls/results carry `input`/`output`
  // (v4 called them `args`/`result`).
  if (step && typeof step.reasoningText === 'string' && step.reasoningText.trim()) {
    emit({ type: 'reasoning', text: step.reasoningText.slice(0, 2000) });
  }
  for (const tc of step?.toolCalls || []) {
    emit({ type: 'cmd', text: renderCmd(tc.toolName, tc.input) });
  }
  for (const tr of step?.toolResults || []) {
    let out = tr.output == null ? '' : typeof tr.output === 'string' ? tr.output : JSON.stringify(tr.output);
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

// Small models (e.g. NVIDIA's 3B nano) frequently emit a tool call with EMPTY
// arguments (read_file with no path). Two traps: a dead-end error like
// "no such file: undefined" loops forever, and a fake call syntax like
// "read_file({...})" derails the model into trying to OUTPUT that string
// instead of emitting a structured tool call. So: state the fact plainly (no
// syntax example), and after a few misses tell the model to stop retrying and
// proceed with what it has — a stuck model burning all its steps fails the
// task, while a nudge to move on still produces an answer.
function buildTools(mode) {
  const misses = {};
  const missingArg = (toolName, what) => {
    misses[toolName] = (misses[toolName] || 0) + 1;
    if (misses[toolName] >= 3) {
      return `${toolName}: its ${what} argument is still missing after ${misses[toolName]} tries. Stop retrying this tool — proceed with the task using the file listing and the context you already have, or answer directly.`;
    }
    return `${toolName}: the tool call arrived without its ${what} argument. Retry the call with the argument filled in.`;
  };

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
        path: z.string().describe('path to the file, relative to repo root'),
      }),
      execute: async ({ path: filePath }) => {
        if (!filePath) return missingArg('read_file', 'path');
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
        path: z.string().describe('path to the file, relative to repo root'),
        content: z.string().describe('the complete new file content'),
      }),
      execute: async ({ path: filePath, content }) => {
        if (!filePath || content == null) return missingArg('write_file', 'path and content');
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
        if (!filePath) return missingArg('delete_file', 'path');
        if (SKIP_TOOL.test(filePath)) return 'that path is not deletable in the sandbox';
        const target = safeResolve(filePath);
        if (!fs.existsSync(target)) return `no such file: ${filePath}`;
        fs.rmSync(target, { force: true });
        return `deleted ${filePath}`;
      },
    });
    tools.bash = tool({
      description:
        'Run a shell command inside the repository (e.g. this repo\'s test/build commands, git status). Use this to run tests, build, or start the project. Returns exit code + output.',
      parameters: z.object({
        command: z.string().describe('the shell command to run'),
        timeoutMs: z.number().optional().describe('kill the command after this many ms (default 30000)'),
      }),
      execute: ({ command, timeoutMs = 30000 }) => {
        if (!command) return missingArg('bash', 'command');
        return runBash(command, timeoutMs);
      },
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
  // OpenAI-compatible providers go through @ai-sdk/openai-compatible — the
  // adapter that keeps streaming `reasoning_content` live (the openai
  // provider swallows it). parallel_tool_calls:false is passed through
  // providerOptions (the adapter spreads the provider's options into the
  // request body) so models that only support ONE tool call per response
  // (e.g. NVIDIA's llama-3.1-8b) work instead of erroring with "only
  // supports single tool-calls at once".
  const provider = createOpenAICompatible({
    name: 'aba-harness',
    baseURL: baseURL || 'https://api.openai.com/v1',
    apiKey: apiKey || 'none',
  });
  return provider.languageModel(process.env.ABA_MODEL);
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
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  // Every onStepFinish fires once per agent loop step — count them here so
  // the done event reports the real step count immediately (the SDK's
  // result.steps promise only resolves after the stream fully closes).
  const onStep = (step) => {
    steps++;
    emitStep(step);
    // Accumulate token usage from the AI SDK step result.
    const u = step?.usage;
    if (u) {
      totalInputTokens += u.promptTokens ?? 0;
      totalOutputTokens += u.completionTokens ?? 0;
    }
  };

  try {
    if (process.env.ABA_TRACE === '1') console.error('[harness] calling streamText');
    const result = streamText({
      model,
      system,
      prompt: buildPrompt(mode, task, context),
      temperature: 0.3,
      tools,
      // AI SDK v5: the tool loop is controlled by stopWhen (default is 1
      // step!) — v4's maxSteps no longer drives it.
      stopWhen: stepCountIs(maxSteps),
      maxTokens: Number(process.env.ABA_MAX_TOKENS || 4000),
      maxRetries: 0,
      providerOptions: {
        'aba-harness': { parallel_tool_calls: false },
      },
      onStepFinish: onStep,
    });
    if (process.env.ABA_TRACE === '1') console.error('[harness] iterating fullStream');
    output = await streamFull(result);
    if (process.env.ABA_TRACE === '1') console.error('[harness] stream done, output len=' + output.length);
  } catch (err) {
    emit({ type: 'error', message: fmtErr(err) });
    process.exit(1);
  }

  // Verify: ask the agent to start the project. The agent decides the command
  // (reads the project manifest, runs the right command). A command that exits 0
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
            'Run a shell command inside the repository (e.g. the start/dev/test/build command from this repo\'s project manifest). Use this to start the project and confirm it runs. Returns exit code + output. A command that keeps running (server) is reported with exitCode null and timedOut true — that still means it started.',
          parameters: z.object({
            command: z.string().describe('the shell command to run'),
            timeoutMs: z.number().optional().describe('kill after this many ms (default 25000)'),
          }),
          execute: async ({ command, timeoutMs = 25000 }) => {
            if (!command) return missingArg('bash', 'command');
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
          'You are verifying that a repository still runs after code changes. Read the project manifest (package.json, pyproject.toml, Cargo.toml, Makefile, etc. — whatever this repo uses) to find the start/test/build command, then use the bash tool to run it and confirm the project works. A process that stays running (a server) counts as success. Report concisely whether the project runs and what command you used.',
        prompt: `Start the project and confirm it runs. This is an isolated copy of the repository (your cwd). Use bash to run the appropriate command — check the project manifest (package.json, pyproject.toml, Cargo.toml, Makefile, etc.) for the start/dev/test/build script and use that. Report the exact command and whether it succeeded.`,
        temperature: 0,
        tools: vTools,
        stopWhen: stepCountIs(5),
        maxTokens: Number(process.env.ABA_MAX_TOKENS || 4000),
        maxRetries: 0,
        providerOptions: {
          'aba-harness': { parallel_tool_calls: false },
        },
        onStepFinish: onStep,
      });
      await streamFull(vResult);
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
    inputTokens: totalInputTokens || null,
    outputTokens: totalOutputTokens || null,
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
