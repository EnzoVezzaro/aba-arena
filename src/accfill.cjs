'use strict';

/**
 * Deterministic filler for draft AGENTS.md contracts (the ACC panel only).
 *
 * `acc fill` is read-only by design: it analyzes every AGENTS.md and emits a
 * directive for an agent to replace template placeholders with accurate
 * content (see acc-agents/lib/commands/fill.js). ABA runs the ACC pipeline
 * headless at repo-load time — no provider key exists until a battle starts —
 * so this module applies that directive deterministically:
 *
 *   - Purpose      → first README line, else package.json description, else a
 *                    factual "This is the <name> project." sentence
 *   - Ownership    → "Owner: <repo name>" (the project owns its code)
 *   - everything else that is still a template placeholder → "None." (the
 *                    fill directive's own fallback: "If a section has nothing
 *                    to add, write 'None.' instead of guessing")
 *
 * The placeholder patterns mirror acc-agents' analysis exactly, so after
 * filling, `acc fill --json` reports every contract complete (draft 0,
 * placeholder_items 0). Existing content is preserved verbatim — only
 * placeholder lines (and missing/empty required sections) are touched, and
 * the Markdown structure and section headings stay as they are.
 */

const fs = require('fs');
const path = require('path');

// Must stay in sync with acc-agents/lib/commands/fill.js REQUIRED_SECTIONS.
const REQUIRED_SECTIONS = [
  'Purpose',
  'Responsibilities',
  'Ownership',
  'Inputs',
  'Outputs',
  'Dependencies',
  'Constraints',
  'Architecture',
];

// Mirrors acc-agents fill.js isPlaceholder().
function isPlaceholder(line) {
  const t = line.replace(/^[-*•]\s*/, '').trim();
  if (!t) return false;
  if (t.includes('<') && t.includes('>')) return true;
  if (/^Describe what .+ does in one sentence\.?$/.test(t)) return true;
  if (/Owner\s*:\s*<[^>]*>/i.test(t)) return true;
  if (/^<Prose/.test(t)) return true;
  return false;
}

/** Parse AGENTS.md into a map of raw heading → content lines. */
function parseSections(text) {
  const sections = {};
  const order = [];
  let current = null;
  let currentLines = [];
  const flush = () => {
    if (current) {
      sections[current] = currentLines;
      currentLines = [];
    }
  };
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (m && m[1]) {
      flush();
      current = m[1].replace(/[*`_]/g, '').trim();
      order.push(current);
    } else if (current) {
      currentLines.push(line);
    }
  }
  flush();
  return { sections, order };
}

function canon(name) {
  const lower = name.toLowerCase();
  return REQUIRED_SECTIONS.find((s) => s.toLowerCase() === lower);
}

/** First non-empty line of the README, stripped of markdown decoration. */
function readmePurpose(root) {
  const readme = ['README.md', 'README.txt', 'readme.md', 'readme.txt']
    .map((n) => path.join(root, n))
    .find((f) => fs.existsSync(f));
  if (!readme) return null;
  try {
    const first = fs
      .readFileSync(readme, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l);
    if (!first) return null;
    return first.replace(/^#{1,6}\s*/, '').replace(/[*_`#]/g, '').trim().slice(0, 160) || null;
  } catch {
    return null;
  }
}

/** package.json description, if any. */
function pkgPurpose(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return typeof pkg.description === 'string' && pkg.description.trim()
      ? pkg.description.trim().slice(0, 160)
      : null;
  } catch {
    return null;
  }
}

// Extension → what the directory contains (for honest, content-derived
// Purpose sentences on per-folder contracts).
const EXT_GROUPS = [
  { exts: new Set(['css', 'scss', 'sass', 'less']), label: 'the stylesheets' },
  { exts: new Set(['html', 'htm']), label: 'the HTML pages' },
  { exts: new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'vue', 'svelte']), label: 'the JavaScript/TypeScript source' },
  { exts: new Set(['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp']), label: 'the image assets' },
  { exts: new Set(['json']), label: 'the JSON configuration and data' },
  { exts: new Set(['md', 'markdown', 'rst', 'txt']), label: 'the documentation' },
  { exts: new Set(['py']), label: 'the Python source' },
  { exts: new Set(['go']), label: 'the Go source' },
  { exts: new Set(['java', 'kt']), label: 'the JVM source' },
  { exts: new Set(['rb']), label: 'the Ruby source' },
  { exts: new Set(['php']), label: 'the PHP source' },
  { exts: new Set(['c', 'h', 'cpp', 'hpp', 'cc', 'cxx']), label: 'the C/C++ source' },
  { exts: new Set(['rs']), label: 'the Rust source' },
];

/**
 * One-line factual summary of what a directory directly contains, derived
 * from the file extensions present (e.g. "the stylesheets", "the image
 * assets"). Returns null when nothing can be derived.
 */
function dirContentSummary(root, dirRel) {
  let files;
  try {
    files = fs.readdirSync(path.join(root, dirRel), { withFileTypes: true });
  } catch {
    return null;
  }
  const labels = new Set();
  for (const e of files) {
    if (!e.isFile()) continue;
    // ACC artifacts (the contract + its memory) are not folder content.
    if (e.name.toLowerCase() === 'agents.md' || e.name.toLowerCase() === '.acc-memory.md') continue;
    const ext = path.extname(e.name).toLowerCase().replace(/^\./, '');
    if (!ext) continue;
    for (const g of EXT_GROUPS) {
      if (g.exts.has(ext)) {
        labels.add(g.label);
        break;
      }
    }
  }
  const list = [...labels];
  if (list.length === 0) return null;
  return list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * One-line Purpose for a contract, derived per directory: the repo README/
 * package.json for the root contract, the directory's own contents for
 * per-folder contracts. Never invents facts.
 */
function deriveDirPurpose(root, dirRel, fallbackName) {
  if (!dirRel || dirRel === '.') {
    return readmePurpose(root) || pkgPurpose(root) || `This is the ${fallbackName} project.`;
  }
  const summary = dirContentSummary(root, dirRel);
  if (summary) {
    const name = path.posix.basename(dirRel) || dirRel;
    return `The ${name} directory contains ${summary}.`;
  }
  const name = path.posix.basename(dirRel) || dirRel;
  return `The ${name} directory holds part of the ${fallbackName} functionality.`;
}

/**
 * Rewrite one draft AGENTS.md: replace placeholder lines with derived content
 * and append missing required sections. Returns { items, output } — the
 * number of placeholder items resolved and the new text (null when nothing
 * changed).
 */
function fillOne(text, purpose, repoName) {
  const lines = text.split(/\r?\n/);

  // Pre-count each section's body: total non-empty lines vs placeholder lines
  // so a section whose entire body is placeholders collapses to one 'None.'
  // (matching what a careful human would write).
  const counts = new Map(); // raw heading -> { total, ph }
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (m && m[1]) {
      cur = m[1].replace(/[*`_]/g, '').trim();
      counts.set(cur, { total: 0, ph: 0 });
    } else if (cur && line.trim()) {
      const c = counts.get(cur);
      c.total++;
      if (isPlaceholder(line)) c.ph++;
    }
  }

  let items = 0;
  const out = [];
  cur = null;
  let emitted = false; // this section's replacement content already written

  const flushSection = () => {
    if (!cur) return;
    const c = counts.get(cur);
    if (c && c.total > 0 && c.ph === c.total && !emitted) {
      out.push('None.');
      items++;
      emitted = true;
    }
  };

  for (const line of lines) {
    const m = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (m && m[1]) {
      flushSection();
      cur = m[1].replace(/[*`_]/g, '').trim();
      emitted = false;
      out.push(line);
      // Empty required section (heading with no body) → add 'None.' so the
      // section counts as filled.
      const c = counts.get(cur);
      if (c && c.total === 0 && canon(cur)) {
        out.push('', 'None.');
        items++;
        emitted = true;
      }
      continue;
    }
    if (!cur || !line.trim()) {
      out.push(line);
      continue;
    }
    const c = counts.get(cur);
    const isPurpose = cur.toLowerCase() === 'purpose';
    const isOwnerLine = cur.toLowerCase() === 'ownership' && /^Owner\s*:/i.test(line.trim());
    if (isPlaceholder(line)) {
      if (isPurpose && !emitted) {
        out.push(purpose);
        emitted = true;
        items++;
      } else if (isOwnerLine && !emitted) {
        out.push(`Owner: ${repoName}`);
        emitted = true;
        items++;
      } else if (c.ph === c.total && !emitted) {
        // Entire section body is placeholders → one 'None.' replaces it.
        out.push('None.');
        emitted = true;
        items++;
      } else if (c.ph !== c.total && !emitted) {
        // Mixed section → replace just this placeholder line.
        out.push('None.');
        emitted = true;
        items++;
      }
      // otherwise: full-placeholder section already got its 'None.' — drop
      // the remaining placeholder lines.
    } else {
      out.push(line);
    }
  }
  flushSection();

  // Append required sections that are entirely missing.
  const present = new Set([...counts.keys()].map((h) => canon(h)).filter(Boolean));
  const missing = REQUIRED_SECTIONS.filter((s) => !present.has(s));
  if (missing.length) {
    if (out.length && out[out.length - 1] !== '') out.push('');
    for (const s of missing) {
      out.push('', `## ${s}`, '', 'None.');
      items++;
    }
  }

  const output = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
  return { items, output: items > 0 ? output : null };
}

/**
 * Fill every draft AGENTS.md listed by `acc fill --json` (fillResult.files).
 * Files already complete are left untouched. Each contract's Purpose is
 * derived from its own directory (root: README/package.json; subfolder:
 * its contents).
 *
 * Returns { files, items, dirs } — files rewritten, placeholder items
 * resolved, and the relative dirs of the contracts touched.
 */
function fillDraftAgentsFiles(root, fillResult, repoName) {
  const summary = { files: 0, items: 0, dirs: [] };
  const files = (fillResult && fillResult.files) || [];
  for (const file of files) {
    if (!file || file.status !== 'draft') continue;
    const abs = path.join(root, file.file);
    const dirRel = path.posix.dirname(file.file).replace(/^[./]+$/, '.') || '.';
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const purpose = deriveDirPurpose(root, dirRel, repoName);
    const { items, output } = fillOne(text, purpose, repoName);
    if (output !== null) {
      fs.writeFileSync(abs, output, 'utf8');
      summary.files++;
      summary.items += items;
      if (!summary.dirs.includes(dirRel)) summary.dirs.push(dirRel);
    }
  }
  return summary;
}

// Directories that never get a functionality contract.
const SKIP_COVERAGE_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor', '.git']);

/**
 * Directories that need a contract but have none: they directly contain at
 * least one file (any type — a static site's css/, images/ folders included)
 * and no AGENTS.md. The root is excluded (handled separately) and hidden/
 * noise directories are skipped. Returns relative dir paths.
 */
function missingContractDirs(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const rel = path.relative(root, dir).split(path.sep).join('/');
    const hasContract = entries.some((e) => e.isFile() && e.name.toLowerCase() === 'agents.md');
    if (rel !== '' && !hasContract) {
      const hasFile = entries.some((e) => e.isFile());
      if (hasFile) out.push(rel);
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.')) continue; // .git, .github, .acc, …
      if (SKIP_COVERAGE_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name));
    }
  };
  walk(root);
  return out;
}

/**
 * Contract directories that have an AGENTS.md but no filled .acc-memory.md
 * alongside it. ACC ties memory to functionality boundaries (docs/08): every
 * contract needs its memory file. `acc build` only creates memory for the
 * contracts IT generates, so pre-existing contracts and the scaffolded root
 * contract may lack one.
 *
 * Returns [{ dir, file }] — dir is '.' for the root boundary, file is the
 * missing .acc-memory.md path relative to root.
 */
function missingMemoryFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === '.acc') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      if (e.name.toLowerCase() !== 'agents.md') continue;
      const memFile = path.join(dir, '.acc-memory.md');
      let filled = false;
      try {
        filled = fs.readFileSync(memFile, 'utf8').trim() !== '';
      } catch {
        filled = false;
      }
      if (!filled) {
        out.push({
          dir: path.relative(root, dir).split(path.sep).join('/') || '.',
          file: path.relative(root, memFile).split(path.sep).join('/'),
        });
      }
    }
  };
  walk(root);
  return out;
}

module.exports = {
  fillDraftAgentsFiles,
  deriveDirPurpose,
  isPlaceholder,
  missingContractDirs,
  missingMemoryFiles,
  REQUIRED_SECTIONS,
};
