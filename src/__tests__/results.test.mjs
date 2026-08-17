import { describe, it, expect } from 'vitest';
import { generateDiffReport, DiffRange } from '../results.cjs';

describe('DiffRange', () => {
  it('creates empty diff range', () => {
    const diff = new DiffRange();
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });
});

describe('generateDiffReport', () => {
  const baseResult = {
    battleId: 'battle-abc123',
    timestamp: '2024-01-15T10:30:00.000Z',
    source: { type: 'local' },
    snapshot: { commitSha: 'abc123', snapshotHash: 'def456' },
    agents: [
      {
        name: 'default',
        model: 'gpt-4',
        success: true,
        metrics: { timeMs: 5000 },
        trace: 'Agent completed task successfully',
        diff: {
          added: ['new-file.js'],
          removed: ['old-file.js'],
          changed: ['existing-file.js'],
        },
      },
    ],
    environment: {
      image: 'node:24',
      digest: 'abc123',
      os: 'darwin',
      arch: 'arm64',
      runtimeVersions: { node: '20.10.0' },
    },
    diff: {
      added: ['new-file.js'],
      removed: ['old-file.js'],
      changed: ['existing-file.js'],
    },
  };

  it('generates report with all sections', () => {
    const report = generateDiffReport(baseResult);
    expect(report).toContain('# Battle Result: battle-abc123');
    expect(report).toContain('Timestamp: 2024-01-15T10:30:00.000Z');
    expect(report).toContain('## Source');
    expect(report).toContain('## Snapshot');
    expect(report).toContain('## Agents');
    expect(report).toContain('## Environment');
    expect(report).toContain('## Diff');
  });

  it('includes agent details', () => {
    const report = generateDiffReport(baseResult);
    expect(report).toContain('### default (gpt-4)');
    expect(report).toContain('Success: true');
    expect(report).toContain('"timeMs":5000');
  });

  it('includes agent diff files', () => {
    const report = generateDiffReport(baseResult);
    expect(report).toContain('Added: new-file.js');
    expect(report).toContain('Removed: old-file.js');
    expect(report).toContain('Changed: existing-file.js');
  });

  it('truncates long traces', () => {
    const longTrace = 'x'.repeat(300);
    const result = { ...baseResult, agents: [{ ...baseResult.agents[0], trace: longTrace }] };
    const report = generateDiffReport(result);
    expect(report).toContain('...');
  });

  it('includes environment info', () => {
    const report = generateDiffReport(baseResult);
    expect(report).toContain('Image: node:24');
    expect(report).toContain('OS: darwin');
    expect(report).toContain('Arch: arm64');
  });

  it('includes diff counts', () => {
    const report = generateDiffReport(baseResult);
    expect(report).toContain('Added files: 1');
    expect(report).toContain('Removed files: 1');
    expect(report).toContain('Changed files: 1');
  });

  it('handles source with revision', () => {
    const result = {
      ...baseResult,
      source: { type: 'git', revision: 'v1.0.0', resolvedRevision: 'abc123' },
    };
    const report = generateDiffReport(result);
    expect(report).toContain('Requested Revision: v1.0.0');
    expect(report).toContain('Resolved Revision: abc123');
  });

  it('handles empty agents', () => {
    const result = { ...baseResult, agents: [] };
    const report = generateDiffReport(result);
    expect(report).toContain('## Agents');
  });

  it('handles agent without diff', () => {
    const result = {
      ...baseResult,
      agents: [{ ...baseResult.agents[0], diff: undefined }],
    };
    const report = generateDiffReport(result);
    expect(report).toContain('### default (gpt-4)');
  });

  it('handles agent without trace', () => {
    const result = {
      ...baseResult,
      agents: [{ ...baseResult.agents[0], trace: undefined }],
    };
    const report = generateDiffReport(result);
    expect(report).toContain('### default (gpt-4)');
  });
});
