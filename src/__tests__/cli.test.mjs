import { describe, it, expect } from 'vitest';
import { parseArgs, buildBattleConfig, detectSourceType, printHelp } from '../cli.cjs';

describe('parseArgs', () => {
  it('returns defaults for empty args', () => {
    const result = parseArgs([]);
    expect(result).toEqual({ network: 'restricted', timeout: 1800 });
  });

  it('parses project as first positional', () => {
    const result = parseArgs(['./my-project']);
    expect(result.project).toBe('./my-project');
  });

  it('parses source as second positional', () => {
    const result = parseArgs(['./my-project', 'https://github.com/user/repo']);
    expect(result.source).toBe('https://github.com/user/repo');
  });

  it('parses config as third positional', () => {
    const result = parseArgs(['./my-project', 'source', 'config.json']);
    expect(result.config).toBe('config.json');
  });

  it('parses --preserve flag', () => {
    const result = parseArgs(['--preserve']);
    expect(result.preserve).toBe(true);
  });

  it('parses --local flag', () => {
    const result = parseArgs(['--local']);
    expect(result.local).toBe(true);
  });

  it('parses --headless flag', () => {
    const result = parseArgs(['--headless']);
    expect(result.headless).toBe(true);
  });

  it('parses --network with value', () => {
    const result = parseArgs(['--network', 'disabled']);
    expect(result.network).toBe('disabled');
  });

  it('parses --timeout with numeric value', () => {
    const result = parseArgs(['--timeout', '3600']);
    expect(result.timeout).toBe(3600);
  });

  it('parses --model with value', () => {
    const result = parseArgs(['--model', 'gpt-4']);
    expect(result.model).toBe('gpt-4');
  });

  it('parses multiple --agent flags', () => {
    const result = parseArgs(['--agent', 'default:gpt-4', '--agent', 'test:claude-3']);
    expect(result.agents).toEqual(['default:gpt-4', 'test:claude-3']);
  });

  it('sets default network to restricted', () => {
    const result = parseArgs([]);
    expect(result.network).toBe('restricted');
  });

  it('sets default timeout to 1800', () => {
    const result = parseArgs([]);
    expect(result.timeout).toBe(1800);
  });

  it('handles mixed flags and positionals', () => {
    const result = parseArgs(['--headless', './my-project', '--model', 'gpt-4']);
    expect(result.headless).toBe(true);
    expect(result.project).toBe('./my-project');
    expect(result.model).toBe('gpt-4');
  });

  it('ignores unknown flags', () => {
    const result = parseArgs(['--unknown', 'value']);
    expect(result).not.toHaveProperty('unknown');
  });
});

describe('detectSourceType', () => {
  it('detects GitHub URLs', () => {
    expect(detectSourceType('https://github.com/user/repo')).toBe('github');
  });

  it('detects GitHub shorthand', () => {
    expect(detectSourceType('user/repo')).toBe('github');
  });

  it('detects git URLs', () => {
    expect(detectSourceType('git@github.com:user/repo.git')).toBe('git');
  });

  it('detects local paths with ./ prefix', () => {
    expect(detectSourceType('./my-project')).toBe('local');
  });

  it('detects local paths with ../ prefix', () => {
    expect(detectSourceType('../my-project')).toBe('local');
  });

  it('detects absolute paths', () => {
    expect(detectSourceType('/path/to/project')).toBe('local');
  });

  it('detects current directory', () => {
    expect(detectSourceType('.')).toBe('local');
  });

  it('detects non-GitHub HTTP URLs as git', () => {
    expect(detectSourceType('https://gitlab.com/user/repo')).toBe('git');
  });
});

describe('buildBattleConfig', () => {
  it('creates config with defaults', () => {
    const config = buildBattleConfig({});
    expect(config.source).toBeDefined();
    expect(config.sandbox).toBeDefined();
    expect(config.agents).toBeDefined();
    expect(config.task).toBeDefined();
  });

  it('uses provided project path', () => {
    const config = buildBattleConfig({ project: './my-project' });
    expect(config.source.pathOrUrl).toBe('./my-project');
  });

  it('uses provided model', () => {
    const config = buildBattleConfig({ model: 'gpt-4' });
    expect(config.agents[0].model).toBe('gpt-4');
  });

  it('parses agent specifications', () => {
    const config = buildBattleConfig({ agents: ['default:gpt-4', 'test:claude-3'] });
    expect(config.agents).toHaveLength(2);
    expect(config.agents[0]).toEqual({ name: 'default', model: 'gpt-4' });
    expect(config.agents[1]).toEqual({ name: 'test', model: 'claude-3' });
  });

  it('creates default agent when none provided', () => {
    const config = buildBattleConfig({});
    expect(config.agents).toHaveLength(1);
    expect(config.agents[0].name).toBe('default');
  });

  it('sets sandbox network policy', () => {
    const config = buildBattleConfig({ network: 'disabled' });
    expect(config.sandbox.network).toBe('disabled');
  });

  it('sets sandbox timeout', () => {
    const config = buildBattleConfig({ timeout: 3600 });
    expect(config.sandbox.timeout).toBe(3600);
  });

  it('sets preserve flag', () => {
    const config = buildBattleConfig({ preserve: true });
    expect(config.sandbox.preserve).toBe(true);
  });

  it('sets local flag', () => {
    const config = buildBattleConfig({ local: true });
    expect(config.sandbox.local).toBe(true);
  });

  it('detects source type correctly', () => {
    const config = buildBattleConfig({ project: 'user/repo' });
    expect(config.source.type).toBe('github');
  });
});

describe('printHelp', () => {
  it('does not throw', () => {
    expect(() => printHelp()).not.toThrow();
  });
});
