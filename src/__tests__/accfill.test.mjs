/**
 * ACC readiness — the loaded repo must be FULLY ACC-compliant before battle.
 *
 * This mirrors what the server does at repo load on the ACC sandbox:
 *   acc init → acc build --yes → acc fill (analysis) → deterministic fill
 *   (src/accfill.cjs) → acc fill (confirm draft 0) → acc check (validate)
 * …and asserts the ACC panel ends up with ALL the framework files, with every
 * AGENTS.md contract complete (no template placeholders), while a plain copy
 * of the same repo has none of it.
 *
 * No network: everything runs against a temp fixture + the npm-installed acc
 * CLI. Run: npx vitest run src/__tests__/accfill.test.mjs
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fillDraftAgentsFiles, missingContractDirs, missingMemoryFiles } from '../accfill.cjs';
import { writeAccConfig, verifyAccDocumented } from '../accsetup.cjs';

const ACC = path.join(process.cwd(), 'node_modules', 'acc-agents', 'bin', 'acc.js');

function acc(args, cwd) {
  return execFileSync(process.execPath, [ACC, ...args], { cwd, encoding: 'utf8' });
}

/** JSON result of `acc <cmd> --json` (the CLI prints { result: ... }). */
function accJson(args, cwd) {
  return JSON.parse(acc(args, cwd)).result;
}

/** Build a fixture repo in a fresh temp dir. */
function makeFixture(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aba-accfill-'));
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# Cannabinoid Explorer\n\nA static site that lists cannabis effects.\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cannabinoid-explorer', description: 'A static site that lists cannabis effects.' }));
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("hello");\n');
  fs.writeFileSync(path.join(dir, 'src', 'util.js'), 'export function util() { return 1; }\n');
  // Static-site folders — only css/svg content, which acc build skips (its
  // source-extension detection misses them) but the coverage pass must cover.
  fs.mkdirSync(path.join(dir, 'css'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'images', 'sprites'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'css', 'main.css'), 'body { color: #333; }\n');
  fs.writeFileSync(path.join(dir, 'images', 'sprites', 'console1.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  if (extra.agentsMd) fs.writeFileSync(path.join(dir, 'AGENTS.md'), extra.agentsMd);
  // A contract that PRE-EXISTED in the source (acc build skips it and never
  // creates its memory record — the pipeline must fill the gap).
  if (extra.srcAgentsMd) fs.writeFileSync(path.join(dir, 'src', 'AGENTS.md'), extra.srcAgentsMd);
  return dir;
}

/** Recursively list relative paths under dir (dirs end with /). */
function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = entry.name + (entry.isDirectory() ? '/' : '');
    if (entry.isDirectory()) {
      out.push(rel);
      out.push(...listFiles(path.join(dir, entry.name)).map((p) => `${entry.name}/${p}`));
    } else {
      out.push(rel);
    }
  }
  return out;
}

describe('ACC readiness at load (init → build → fill → check)', () => {
  it('leaves the ACC sandbox fully ACC-compliant with all framework files', async () => {
    const src = makeFixture();
    const accDir = path.join(src, 'acc');
    const plainDir = path.join(src, 'plain');
    fs.mkdirSync(accDir);
    fs.mkdirSync(plainDir);
    // Copy the repo into both panels (the server's copyDirectory does the same
    // for the snapshot — the plain panel is never touched by the pipeline).
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.name === 'acc' || entry.name === 'plain') continue;
      fs.cpSync(path.join(src, entry.name), path.join(accDir, entry.name), { recursive: true });
      fs.cpSync(path.join(src, entry.name), path.join(plainDir, entry.name), { recursive: true });
    }

    // The source repo (and therefore the plain panel) has NO acc artifacts.
    const plainFiles = listFiles(plainDir);
    expect(plainFiles).not.toContain('.acc/');
    expect(plainFiles).not.toContain('AGENTS.md');
    expect(plainFiles).not.toContain('.acc-memory.md');

    // ── Run the same pipeline the server runs on the ACC sandbox ──────────
    acc(['init', '.'], accDir);
    acc(['build', '--yes'], accDir);
    // acc build deliberately skips the root (always a boundary) — the server
    // scaffolds the root contract with acc document when missing.
    if (!fs.existsSync(path.join(accDir, 'AGENTS.md'))) acc(['document', '.', '--apply'], accDir);

    // acc init leaves workflows/ empty — the server scaffolds the standard
    // generic workflow set (additive, never overwrites).
    const wfSrc = path.join(process.cwd(), 'src', 'acc-config', 'workflows');
    const wfDst = path.join(accDir, '.acc', 'config', 'workflows');
    fs.mkdirSync(wfDst, { recursive: true });
    const wfFiles = fs.readdirSync(wfSrc).filter((f) => f.endsWith('.md'));
    for (const f of wfFiles) {
      if (!fs.existsSync(path.join(wfDst, f))) fs.copyFileSync(path.join(wfSrc, f), path.join(wfDst, f));
    }
    expect(wfFiles.length).toBeGreaterThanOrEqual(7);
    expect(fs.readdirSync(wfDst).sort()).toEqual(wfFiles.sort());

    // acc config (settings + agents + standards) — the server generates the
    // FULL project-aware control plane (init's config.yaml is minimal and
    // agents/standards/ are empty).
    const setup = writeAccConfig(accDir, 'cannabinoid-explorer', { overwriteConfig: true });
    expect(setup.config).toBe(true);
    expect(setup.languages).toContain('javascript'); // app.js + src/util.js
    expect(setup.ignore).toEqual(['node_modules', 'dist', 'build', 'coverage']);
    expect(setup.agents).toContain('default.md');
    expect(setup.standards).toEqual(['architecture.md', 'coding.md', 'review.md']);

    // Folder coverage — acc build skips css/ and images/sprites (no source
    // code), so the server documents every content folder via acc document.
    expect(missingContractDirs(accDir).sort()).toEqual(['css', 'images/sprites']);
    for (const dir of missingContractDirs(accDir)) acc(['document', dir, '--apply'], accDir);
    expect(missingContractDirs(accDir)).toEqual([]);

    // acc fill analysis finds draft contracts (placeholders still present).
    const fillBefore = accJson(['fill', '--json'], accDir);
    expect(fillBefore.summary.total).toBeGreaterThanOrEqual(4); // root + src + css + sprites
    expect(fillBefore.summary.draft).toBeGreaterThan(0);
    expect(fillBefore.summary.placeholder_items).toBeGreaterThan(0);

    // Deterministic fill — the new server step that actually completes the
    // contracts instead of just reporting what needs filling.
    const applied = fillDraftAgentsFiles(accDir, fillBefore, 'cannabinoid-explorer');
    expect(applied.files).toBeGreaterThanOrEqual(4);
    expect(applied.items).toBeGreaterThan(0);

    // acc fill confirms: NOTHING left to fill — every contract complete.
    const fillAfter = accJson(['fill', '--json'], accDir);
    expect(fillAfter.summary.draft).toBe(0);
    expect(fillAfter.summary.placeholder_items).toBe(0);
    expect(fillAfter.summary.total).toBeGreaterThanOrEqual(4); // contracts exist to check

    // Memory records — the server step that guarantees EVERY contract has a
    // filled .acc-memory.md alongside it, and that the log records the
    // adoption changes (fresh contracts get an initial record; completed
    // contracts get a change entry; the root gets the adoption record).
    const missingMemory = missingMemoryFiles(accDir);
    expect(missingMemory.map((m) => m.dir).sort()).toEqual(['css', 'images/sprites']); // no memory yet
    for (const m of missingMemory) {
      acc(['memory', 'add', m.dir === '.' ? '.' : m.dir, `Initial record created by ABA — ${m.dir} was bound to the ACC graph.`], accDir);
    }
    for (const dir of applied.dirs || []) {
      if (missingMemory.some((m) => m.dir === dir)) continue;
      acc(['memory', 'add', dir === '.' ? '.' : dir, 'AGENTS.md contract completed by ABA.'], accDir);
    }
    acc(['memory', 'add', '.', 'Repository adopted to ACC by ABA — init, build, fill, and validation passed.'], accDir);
    expect(missingMemoryFiles(accDir)).toEqual([]);

    // ── ALL the ACC framework files are present before battle ─────────────
    const accFiles = listFiles(accDir);
    expect(accFiles).toContain('.acc/');
    expect(accFiles).toContain('.acc/config/');
    expect(accFiles).toContain('.acc/config/config.yaml');
    expect(accFiles).toContain('.acc/config/agents/');
    expect(accFiles).toContain('.acc/config/workflows/');
    expect(accFiles).toContain('.acc/config/workflows/feature.md');
    expect(accFiles).toContain('.acc/config/workflows/release.md');
    expect(accFiles).toContain('.acc/config/agents/default.md');
    expect(accFiles).toContain('.acc/config/standards/');
    expect(accFiles).toContain('.acc/config/standards/architecture.md');
    expect(accFiles).toContain('.acc/config/standards/coding.md');
    expect(accFiles).toContain('.acc/config/standards/review.md');
    // The docs' full control plane: skills, mcp, tools, multi-agent.
    expect(accFiles).toContain('.acc/config/skills/');
    expect(accFiles).toContain('.acc/config/skills/README.md');
    expect(accFiles).toContain('.acc/config/mcp/');
    expect(accFiles).toContain('.acc/config/mcp/README.md');
    expect(accFiles).toContain('.acc/config/tools/');
    expect(accFiles).toContain('.acc/config/tools/README.md');
    expect(accFiles).toContain('.acc/config/multi-agent/');
    expect(accFiles).toContain('.acc/config/multi-agent/README.md');
    expect(accFiles).toContain('AGENTS.md');            // root contract
    expect(accFiles).toContain('src/AGENTS.md');        // source-folder contract
    expect(accFiles).toContain('css/AGENTS.md');        // static-folder contract
    expect(accFiles).toContain('images/sprites/AGENTS.md');
    expect(accFiles).toContain('.acc-memory.md');       // root memory record

    // Every contract is complete: all required sections, no placeholders,
    // derived Purpose + Ownership content. Root purpose comes from the
    // README; folder purposes are derived from each folder's contents.
    const rootText = fs.readFileSync(path.join(accDir, 'AGENTS.md'), 'utf8');
    for (const section of ['Purpose', 'Responsibilities', 'Ownership', 'Inputs', 'Outputs', 'Dependencies', 'Constraints', 'Architecture']) {
      expect(rootText).toMatch(new RegExp(`^## ${section}$`, 'm'));
    }
    expect(rootText).not.toMatch(/<[^>]+>/);
    expect(rootText).not.toMatch(/Describe what .+ does in one sentence/);
    expect(rootText).toContain('Cannabinoid Explorer');          // Purpose from README
    expect(rootText).toMatch(/^Owner: cannabinoid-explorer$/m);  // Ownership from repo name
    for (const [rel, expectPurpose] of [
      ['css/AGENTS.md', /contains the stylesheets/],
      ['images/sprites/AGENTS.md', /contains the image assets/],
      ['src/AGENTS.md', /The src directory/],
    ]) {
      const text = fs.readFileSync(path.join(accDir, rel), 'utf8');
      expect(text).not.toMatch(/<[^>]+>/);
      expect(text).not.toMatch(/Describe what .+ does in one sentence/);
      expect(text).toMatch(expectPurpose);
      expect(text).toMatch(/^Owner: cannabinoid-explorer$/m);
    }

    // Every AGENTS.md contract has a filled .acc-memory.md alongside it, and
    // the memory log records the adoption changes.
    const contractDirs = ['.', 'src', 'css', 'images/sprites'];
    for (const dir of contractDirs) {
      const mem = path.join(accDir, dir === '.' ? '.acc-memory.md' : path.join(dir, '.acc-memory.md'));
      expect(fs.existsSync(mem)).toBe(true);
      expect(fs.readFileSync(mem, 'utf8').trim()).not.toBe('');
      expect(fs.readFileSync(mem, 'utf8')).toMatch(/^## \d{4}-\d{2}-\d{2}/m); // timestamped record
      expect(fs.readFileSync(mem, 'utf8')).toMatch(/ABA/); // adoption recorded
    }

    // config.yaml carries EVERY supported setting, project-aware: language
    // analyzers for the languages actually present, ignore list for build
    // noise, plus the full settings surface the framework reads.
    const cfgText = fs.readFileSync(path.join(accDir, '.acc', 'config', 'config.yaml'), 'utf8');
    for (const key of ['schema_version', 'language_analyzers', 'ignore', 'diagnostics', 'ownership', 'multi_agent', 'tools', 'context', 'graph', 'memory']) {
      expect(cfgText).toContain(`${key}:`);
    }
    expect(cfgText).toContain('javascript: true');
    expect(cfgText).toContain('- node_modules');
    expect(cfgText).toContain('- dist');
    expect(cfgText).toContain('multi_agent:');
    expect(cfgText).toContain('isolation_mode: git_worktree');
    // The docs' full settings surface: resource limits + the tools block.
    expect(cfgText).toContain('resource_limits:');
    expect(cfgText).toContain('cpu_percent: 80');
    expect(cfgText).toContain('token_budget: 1000000');
    expect(cfgText).toContain('defaults:');
    expect(cfgText).toContain('allowed_commands: []');
    expect(cfgText).toContain('approval: auto');
    expect(cfgText).toContain('permissions:');
    expect(cfgText).toContain('network:');

    // acc check validates the panel against the framework's own rules —
    // zero error diagnostics means ACC-compliant.
    const check = accJson(['check', '--json', '--exit-zero'], accDir);
    expect(check.summary.errors).toBe(0);
    expect(check.exit_code).toBe(0);

    // Final verification — the repo is FULLY ACC documented: every config
    // file present and set, every content folder contracted, every contract
    // complete, every memory file filled.
    const runAccLike = (args, cwd) => {
      try {
        return { code: 0, out: acc(args, cwd) };
      } catch (e) {
        return { code: 1, out: '', err: String(e) };
      }
    };
    const problems = await verifyAccDocumented(accDir, runAccLike);
    expect(problems).toEqual([]);

    // The plain panel still has none of it.
    expect(fs.existsSync(path.join(plainDir, '.acc'))).toBe(false);
    expect(fs.existsSync(path.join(plainDir, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(plainDir, '.acc-memory.md'))).toBe(false);
  });

  it('is a no-op for repos whose AGENTS.md contracts are already complete', () => {
    const complete = [
      '# already',
      '',
      '## Purpose',
      '',
      'Does the thing.',
      '',
      '## Responsibilities',
      '',
      '- Real responsibility',
      '',
      '## Ownership',
      '',
      'Owner: the team',
      '',
      '## Inputs',
      '',
      '- config',
      '',
      '## Outputs',
      '',
      '- result',
      '',
      '## Dependencies',
      '',
      '- src/helpers',
      '',
      '## Constraints',
      '',
      '- read-only',
      '',
      '## Architecture',
      '',
      'Small and simple.',
      '',
    ].join('\n');
    const dir = makeFixture({ agentsMd: complete });
    const fill = accJson(['fill', '--json'], dir);
    expect(fill.summary.draft).toBe(0);

    const before = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    const applied = fillDraftAgentsFiles(dir, fill, 'whatever');
    expect(applied.files).toBe(0);
    expect(applied.items).toBe(0);
    expect(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toBe(before);
  });

  it('creates a filled .acc-memory.md for a pre-existing contract that had none', () => {
    // src/AGENTS.md pre-exists in the source (build skips it → no memory),
    // so the pipeline must create its memory record.
    const srcContract = [
      '# src',
      '',
      '## Purpose',
      '',
      'Describe what src does in one sentence.',
      '',
      '## Responsibilities',
      '',
      '- <Responsibility 1>',
      '',
    ].join('\n');
    const dir = makeFixture({ srcAgentsMd: srcContract });

    // Mirror the server pipeline: init → build → root contract → fill →
    // memory. (The pre-existing src/AGENTS.md keeps src/ out of build's
    // creation list, so no memory record is made for it.)
    acc(['init', '.'], dir);
    acc(['build', '--yes'], dir);
    if (!fs.existsSync(path.join(dir, 'AGENTS.md'))) acc(['document', '.', '--apply'], dir);
    const fill = accJson(['fill', '--json'], dir);
    fillDraftAgentsFiles(dir, fill, 'fixture');
    expect(accJson(['fill', '--json'], dir).summary.draft).toBe(0);

    // The memory step finds src/ missing its record and creates it.
    const missing = missingMemoryFiles(dir);
    expect(missing.some((m) => m.dir === 'src')).toBe(true);
    for (const m of missing) {
      acc(['memory', 'add', m.dir === '.' ? '.' : m.dir, 'Initial record created by ABA — fixture bound to the ACC graph.'], dir);
    }
    expect(missingMemoryFiles(dir)).toEqual([]);

    const mem = fs.readFileSync(path.join(dir, 'src', '.acc-memory.md'), 'utf8');
    expect(mem.trim()).not.toBe('');
    expect(mem).toMatch(/^## \d{4}-\d{2}-\d{2}/m);

    // The pre-existing contract itself was completed by the fill too.
    const text = fs.readFileSync(path.join(dir, 'src', 'AGENTS.md'), 'utf8');
    expect(text).not.toMatch(/<[^>]+>/);
    expect(text).toMatch(/^## (Purpose|Responsibilities|Ownership|Inputs|Outputs|Dependencies|Constraints|Architecture)$/gm);
  });

  it('appends missing sections and fills partial placeholders in existing contracts', () => {
    // A contract with only Purpose + a mixed Responsibilities section: the
    // filler must derive Purpose, replace the one placeholder bullet, and
    // append every missing required section.
    const partial = [
      '# partial',
      '',
      '## Purpose',
      '',
      'Describe what partial does in one sentence.',
      '',
      '## Responsibilities',
      '',
      '- Real responsibility',
      '- <Placeholder bullet>',
      '',
    ].join('\n');
    const dir = makeFixture({ agentsMd: partial });
    const fill = accJson(['fill', '--json'], dir);
    expect(fill.summary.draft).toBe(1);

    const applied = fillDraftAgentsFiles(dir, fill, 'partial');
    expect(applied.files).toBe(1);
    expect(applied.items).toBeGreaterThanOrEqual(2);

    const after = accJson(['fill', '--json'], dir);
    expect(after.summary.draft).toBe(0);

    const text = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
    for (const section of ['Purpose', 'Responsibilities', 'Ownership', 'Inputs', 'Outputs', 'Dependencies', 'Constraints', 'Architecture']) {
      expect(text).toMatch(new RegExp(`^## ${section}$`, 'm'));
    }
    expect(text).toContain('Real responsibility');
    expect(text).not.toMatch(/<[^>]+>/);
  });
});
