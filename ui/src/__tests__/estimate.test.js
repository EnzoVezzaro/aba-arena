import { describe, it, expect } from 'vitest';
import { estimateTokens, estimateUsage } from '../estimate.js';

describe('estimateTokens', () => {
  it('returns 0 for empty text', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });

  it('approximates ~4 characters per token, at least 1', () => {
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('x'.repeat(400))).toBe(100);
    expect(estimateTokens('x'.repeat(402))).toBe(101); // 100.5 rounds up
    expect(estimateTokens('word '.repeat(100))).toBe(125); // 500 chars
  });
});

describe('estimateUsage', () => {
  it('estimates input from system+prompt+context and output from the answer text', () => {
    const u = estimateUsage({
      system: 's'.repeat(400),
      prompt: 'p'.repeat(400),
      context: 'c'.repeat(400),
      output: 'o'.repeat(1200),
    });
    expect(u.inputTokens).toBe(301); // (400+400+400 + 4 separator chars) / 4
    expect(u.outputTokens).toBe(300); // 1200 / 4
  });

  it('handles missing fields gracefully', () => {
    const u = estimateUsage({ output: 'hello world' });
    expect(u.inputTokens).toBeGreaterThan(0); // empty prompt still counts a token
    expect(u.outputTokens).toBe(3); // 11 chars / 4 ≈ 3
  });
});
