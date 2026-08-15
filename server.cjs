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
 *   POST /api/report  → persists a finished battle report as JSON
 *
 * All LLM calls happen in the browser (Vercel AI SDK, keys stay in the
 * user's browser). This server only prepares the repository side of the
 * battle: an isolated snapshot, the plain "no ACC" context, and the
 * "ACC installed" context produced by the acc CLI.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const PORT = Number(process.env.ABA_PORT || 4317);
const UI_DIST = path.join(__dirname, 'ui', 'dist');
const SANDBOX_DIR = path.join(process.env.HOME || '/tmp', '.aba-sandbox');
const MAX_CONTEXT_BYTES = 24000;
const MAX_AGENTS_MD = 5;
const AGENTS_MD_CHARS = 1600;

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
 *   3. acc init          → scaffold .acc/ + AGENTS.md contracts
 *   4. acc scan/prepare  → derive the architecture graph + focused context
 *   5. start challenge   → the assembled context below feeds the battle
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

  // Step 4 — scan/prepare: derive the architecture graph, then the focused
  // agent context that ACC contributes to a coding agent.
  const graph = await runAcc(['graph', '--format', 'text'], snapshotDir);
  steps.push({
    step: 4,
    label: 'acc graph (scan)',
    ok: graph.code === 0,
    detail: graph.code === 0 ? 'architecture graph derived' : (graph.err || graph.out || '').trim().slice(0, 200),
  });
  const scan = await runAcc(['context', '.', '--depth', '1', '--max-bytes', '16000'], snapshotDir);
  steps.push({
    step: 4,
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

/** Run the acc CLI in a directory; returns { code, out, err }. */
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
  });
  let out = '';
  let err = '';
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }, 60000);
  return new Promise((resolve) => {
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
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

async function handleApi(req, res, url) {
  const method = req.method;

  if (method === 'GET' && url.pathname === '/api/health') {
    const acc = resolveAcc();
    sendJson(res, 200, {
      ok: true,
      acc: { source: acc.kind, path: acc.path || null },
      sandbox: SANDBOX_DIR,
      repoLoaded: !!currentRepo,
    });
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
      const { importProject, copyDirectory } = require('./importer.cjs');
      const importResult = await importProject({
        type: /^https?:\/\//i.test(source) ? (source.includes('github.com') ? 'github' : 'git') : 'local',
        pathOrUrl: source,
        revision: body.revision,
        sandboxDir: SANDBOX_DIR,
      });
      const workDir = importResult.snapshotDir || importResult.originalDir;
      const info = importResult.snapshotInfo;

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

      currentRepo = {
        name: info.sourceType === 'github' ? (source.split('/').pop() || 'repo') : path.basename(workDir),
        source,
        sha: info.commitSha,
        workDir,
        sandboxes: { acc: accDir, plain: plainDir },
        baseContext,
        accContext: accResult.context,
      };
      sendJson(res, 200, {
        repo: { name: currentRepo.name, source, sha: info.commitSha },
        baseContext,
        accContext: accResult.context,
        accPipeline: accResult.steps,
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
    const target = path.resolve(sandboxDir, rel);
    // Confine to the sandbox root; skip VCS, deps, and ACC control dirs in trees.
    if (target !== sandboxDir && !target.startsWith(sandboxDir + path.sep)) {
      sendJson(res, 403, { error: 'path escapes the sandbox' });
      return;
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

  if (method === 'POST' && url.pathname === '/api/report') {
    try {
      const body = await readBody(req);
      const dir = path.join(SANDBOX_DIR, 'reports');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `battle-${Date.now()}.json`);
      fs.writeFileSync(file, JSON.stringify(body, null, 2));
      sendJson(res, 200, { ok: true, file });
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
