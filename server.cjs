'use strict';

/**
 * ABA backend server.
 *
 * Serves the built battle-arena UI (aba/ui/dist) and exposes a small JSON
 * API used by the browser app:
 *
 *   GET  /api/health  → { ok, acc: { source, version } }
 *   POST /api/repo    → { source } → imports the repo and returns
 *                       { repo, baseContext, accContext }
 *   POST /api/agent/run → runs the agent harness inside a panel sandbox
 *                       (plan/act + "start the project" verification)
 *   POST /api/report  → persists a finished battle report as JSON
 *
 * LLM calls happen server-side through the agent harness (harness.cjs),
 * which is copied into each battle sandbox and driven by the Vercel AI SDK
 * with a custom base URL — the same provider config the browser uses. The
 * browser sends the panel's provider/model/key to the local server for the
 * duration of a run; it never leaves the machine.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { randomBytes, createHash } = require('crypto');

// Minimal .env loader (no dotenv dependency): ABA_GITHUB_CLIENT_SECRET etc.
// can live in aba/.env instead of the shell environment. Real environment
// variables always win over the file.
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
} catch {
  // no .env file — shell env vars are used instead
}

const PORT = Number(process.env.ABA_PORT || 4317);
const UI_DIST = path.join(__dirname, 'ui', 'dist');
const SANDBOX_DIR = path.join(process.env.HOME || '/tmp', '.aba-sandbox');
const MAX_CONTEXT_BYTES = 24000;
const MAX_AGENTS_MD = 5;
const AGENTS_MD_CHARS = 1600;

// Provider model-list endpoints, proxied server-side: the browser cannot
// fetch some of these directly (NVIDIA's /v1/models only sends CORS headers
// for build.nvidia.com, so localhost gets blocked silently), so the server
// fetches them and returns the JSON unchanged. `public` means the endpoint
// works without an API key.
const MODELS_ENDPOINTS = {
  openai: { url: 'https://api.openai.com/v1/models', public: false },
  anthropic: { url: 'https://api.anthropic.com/v1/models', public: false },
  google: { url: 'https://generativelanguage.googleapis.com/v1beta/openai/models', public: false },
  openrouter: { url: 'https://openrouter.ai/api/v1/models', public: true },
  groq: { url: 'https://api.groq.com/openai/v1/models', public: false },
  deepseek: { url: 'https://api.deepseek.com/models', public: false },
  mistral: { url: 'https://api.mistral.ai/v1/models', public: false },
  xai: { url: 'https://api.x.ai/v1/models', public: false },
  cerebras: { url: 'https://api.cerebras.ai/v1/models', public: false },
  nvidia: { url: 'https://integrate.api.nvidia.com/v1/models', public: true },
  // Optional local Freebuff proxy (aba/freebuff) — only reachable when the
  // proxy is actually running on :8080; the fetch fails cleanly otherwise.
  freebuff: { url: 'http://localhost:8080/v1/models', public: true },
};

// Chat-completion endpoints used to configure the agent harness that runs
// INSIDE each sandbox. `kind` selects the AI SDK adapter in the harness
// ('openai-compatible' for custom-base-URL providers, 'anthropic' for the
// native Anthropic API). Matches aba/ui/src/providers.js.
const PROVIDER_ENDPOINTS = {
  openai: { baseURL: 'https://api.openai.com/v1', kind: 'openai-compatible', needsKey: true },
  anthropic: { baseURL: 'https://api.anthropic.com/v1', kind: 'anthropic', needsKey: true },
  google: { baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', kind: 'openai-compatible', needsKey: true },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1', kind: 'openai-compatible', needsKey: true },
  groq: { baseURL: 'https://api.groq.com/openai/v1', kind: 'openai-compatible', needsKey: true },
  deepseek: { baseURL: 'https://api.deepseek.com', kind: 'openai-compatible', needsKey: true },
  mistral: { baseURL: 'https://api.mistral.ai/v1', kind: 'openai-compatible', needsKey: true },
  xai: { baseURL: 'https://api.x.ai/v1', kind: 'openai-compatible', needsKey: true },
  cerebras: { baseURL: 'https://api.cerebras.ai/v1', kind: 'openai-compatible', needsKey: true },
  nvidia: { baseURL: 'https://integrate.api.nvidia.com/v1', kind: 'openai-compatible', needsKey: true },
  ollama: { baseURL: 'http://localhost:11434/v1', kind: 'openai-compatible', needsKey: false },
  lmstudio: { baseURL: 'http://localhost:1234/v1', kind: 'openai-compatible', needsKey: false },
  // Optional local Freebuff proxy (aba/freebuff) — auth tokens live in the
  // proxy process, so the harness needs no key from the browser.
  freebuff: { baseURL: 'http://localhost:8080/v1', kind: 'openai-compatible', needsKey: false },
};

// The agent harness that runs inside each sandbox. Copied into every battle
// sandbox at repo load; the AI SDK resolves from the UI's node_modules via
// NODE_PATH when the server spawns it.
const HARNESS_SRC = path.join(__dirname, 'harness.cjs');

// GitHub OAuth (web flow + PKCE, popup) — click "Connect GitHub", authorize
// on GitHub, done. The server proxies the token exchange so the code_verifier
// (and optionally the client secret) never reach the browser.
const GITHUB_CLIENT_ID = process.env.ABA_GITHUB_CLIENT_ID || 'Iv23licG5JnDx0V14zDh';
// Optional — only needed if GitHub rejects the PKCE-only token exchange.
const GITHUB_CLIENT_SECRET = process.env.ABA_GITHUB_CLIENT_SECRET || '';
// Local callback: GitHub redirects the popup here after authorization. This
// must be registered as a callback URL in the app settings
// (github.com/settings/apps → ACC Battle Arena → Identifying and authorizing
// users → add a Redirect URI of http://localhost:4317/api/github/callback).
const GITHUB_REDIRECT_URI = process.env.ABA_GITHUB_REDIRECT_URI || 'http://localhost:4317/api/github/callback';
// PKCE sessions: state -> { verifier, expires }. In-memory — the verifier
// never leaves the server.
const ghSessions = new Map();

// ---------------------------------------------------------------------------
// acc CLI resolution — prefers the npm-installed package (remote install),
// falls back to npx, then to this repository's own bin (dev convenience).
// ---------------------------------------------------------------------------

function findInstalledAcc() {
  const candidates = [
    path.join(__dirname, 'node_modules', 'acc-agents', 'bin', 'acc.js'),
    path.join(__dirname, '..', 'node_modules', 'acc-agents', 'bin', 'acc.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return { kind: 'npm-installed', path: c };
  }
  try {
    const globalRoot = execSync('npm root -g', { stdio: 'pipe' }).toString().trim();
    const g = path.join(globalRoot, 'acc-agents', 'bin', 'acc.js');
    if (fs.existsSync(g)) return { kind: 'npm-installed (global)', path: g };
  } catch {
    // ignore
  }
  return null;
}

function resolveAcc() {
  const installed = findInstalledAcc();
  if (installed) return { args: [installed.path], ...installed };
  // Remote install on demand — the ACC framework is fetched from npm.
  return { kind: 'npx (remote install)', args: ['npx', '--yes', 'acc-agents'] };
}

// ---------------------------------------------------------------------------
// Repo import + context building
// ---------------------------------------------------------------------------

function readFileLimit(file, max = 6000) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw.length > max ? raw.slice(0, max) + '\n… (truncated)' : raw;
  } catch {
    return '';
  }
}

function findFiles(dir, pred, out = [], depth = 0) {
  if (depth > 3) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findFiles(full, pred, out, depth + 1);
    else if (pred(e.name, full)) out.push(full);
  }
  return out;
}

function buildTree(root) {
  const lines = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => !['.git', 'node_modules'].includes(e.name));
  } catch {
    return '(unreadable)';
  }
  for (const e of entries) {
    if (e.isDirectory()) lines.push(`${e.name}/`);
    else lines.push(e.name);
  }
  const max = 60;
  const shown = lines.slice(0, max);
  if (lines.length > max) shown.push(`… ${lines.length - max} more entries`);
  return shown.join('\n');
}

// .acc is NOT skipped — the ACC panel's sandbox must show the framework
// installed inside the repo (acc init creates it). Only VCS, deps, build
// noise and binary blobs are hidden.
const SKIP_SANDBOX_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);
const SKIP_SANDBOX_EXT = new Set([
  '.mp3', '.mp4', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.mov', '.avi', '.mkv', '.webm',
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.ico', '.pdf', '.exe', '.dmg', '.pkg', '.bin', '.woff', '.woff2', '.ttf',
]);

/** Recursive file tree for the sandbox explorer: [{ path, type, size, children }]. */
function buildSandboxTree(root, target) {
  const entries = [];
  let list = [];
  try {
    list = fs.readdirSync(target, { withFileTypes: true });
  } catch (err) {
    throw new Error(`cannot list ${path.relative(root, target) || '/'}: ${err.message}`);
  }
  list
    .filter((e) => !SKIP_SANDBOX_DIRS.has(e.name))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .forEach((e) => {
      const abs = path.join(target, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (e.isDirectory()) {
        let children = [];
        try {
          children = buildSandboxTree(root, abs);
        } catch {
          children = [];
        }
        if (children.length > 0) entries.push({ path: rel, type: 'dir', children });
      } else {
        const ext = e.name.slice(e.name.lastIndexOf('.')).toLowerCase();
        if (SKIP_SANDBOX_EXT.has(ext)) return; // binary blobs hidden
        let size = 0;
        try {
          size = fs.statSync(abs).size;
        } catch {
          size = 0;
        }
        entries.push({ path: rel, type: 'file', size });
      }
    });
  return entries;
}

function truncate(s, max = MAX_CONTEXT_BYTES) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '\n… (truncated)' : s;
}

/** Context for the plain panel: the repo without any ACC artifacts. */
function buildBaseContext(snapshotDir, info) {
  const parts = [];
  parts.push(`# Repository: ${info.sourceType === 'github' ? info.sourceUrl : info.sourcePath || path.basename(snapshotDir)}`);
  if (info.commitSha) parts.push(`Revision: ${info.commitSha}`);
  parts.push('');
  parts.push('## File tree (top level)\n```\n' + buildTree(snapshotDir) + '\n```');

  const readme = findFiles(snapshotDir, (name) => /^readme\.(md|txt)$/i.test(name))[0];
  if (readme) parts.push('## README\n' + readFileLimit(readme, 5000));

  const pkg = path.join(snapshotDir, 'package.json');
  if (fs.existsSync(pkg)) parts.push('## package.json\n```json\n' + readFileLimit(pkg, 2500) + '\n```');

  return truncate(parts.join('\n\n'), MAX_CONTEXT_BYTES);
}

/**
 * ACC onboarding pipeline for the benchmark panel. Mirrors how a real
 * project adopts ACC, so the benchmark measures the framework honestly:
  *
   *   1. clone repo        → done by the importer (snapshotDir)
   *   2. install acc-cli   → resolveAcc() (npm-installed or npx on demand)
   *   3. acc init          → scaffold .acc/ control plane + root memory record
   *   4. acc build         → create the missing AGENTS.md contracts (+ memory)
   *   5. acc fill          → fill directive: what an agent must complete
   *   6. acc scan/prepare  → derive the architecture graph + focused context
   *   7. start challenge   → the assembled context below feeds the battle
  *
  * Returns { context, steps } — steps is a list of { step, label, ok, detail }
  * shown in the UI so the benchmark is transparent about what ACC did.
  */
async function buildAccContext(snapshotDir, info, baseContext) {
  const parts = [baseContext];
  const steps = [];

  // Step 3 — acc init: scaffold ACC structure only if it isn't already there
  // (never rewrites an existing ACC repo — init is additive by contract).
  const accDir = path.join(snapshotDir, '.acc');
  const needsInit = !fs.existsSync(path.join(accDir, 'config', 'config.yaml'));
  if (needsInit) {
    const init = await runAcc(['init', '.'], snapshotDir);
    steps.push({
      step: 3,
      label: 'acc init',
      ok: init.code === 0,
      detail: init.code === 0 ? 'scaffolded .acc/ control plane' : (init.err || init.out || '').trim().slice(0, 200),
    });
  } else {
    steps.push({ step: 3, label: 'acc init', ok: true, detail: 'already initialized (.acc/ present)' });
  }

  // Step 4 — acc build: create the missing AGENTS.md contracts (+ initial
  // .acc-memory.md records) so the ACC panel works against a documented
  // project, not just a scaffold. Additive and idempotent by contract.
  const build = await runAcc(['build', '--yes'], snapshotDir);
  const builtContracts = (build.out.match(/^Created .*AGENTS\.md$/gm) || []).length;
  steps.push({
    step: 4,
    label: 'acc build (contracts)',
    ok: build.code === 0,
    detail: build.code === 0
      ? `created ${builtContracts} missing AGENTS.md contract${builtContracts === 1 ? '' : 's'}`
      : (build.err || build.out || '').trim().slice(0, 200),
  });

  // Step 5 — acc fill: produce the generic fill directive so the coding
  // agent completes the freshly generated AGENTS.md templates with
  // accurate content (read-only analysis; the agent does the writing).
  const fill = await runAcc(['fill', '--json'], snapshotDir);
  let fillResult = {};
  let fillSummary = {};
  try {
    fillResult = JSON.parse(fill.out).result || {};
    fillSummary = fillResult.summary || {};
  } catch {
    // non-JSON output (e.g. error text) — leave the summary empty
  }
  steps.push({
    step: 5,
    label: 'acc fill (fill directive)',
    ok: fill.code === 0,
    detail: fill.code === 0
      ? `${fillSummary.draft || 0} of ${fillSummary.total || 0} AGENTS.md files need filling ` +
        `(${fillSummary.placeholder_items || 0} placeholder items)`
      : (fill.err || fill.out || '').trim().slice(0, 200),
  });

  // Step 6 — scan/prepare: derive the architecture graph, then the focused
  // agent context that ACC contributes to a coding agent.
  const graph = await runAcc(['graph', '--format', 'text'], snapshotDir);
  steps.push({
    step: 6,
    label: 'acc graph (scan)',
    ok: graph.code === 0,
    detail: graph.code === 0 ? 'architecture graph derived' : (graph.err || graph.out || '').trim().slice(0, 200),
  });
  const scan = await runAcc(['context', '.', '--depth', '1', '--max-bytes', '16000'], snapshotDir);
  steps.push({
    step: 6,
    label: 'acc context (prepare)',
    ok: scan.code === 0,
    detail: scan.code === 0 ? 'focused agent context generated' : (scan.err || scan.out || '').trim().slice(0, 200),
  });

  const agentsFiles = findFiles(snapshotDir, (name) => name.toLowerCase() === 'agents.md')
    .filter((f) => !f.includes(`${path.sep}.acc${path.sep}`))
    .slice(0, MAX_AGENTS_MD);

  if (agentsFiles.length > 0) {
    parts.push('## AGENTS.md contracts (ACC framework)');
    for (const f of agentsFiles) {
      const rel = path.relative(snapshotDir, f);
      parts.push(`\n### ${rel}\n` + readFileLimit(f, AGENTS_MD_CHARS));
    }
  }

  if (fill.code === 0 && fillResult.files && fillResult.files.length > 0) {
    const pending = fillResult.files.filter((f) => f.status === 'draft');
    if (pending.length > 0) {
      parts.push('## ACC fill directive (acc fill)');
      parts.push(fillResult.directive || 'Complete the placeholder AGENTS.md files.');
      for (const f of pending) {
        const items = [
          ...f.missing.map((s) => `${s} (missing)`),
          ...f.empty.map((s) => `${s} (empty)`),
          ...f.placeholders.map((p) => `${p.section} (${p.count})`),
        ];
        if (items.length) parts.push(`- ${f.file}: ${items.join(', ')}`);
      }
      parts.push('');
    }
  }

  if (graph && graph.out.trim()) {
    parts.push('## ACC architecture graph (acc graph)');
    parts.push('```\n' + truncate(graph.out, 8000) + '\n```');
  }

  if (scan && scan.out.trim()) {
    parts.push('## ACC derived context (acc context --depth 1)');
    parts.push('```\n' + truncate(scan.out, 16000) + '\n```');
  }

  return { context: truncate(parts.join('\n\n'), MAX_CONTEXT_BYTES), steps };
}

/** Run the acc CLI in a directory; returns { code, out, err }.
 *  The child is spawned detached into its own process group so that on
 *  timeout the whole group (npx wrapper + acc child) is killed together —
 *  a killed npx wrapper must never leave an orphaned acc process spinning. */
function runAcc(args, cwd) {
  const acc = resolveAcc();
  // npm-installed / local dev copy → node <script>; npx on demand → npx directly.
  const isNpx = acc.args[0] === 'npx';
  const cmd = isNpx ? acc.args[0] : process.execPath;
  const cmdArgs = isNpx ? [...acc.args.slice(1), ...args] : [...acc.args, ...args];
  const child = spawn(cmd, cmdArgs, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
    detached: true,
  });
  let out = '';
  let err = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }
  }, 60000);
  return new Promise((resolve) => {
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ code: 124, out, err: `${err}\n[acc timed out after 60s]`.trim() });
      } else {
        resolve({ code, out, err });
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out: '', err: e.message });
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

/**
 * Remove battle sandboxes that were abandoned mid-battle — the user pressed
 * back, closed the tab, or the battle never started — so ~/.aba-sandbox does
 * not accumulate stale copies. A battle is "abandoned" when its sandbox exists
 * but no battle-<id>.json report was ever saved for it; completed battles keep
 * their sandbox for the history view (the UI deletes both together).
 */
function cleanupAbandonedBattles() {
  const battlesDir = path.join(SANDBOX_DIR, 'battles');
  let entries;
  try {
    entries = fs.readdirSync(battlesDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^[a-z0-9]+$/i.test(entry.name)) continue;
    if (fs.existsSync(path.join(SANDBOX_DIR, 'reports', `battle-${entry.name}.json`))) continue;
    try {
      fs.rmSync(path.join(battlesDir, entry.name), { recursive: true, force: true });
      console.log(`Cleaned up abandoned battle sandbox: ${entry.name}`);
    } catch {
      // best-effort cleanup
    }
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let file = path.join(UI_DIST, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(UI_DIST)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  // SPA fallback
  const index = path.join(UI_DIST, 'index.html');
  if (fs.existsSync(index)) {
    res.writeHead(200, { 'Content-Type': MIME['.html'] });
    fs.createReadStream(index).pipe(res);
    return;
  }
  res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('ABA UI not built yet. Run: cd aba/ui && npm install && npm run build');
}

let currentRepo = null; // { name, source, sha, workDir, baseContext, accContext }

// Live check for the optional local Freebuff proxy (aba/freebuff). Pure
// config: ABA never starts the proxy on its own unless the user opts in with
// ABA_FREEBUFF_AUTOSTART=1 — running it uses the user's Freebuff token, which
// would fight their own active session.
function checkFreebuffRunning() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:8080/healthz', { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Optional: boot the vendored Freebuff2API proxy locally (no Docker) when the
// user explicitly asked for it. Default is OFF — see aba/freebuff/README.md.
function maybeStartFreebuff() {
  if (process.env.ABA_FREEBUFF_AUTOSTART !== '1') return;
  const script = path.join(__dirname, 'freebuff', 'start.cjs');
  if (!fs.existsSync(script)) return;
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  child.on('close', () => {
    const line = out.trim().split('\n').pop() || '';
    try {
      const status = JSON.parse(line);
      console.log(`  Freebuff:    ${status.running ? 'proxy running on :8080' : status.reason === 'no-tokens' ? 'configured — no tokens (set ABA_FREEBUFF_TOKENS or log into the Freebuff CLI)' : `proxy not running (${status.reason})`}`);
    } catch {
      console.log('  Freebuff:    proxy bootstrap failed — see ~/.aba-sandbox/freebuff/freebuff.log');
    }
  });
  child.unref();
}

async function handleApi(req, res, url) {
  const method = req.method;

  if (method === 'GET' && url.pathname === '/api/health') {
    const acc = resolveAcc();
    sendJson(res, 200, {
      ok: true,
      acc: { source: acc.kind, path: acc.path || null },
      sandbox: SANDBOX_DIR,
      repoLoaded: !!currentRepo,
      githubOauthConfigured: !!GITHUB_CLIENT_SECRET,
    });
    return;
  }

  // Optional Freebuff proxy status: { running } — the UI shows the Freebuff
  // provider only when the local proxy answers.
  if (method === 'GET' && url.pathname === '/api/freebuff/status') {
    const running = await checkFreebuffRunning();
    sendJson(res, 200, { running, port: 8080 });
    return;
  }

  // Provider model-list proxy: GET /api/models?provider=nvidia. The server
  // fetches the provider's /models endpoint server-side (no CORS), forwarding
  // the caller's Authorization / x-api-key headers so keyed providers work
  // too. Public endpoints are fetched without a key.
  if (method === 'GET' && url.pathname === '/api/models') {
    const provider = url.searchParams.get('provider') || '';
    const cfg = MODELS_ENDPOINTS[provider];
    if (!cfg) {
      sendJson(res, 400, { error: `unknown provider: ${provider}` });
      return;
    }
    try {
      const headers = { Accept: 'application/json' };
      if (req.headers.authorization) headers.Authorization = req.headers.authorization;
      if (req.headers['x-api-key']) {
        headers['x-api-key'] = req.headers['x-api-key'];
        headers['anthropic-version'] = '2023-06-01';
      }
      const upstream = await fetch(cfg.url, { headers });
      const text = await upstream.text();
      if (!upstream.ok) {
        sendJson(res, upstream.status, { error: `upstream HTTP ${upstream.status}`, detail: text.slice(0, 300) });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(text);
    } catch (err) {
      sendJson(res, 502, { error: `failed to reach ${provider}: ${err.message}` });
    }
    return;
  }

  // GitHub OAuth (web flow + PKCE): GET /api/github/start opens a session and
  // 302s the popup to GitHub's authorize page. GitHub redirects back to
  // /api/github/callback, which exchanges the code for a user access token and
  // hands it to the app via window.opener.postMessage. PKCE keeps the client
  // secret optional — it is sent only if ABA_GITHUB_CLIENT_SECRET is set.
  if (method === 'GET' && url.pathname === '/api/github/start') {
    const state = randomBytes(16).toString('hex');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    ghSessions.set(state, { verifier, expires: Date.now() + 10 * 60 * 1000 });
    const params = new URLSearchParams({
      client_id: GITHUB_CLIENT_ID,
      redirect_uri: GITHUB_REDIRECT_URI,
      scope: 'repo',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    res.writeHead(302, { Location: `https://github.com/login/oauth/authorize?${params}` });
    res.end();
    return;
  }

  if (method === 'GET' && url.pathname === '/api/github/callback') {
    const code = url.searchParams.get('code') || '';
    const state = url.searchParams.get('state') || '';
    const session = ghSessions.get(state);
    ghSessions.delete(state);
    // HTML handed to the popup: it posts the result to the opener and closes.
    const respond = (payload) => {
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>ABA · GitHub</title></head><body style="font:14px system-ui;padding:24px;color:#333"><script>
        const payload = ${JSON.stringify(payload)};
        if (window.opener) {
          window.opener.postMessage({ type: 'aba-github-auth', ...payload }, '*');
          window.close();
        } else {
          document.body.textContent = payload.error
            ? 'GitHub sign-in failed: ' + payload.error
            : 'Connected — you can close this tab.';
        }
      <\/script></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    };
    if (!code || !state || !session || session.expires < Date.now()) {
      respond({ error: 'The sign-in link was invalid or expired — try again.' });
      return;
    }
    try {
      const body = new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        code,
        redirect_uri: GITHUB_REDIRECT_URI,
        code_verifier: session.verifier,
      });
      if (GITHUB_CLIENT_SECRET) body.set('client_secret', GITHUB_CLIENT_SECRET);
      const gh = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body,
      });
      const data = await gh.json().catch(() => ({}));
      if (data.access_token) {
        respond({ token: data.access_token });
      } else if (data.error === 'incorrect_client_credentials') {
        respond({
          error:
            'GitHub rejected the token exchange — the client secret is missing or wrong. Generate one under "Client secrets" in the GitHub App settings and restart the server with ABA_GITHUB_CLIENT_SECRET set.',
        });
      } else {
        respond({ error: data.error_description || data.error || 'GitHub could not complete the sign-in.' });
      }
    } catch (err) {
      respond({ error: `GitHub token exchange failed: ${err.message}` });
    }
    return;
  }

  if (method === 'POST' && url.pathname === '/api/repo') {
    try {
      const body = await readBody(req);
      const source = (body.source || '').trim();
      if (!source) {
        sendJson(res, 400, { error: 'source is required (local path or GitHub URL)' });
        return;
      }
      const isUrl = /^https?:\/\//i.test(source);
      // The client can pin the type (e.g. a repo picked from the GitHub
      // autocomplete is always 'github', even in owner/repo shorthand).
      const type = body.type === 'github' ? 'github' : isUrl ? (source.includes('github.com') ? 'github' : 'git') : 'local';
      const { importProject, copyDirectory } = require('./importer.cjs');
      const importResult = await importProject({
        type,
        pathOrUrl: source,
        revision: body.revision,
        sandboxDir: SANDBOX_DIR,
        ...(body.token ? { token: body.token } : {}),
      });
      const workDir = importResult.snapshotDir || importResult.originalDir;
      const info = importResult.snapshotInfo;

      // Drop sandboxes from battles that were interrupted (back/closed tab)
      // before this new one starts.
      cleanupAbandonedBattles();

      // Two ISOLATED sandboxes — one per panel. Each gets its own copy of the
      // repo so the agents can edit files without affecting the other side or
      // the original repository.
      const battleId = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      const sandboxRoot = path.join(SANDBOX_DIR, 'battles', battleId);
      const accDir = path.join(sandboxRoot, 'acc');
      const plainDir = path.join(sandboxRoot, 'plain');
      fs.mkdirSync(accDir, { recursive: true });
      fs.mkdirSync(plainDir, { recursive: true });
      // Skip media/archive blobs in the sandbox copies — they slow the copy
      // and the agents never edit them. The source snapshot keeps everything.
      copyDirectory(workDir, accDir, true);
      copyDirectory(workDir, plainDir, true);

      // ACC onboarding pipeline runs on the ACC sandbox only — the plain
      // sandbox stays untouched so the benchmark compares framework vs no.
      const baseContext = buildBaseContext(plainDir, info);
      const accResult = await buildAccContext(accDir, info, baseContext);

      // Install the agent harness INSIDE both sandboxes so the battle runs
      // through it (plan/act + "start the project" verification) instead of
      // the browser streaming directly. Self-check verifies the sandbox copy
      // boots and its tools work.
      const harness = { installed: false, selfCheck: null };
      try {
        for (const dir of [accDir, plainDir]) {
          const target = path.join(dir, '.aba-agent.cjs');
          fs.copyFileSync(HARNESS_SRC, target);
        }
        harness.installed = true;
        const probe = spawn(process.execPath, [path.join(accDir, '.aba-agent.cjs'), '--selfcheck'], {
          cwd: accDir,
          env: { ...process.env, NODE_PATH: path.join(__dirname, 'ui', 'node_modules') },
        });
        const probeOut = await new Promise((resolve) => {
          let out = '';
          probe.stdout.on('data', (d) => (out += d));
          probe.stderr.on('data', (d) => (out += d));
          probe.on('close', () => resolve(out));
        });
        try {
          harness.selfCheck = JSON.parse(probeOut.split('\n').filter(Boolean).pop());
        } catch {
          harness.selfCheck = { ok: false, error: probeOut.slice(0, 200) };
        }
      } catch (err) {
        harness.error = err.message;
      }

      currentRepo = {
        battleId,
        name: info.sourceType === 'github' ? (source.split('/').pop() || 'repo') : path.basename(workDir),
        source,
        sha: info.commitSha,
        workDir,
        sandboxes: { acc: accDir, plain: plainDir },
        baseContext,
        accContext: accResult.context,
      };
      sendJson(res, 200, {
        repo: { name: currentRepo.name, source, sha: info.commitSha, battleId },
        baseContext,
        accContext: accResult.context,
        accPipeline: accResult.steps,
        harness,
      });
      return;
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
  }

  // Sandbox file API — each panel's agent can read/write files inside its
  // own isolated sandbox copy of the repo. Paths are confined to the
  // sandbox root (no escaping via ../, no .git/node_modules).
  const sandboxMatch = url.pathname.match(/^\/api\/sandbox\/(acc|plain)\/(tree|file)$/);
  if (sandboxMatch) {
    const panel = sandboxMatch[1];
    const action = sandboxMatch[2];
    const sandboxDir = currentRepo && currentRepo.sandboxes && currentRepo.sandboxes[panel];
    if (!sandboxDir || !fs.existsSync(sandboxDir)) {
      sendJson(res, 400, { error: 'no repo loaded — load a repository first' });
      return;
    }
    const rel = (url.searchParams.get('path') || '').replace(/^\/+/, '');
    // Defense in depth: VCS, dependency and build-noise paths are never
    // exposed — even though the sandbox copies never contain them, a
    // requested path must not reach the resolver at all.
    const firstSeg = rel.split('/')[0];
    if (firstSeg && SKIP_SANDBOX_DIRS.has(firstSeg)) {
      sendJson(res, 403, { error: 'path is not exposed in the sandbox' });
      return;
    }
    const target = path.resolve(sandboxDir, rel);
    // Confine to the sandbox root — both lexically AND by real path, so a
    // symlink inside the copy can never reach outside the panel sandbox
    // (e.g. a sibling panel or the host filesystem).
    if (target !== sandboxDir && !target.startsWith(sandboxDir + path.sep)) {
      sendJson(res, 403, { error: 'path escapes the sandbox' });
      return;
    }
    try {
      const realRoot = fs.realpathSync(sandboxDir);
      const probe = fs.existsSync(target) ? target : path.dirname(target);
      const realProbe = fs.realpathSync(probe);
      // The probe may be the sandbox root itself (tree at /, or a write
      // creating a new file at the root) — that is inside, not an escape.
      if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) {
        sendJson(res, 403, { error: 'path escapes the sandbox' });
        return;
      }
    } catch {
      // Parent does not exist yet (a write creating new directories) — the
      // lexical check above already confined it under the sandbox root.
    }

    if (action === 'tree') {
      try {
        sendJson(res, 200, { panel, tree: buildSandboxTree(sandboxDir, target) });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
      return;
    }

    if (action === 'file') {
      if (method === 'GET') {
        try {
          const content = fs.readFileSync(target, 'utf8');
          sendJson(res, 200, { panel, path: rel || '/', content });
        } catch (err) {
          sendJson(res, 404, { error: `cannot read ${rel || '/'}: ${err.message}` });
        }
        return;
      }
      if (method === 'POST') {
        try {
          const body = await readBody(req);
          const content = typeof body.content === 'string' ? body.content : '';
          if (rel && !/\/\/\.\.|(\.\.\/)/.test(rel)) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, content, 'utf8');
            sendJson(res, 200, { panel, path: rel, ok: true });
          } else {
            sendJson(res, 403, { error: 'invalid path' });
          }
        } catch (err) {
          sendJson(res, 400, { error: `cannot write ${rel}: ${err.message}` });
        }
        return;
      }
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
  }

  // Run the agent harness inside a panel's sandbox. The harness (copied into
  // each sandbox at repo load) runs the agentic loop with the panel's
  // provider/model/key via the AI SDK + custom base URL, then (for act tasks)
  // asks the agent to start the project and reports verified. NDJSON events
  // are streamed back line-by-line so the battle page shows live output.
  if (method === 'POST' && url.pathname === '/api/agent/run') {
    const body = await readBody(req);
    const panel = body.panel === 'plain' ? 'plain' : 'acc';
    const sandboxDir = currentRepo && currentRepo.sandboxes && currentRepo.sandboxes[panel];
    const harnessFile = sandboxDir && path.join(sandboxDir, '.aba-agent.cjs');
    if (!harnessFile || !fs.existsSync(harnessFile)) {
      sendJson(res, 400, { error: 'no repo loaded — load a repository first' });
      return;
    }
    const providerCfg = PROVIDER_ENDPOINTS[body.provider];
    if (!providerCfg) {
      sendJson(res, 400, { error: `unknown provider: ${body.provider}` });
      return;
    }
    const mode = body.mode === 'plan' ? 'plan' : 'act';
    if (providerCfg.needsKey && !body.apiKey) {
      sendJson(res, 400, { error: `API key required for ${body.provider}` });
      return;
    }

    // Stream NDJSON events to the client, killing the harness on disconnect
    // or a hard deadline so a stuck provider can never leave a zombie.
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
    const nodePath = path.join(__dirname, 'ui', 'node_modules');
    const env = {
      ...process.env,
      NODE_PATH: nodePath,
      ABA_KIND: providerCfg.kind,
      ABA_BASE_URL: providerCfg.baseURL,
      ABA_API_KEY: body.apiKey || '',
      ABA_MODEL: body.model || '',
      ABA_MODE: mode,
      ABA_TASK: String(body.task || ''),
      ABA_CONTEXT: String(body.context || ''),
      ABA_SYSTEM: String(body.system || ''),
      ABA_VERIFY: body.verify && mode === 'act' ? '1' : '0',
      ABA_MAX_STEPS: String(body.maxSteps || 12),
      ABA_MAX_TOKENS: String(body.maxTokens || 4000),
    };
    const child = spawn(process.execPath, [harnessFile], { cwd: sandboxDir, env });
    let closed = false;
    const hardTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      if (!closed) {
        closed = true;
        res.end('{"type":"error","message":"Timed out after 120s — the provider did not respond."}\n');
      }
    }, 120000);
    child.stdout.on('data', (d) => {
      if (!closed) res.write(d);
    });
    child.stderr.on('data', (d) => {
      if (!closed) res.write(JSON.stringify({ type: 'stderr', text: String(d) }) + '\n');
    });
    child.on('close', (code) => {
      clearTimeout(hardTimer);
      if (!closed) {
        closed = true;
        if (code !== 0) res.write(JSON.stringify({ type: 'error', message: `harness exited with code ${code}` }) + '\n');
        res.end();
      }
    });
    req.on('close', () => {
      clearTimeout(hardTimer);
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    });
    return;
  }

  // Folder browser for the "find folder" picker — lists subdirectories of a
  // path on this machine (the one running the ABA server). Starts at $HOME.
  if (method === 'GET' && url.pathname === '/api/fs/list') {
    const requested = url.searchParams.get('path') || '';
    const target = requested
      ? path.resolve(requested)
      : process.env.HOME || process.cwd();
    try {
      if (!fs.statSync(target).isDirectory()) {
        sendJson(res, 400, { error: `not a directory: ${target}` });
        return;
      }
      const dirs = fs
        .readdirSync(target, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
      const parent = path.dirname(target);
      sendJson(res, 200, {
        path: target,
        parent: parent === target ? null : parent,
        dirs,
      });
    } catch (err) {
      sendJson(res, 400, { error: `cannot list ${requested || 'home'}: ${err.message}` });
    }
    return;
  }

  if (method === 'POST' && url.pathname === '/api/report') {
    try {
      const body = await readBody(req);
      const dir = path.join(SANDBOX_DIR, 'reports');
      fs.mkdirSync(dir, { recursive: true });
      // Name the report by battleId so deleting a history run can remove its
      // sandbox AND its saved report together.
      const id = /^[a-z0-9]+$/i.test(body.battleId || '') ? body.battleId : `b${Date.now().toString(36)}`;
      const file = path.join(dir, `battle-${id}.json`);
      fs.writeFileSync(file, JSON.stringify(body, null, 2));
      sendJson(res, 200, { ok: true, file });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  // DELETE a battle: removes its isolated sandboxes and its saved report.
  // Body: { id } deletes one battle; { all: true } wipes every battle.
  if (method === 'POST' && url.pathname === '/api/battles/delete') {
    try {
      const body = await readBody(req);
      const id = String(body.id || '');
      if (body.all) {
        fs.rmSync(path.join(SANDBOX_DIR, 'battles'), { recursive: true, force: true });
        fs.rmSync(path.join(SANDBOX_DIR, 'reports'), { recursive: true, force: true });
        if (currentRepo) currentRepo = null;
        sendJson(res, 200, { ok: true, deleted: 'all' });
        return;
      }
      if (!/^[a-z0-9]+$/i.test(id)) {
        sendJson(res, 400, { error: 'invalid battle id' });
        return;
      }
      fs.rmSync(path.join(SANDBOX_DIR, 'battles', id), { recursive: true, force: true });
      fs.rmSync(path.join(SANDBOX_DIR, 'reports', `battle-${id}.json`), { force: true });
      if (currentRepo && currentRepo.battleId === id) currentRepo = null;
      sendJson(res, 200, { ok: true, deleted: id });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch((err) => sendJson(res, 500, { error: err.message }));
      return;
    }
    serveStatic(req, res, decodeURIComponent(url.pathname));
  });
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

function ensureUiBuilt() {
  if (fs.existsSync(path.join(UI_DIST, 'index.html'))) return Promise.resolve(true);
  const { execSync } = require('child_process');
  try {
    execSync('npm install --no-audit --no-fund', { cwd: path.join(__dirname, 'ui'), stdio: 'inherit' });
    execSync('npm run build', { cwd: path.join(__dirname, 'ui'), stdio: 'inherit' });
    return Promise.resolve(true);
  } catch (err) {
    console.error('Failed to build the ABA UI:', err.message);
    return Promise.resolve(false);
  }
}

function startServer(opts = {}) {
  cleanupAbandonedBattles();
  maybeStartFreebuff();
  return ensureUiBuilt().then((built) => {
    const server = createServer();
    server.listen(PORT, () => {
      const acc = resolveAcc();
      console.log('ACC Battle Arena');
      console.log('────────────────────────────────');
      console.log(`  UI:          http://localhost:${PORT}${built ? '' : '  (UI not built — see error above)'}`);
      console.log(`  acc CLI:     ${acc.kind}${acc.path ? ` (${acc.path})` : ''}`);
      console.log(`  Sandbox:     ${SANDBOX_DIR}`);
      console.log('  LLM calls:   in your browser (keys never leave it)');
      console.log('');
      if (opts.initialSource) {
        console.log(`  Loading initial repo: ${opts.initialSource}`);
      }
    });
    if (opts.open && built) {
      try {
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        spawn(opener, [`http://localhost:${PORT}`], { stdio: 'ignore', detached: true }).unref();
      } catch {
        // opening the browser is best-effort
      }
    }
    return server;
  });
}

module.exports = { startServer, resolveAcc, buildBaseContext, buildAccContext, createServer, PORT };

if (require.main === module) {
  startServer({ open: true }).catch((err) => {
    console.error('Failed to start ABA server:', err.message);
    process.exit(1);
  });
}
