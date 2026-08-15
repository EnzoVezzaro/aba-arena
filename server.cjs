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
 * Context for the ACC panel: the base context plus everything the ACC
 * framework contributes — AGENTS.md contracts and the acc CLI's derived
 * context (graph/context output).
 */
async function buildAccContext(snapshotDir, info, baseContext) {
  const parts = [baseContext];

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

  const acc = await runAcc(['context', '.', '--depth', '1', '--max-bytes', '16000'], snapshotDir);
  if (acc && acc.out.trim()) {
    parts.push('## ACC derived context (acc context --depth 1)');
    parts.push('```\n' + truncate(acc.out, 16000) + '\n```');
  }

  return truncate(parts.join('\n\n'), MAX_CONTEXT_BYTES);
}

/** Run the acc CLI in a directory; returns { code, out, err }. */
function runAcc(args, cwd) {
  const acc = resolveAcc();
  const child = spawn(process.execPath, [...acc.args, ...args], {
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
      const { importProject } = require('./importer.cjs');
      const importResult = await importProject({
        type: /^https?:\/\//i.test(source) ? (source.includes('github.com') ? 'github' : 'git') : 'local',
        pathOrUrl: source,
        revision: body.revision,
        sandboxDir: SANDBOX_DIR,
      });
      const workDir = importResult.snapshotDir || importResult.originalDir;
      const info = importResult.snapshotInfo;

      const baseContext = buildBaseContext(workDir, info);
      const accContext = await buildAccContext(workDir, info, baseContext);

      currentRepo = {
        name: info.sourceType === 'github' ? (source.split('/').pop() || 'repo') : path.basename(workDir),
        source,
        sha: info.commitSha,
        workDir,
        baseContext,
        accContext,
      };
      sendJson(res, 200, {
        repo: { name: currentRepo.name, source, sha: info.commitSha },
        baseContext,
        accContext,
      });
      return;
    } catch (err) {
      sendJson(res, 400, { error: err.message });
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
