'use strict';

const path = require('path');
const fs = require('fs');

/**
 * Parse command-line arguments for the battle command.
 */
function parseArgs(argv) {
  const args = {};
  const positionals = [];
  let i = 0;

  while (i < argv.length) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (a === '--version' || a === '-V') {
      console.log('aba 0.1.0');
      process.exit(0);
    } else if (a === '--preserve') {
      args.preserve = true;
      i++;
    } else if (a === '--local') {
      args.local = true;
      i++;
    } else if (a === '--headless') {
      args.headless = true;
      i++;
    } else if (a === '--network' && i + 1 < argv.length) {
      args.network = argv[++i];
      i++;
    } else if (a === '--timeout' && i + 1 < argv.length) {
      args.timeout = parseInt(argv[++i], 10);
      i++;
    } else if (a === '--model' && i + 1 < argv.length) {
      args.model = argv[++i];
      i++;
    } else if (a === '--agent' && i + 1 < argv.length) {
      if (!args.agents) args.agents = [];
      args.agents.push(argv[++i]);
      i++;
    } else if (a.startsWith('--') || a.startsWith('-')) {
      i++;
    } else {
      positionals.push(a);
      i++;
    }
  }

  if (positionals.length > 0) args.project = positionals[0];
  if (positionals.length > 1) args.source = positionals[1];
  if (positionals.length > 2) args.config = positionals[2];

  // Set defaults
  if (!args.network) args.network = 'restricted';
  if (!args.timeout) args.timeout = 1800;

  return args;
}

/**
 * Determine the source type of a project specifier.
 *
 * Local paths (existing directories, absolute paths, `./` and `../`
 * relative paths) always win over GitHub shorthand.
 */
function detectSourceType(sourcePath) {
  if (/^https?:\/\//i.test(sourcePath)) {
    return /github\.com/i.test(sourcePath) ? 'github' : 'git';
  }
  if (sourcePath.startsWith('git@') || /\.git$/i.test(sourcePath)) {
    return 'git';
  }
  if (fs.existsSync(sourcePath)) {
    return 'local';
  }
  if (sourcePath.startsWith('/') || sourcePath.startsWith('./') || sourcePath.startsWith('../')) {
    return 'local';
  }
  // user/repo GitHub shorthand
  if (sourcePath.split('/').filter(Boolean).length >= 2 && !sourcePath.includes(' ')) {
    return 'github';
  }
  return 'local';
}

/**
 * Print help text for the battle command.
 */
function printHelp() {
  console.log(`\
ACC Battle Arena - Agent Benchmark Arena

Usage: node aba/index.cjs [options] [project]

By default ABA spawns the Vite web app (battle arena UI) in your browser.
Use --headless to run a benchmark directly from the terminal instead.

Options:
  --headless       Run headless CLI benchmark (no UI)
  --preserve       Preserve sandbox after battle for debugging
  --local          Run on the host (no Docker required)
  --network policy Set network policy: disabled|restricted|enabled
  --timeout seconds Set benchmark timeout in seconds
  --model model    Specify model to use (headless)
  --agent name     Specify agent name (repeatable, headless)
  --help, -h       Show this help message
  --version, -V    Show version

Project sources (headless):
  Local: /path/to/project, ./relative, or .
  GitHub: user/repo or https://github.com/user/repo
  Git: git URL with optional --revision

Examples:
  node aba/index.cjs                    # open the battle arena UI
  node aba/index.cjs ./my-project       # open the UI with a repo preloaded
  node aba/index.cjs ./my-project --headless --local
`);
}

/**
 * Build the full battle configuration from parsed args and defaults.
 */
function buildBattleConfig(args) {
  // Determine source type and details
  const sourcePath = args.project || process.cwd();
  const sourceType = detectSourceType(sourcePath);
  const revision = args.revision;

  // Build source spec
  const source = {
    type: sourceType,
    pathOrUrl: sourcePath,
    revision,
  };

  // Build sandbox config
  const sandboxConfig = {
    image: 'node:24',
    network: args.network || 'restricted',
    allowedApis: args.allowedApis ? args.allowedApis.split(',') : undefined,
    timeout: args.timeout,
    preserve: args.preserve,
    env: args.env,
    secrets: args.secrets,
    local: args.local,
  };

  // Build agents list
  const agents = args.agents && args.agents.length > 0
    ? args.agents.map((a) => {
        const parts = a.split(':');
        return { name: parts[0] || 'default', model: parts[1] || 'gpt-4' };
      })
    : [{ name: 'default', model: args.model || 'gpt-4' }];

  // Task - always required
  const task = args.task || 'Complete the assigned software engineering task';

  return {
    source,
    sandbox: sandboxConfig,
    agents,
    task,
  };
}

module.exports = {
  parseArgs,
  buildBattleConfig,
  printHelp,
  detectSourceType,
};
