import { describe, it, expect } from 'vitest';
import {
  fmtInt,
  fmtDur,
  fmtCost,
  fmtRate,
  estTokens,
  extractCode,
  extractAnswer,
  hasIncompleteCodeFence,
  downsample,
  computeWinners,
} from '../arena.js';

describe('fmtInt', () => {
  it('formats numbers with locale', () => {
    expect(fmtInt(1234567)).toBe('1,234,567');
  });

  it('returns dash for null', () => {
    expect(fmtInt(null)).toBe('—');
  });

  it('returns dash for undefined', () => {
    expect(fmtInt(undefined)).toBe('—');
  });

  it('returns dash for NaN', () => {
    expect(fmtInt(NaN)).toBe('—');
  });

  it('formats zero', () => {
    expect(fmtInt(0)).toBe('0');
  });
});

describe('fmtDur', () => {
  it('formats milliseconds under 1000', () => {
    expect(fmtDur(500)).toBe('500ms');
  });

  it('formats seconds', () => {
    expect(fmtDur(1500)).toBe('1.50s');
  });

  it('formats exact second', () => {
    expect(fmtDur(1000)).toBe('1.00s');
  });

  it('returns dash for null', () => {
    expect(fmtDur(null)).toBe('—');
  });

  it('returns dash for NaN', () => {
    expect(fmtDur(NaN)).toBe('—');
  });

  it('formats large values', () => {
    expect(fmtDur(123456)).toBe('123.46s');
  });
});

describe('fmtCost', () => {
  it('returns dash for null', () => {
    expect(fmtCost(null)).toBe('—');
  });

  it('returns dash for NaN', () => {
    expect(fmtCost(NaN)).toBe('—');
  });

  it('returns $0 for zero', () => {
    expect(fmtCost(0)).toBe('$0');
  });

  it('formats costs >= 0.01', () => {
    expect(fmtCost(0.0123)).toBe('$0.0123');
  });

  it('formats small costs with precision', () => {
    expect(fmtCost(0.00123)).toBe('$0.0012');
  });

  it('formats large costs', () => {
    expect(fmtCost(1.2345)).toBe('$1.2345');
  });
});

describe('fmtRate', () => {
  it('formats rates >= 1 as integer', () => {
    expect(fmtRate(5.7)).toBe('6');
  });

  it('formats rates < 1 with one decimal', () => {
    expect(fmtRate(0.5)).toBe('0.5');
  });

  it('formats exact 1', () => {
    expect(fmtRate(1)).toBe('1');
  });
});

describe('estTokens', () => {
  it('estimates tokens from string length', () => {
    expect(estTokens('hello world')).toBe(3);
  });

  it('returns 0 for empty string', () => {
    expect(estTokens('')).toBe(0);
  });

  it('returns 0 for null', () => {
    expect(estTokens(null)).toBe(0);
  });

  it('returns 0 for undefined', () => {
    expect(estTokens(undefined)).toBe(0);
  });

  it('returns at least 1 for non-empty string', () => {
    expect(estTokens('a')).toBe(1);
  });
});

describe('extractCode', () => {
  it('extracts fenced code block', () => {
    const text = 'Some text\n```js\nconst x = 1;\n```\nMore text';
    expect(extractCode(text)).toBe('const x = 1;');
  });

  it('extracts first code block', () => {
    const text = '```js\nfirst\n```\n```js\nsecond\n```';
    expect(extractCode(text)).toBe('first');
  });

  it('extracts HTML document', () => {
    const text = 'Here is the code:\n```html\n<!DOCTYPE html>\n<html>\n<body>Hello</body>\n</html>\n```';
    expect(extractCode(text)).toContain('<!DOCTYPE html>');
  });

  it('extracts bare HTML without fence', () => {
    const text = 'Some text\n<!DOCTYPE html>\n<html><body>Hello</body></html>';
    expect(extractCode(text)).toContain('<!DOCTYPE html>');
  });

  it('returns empty string if no code found', () => {
    const text = 'Just some plain text without code';
    expect(extractCode(text)).toBe('');
  });

  it('handles unclosed code fence', () => {
    const text = '```js\nconst x = 1;';
    expect(extractCode(text)).toBe('const x = 1;');
  });
});

describe('extractAnswer', () => {
  it('removes code blocks and returns prose', () => {
    const text = 'Here is my answer:\n```js\nconst x = 1;\n```\nThat was the code.';
    const result = extractAnswer(text);
    expect(result).toContain('Here is my answer:');
    expect(result).toContain('That was the code.');
    expect(result).not.toContain('const x = 1;');
  });

  it('returns empty string if only code', () => {
    const text = '```js\nconst x = 1;\n```';
    expect(extractAnswer(text)).toBe('');
  });

  it('returns original text if no code blocks', () => {
    const text = 'Just plain text';
    expect(extractAnswer(text)).toBe('Just plain text');
  });

  it('handles multiple code blocks', () => {
    const text = 'Text\n```js\na\n```\nMiddle\n```js\nb\n```\nEnd';
    const result = extractAnswer(text);
    expect(result).toContain('Text');
    expect(result).toContain('Middle');
    expect(result).toContain('End');
    expect(result).not.toContain('a');
    expect(result).not.toContain('b');
  });
});

describe('hasIncompleteCodeFence', () => {
  it('returns false for no fences', () => {
    expect(hasIncompleteCodeFence('no code here')).toBe(false);
  });

  it('returns false for complete fence', () => {
    expect(hasIncompleteCodeFence('```js\nconst x = 1;\n```')).toBe(false);
  });

  it('returns true for incomplete fence', () => {
    expect(hasIncompleteCodeFence('```js\nconst x = 1;')).toBe(true);
  });

  it('returns false for two incomplete fences (complete pair)', () => {
    expect(hasIncompleteCodeFence('```js\na\n```\n```js\nb\n```')).toBe(false);
  });

  it('returns true for three fences (incomplete pair)', () => {
    expect(hasIncompleteCodeFence('```js\na\n```\n```js\nb\n```\n```js\nc')).toBe(true);
  });
});

describe('downsample', () => {
  it('returns same array if within maxPoints', () => {
    const samples = [1, 2, 3];
    expect(downsample(samples, 10)).toEqual([1, 2, 3]);
  });

  it('keeps first and last points', () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = downsample(samples, 5);
    expect(result[0]).toBe(1);
    expect(result[result.length - 1]).toBe(10);
    expect(result.length).toBe(5);
  });

  it('returns empty array for empty input', () => {
    expect(downsample([], 5)).toEqual([]);
  });

  it('handles maxPoints of 1', () => {
    const samples = [1, 2, 3];
    expect(downsample(samples, 1)).toEqual([1]);
  });

  it('handles maxPoints of 2', () => {
    const samples = [1, 2, 3, 4, 5];
    const result = downsample(samples, 2);
    expect(result).toEqual([1, 5]);
  });
});

describe('computeWinners', () => {
  it('returns empty map for fewer than 2 panels', () => {
    const result = computeWinners([{ id: 'acc', timeMs: 100 }]);
    expect(result.size).toBe(0);
  });

  it('returns empty map for empty array', () => {
    const result = computeWinners([]);
    expect(result.size).toBe(0);
  });

  it('identifies fastest panel', () => {
    const panels = [
      { id: 'acc', timeMs: 100, cost: 0.01, outputTokens: 1000 },
      { id: 'plain', timeMs: 200, cost: 0.02, outputTokens: 1000 },
    ];
    const result = computeWinners(panels);
    expect(result.get('acc').fast).toBe(true);
    expect(result.get('plain').fast).toBe(false);
  });

  it('identifies cheapest panel', () => {
    const panels = [
      { id: 'acc', timeMs: 100, cost: 0.01, outputTokens: 1000 },
      { id: 'plain', timeMs: 200, cost: 0.02, outputTokens: 1000 },
    ];
    const result = computeWinners(panels);
    expect(result.get('acc').cheap).toBe(true);
    expect(result.get('plain').cheap).toBe(false);
  });

  it('no winner on tie', () => {
    const panels = [
      { id: 'acc', timeMs: 100, cost: 0.01, outputTokens: 1000 },
      { id: 'plain', timeMs: 100, cost: 0.01, outputTokens: 1000 },
    ];
    const result = computeWinners(panels);
    expect(result.get('acc').fast).toBe(false);
    expect(result.get('plain').fast).toBe(false);
  });

  it('identifies highest throughput', () => {
    const panels = [
      { id: 'acc', timeMs: 100, genMs: 100, cost: 0.01, outputTokens: 2000 },
      { id: 'plain', timeMs: 100, genMs: 100, cost: 0.01, outputTokens: 1000 },
    ];
    const result = computeWinners(panels);
    expect(result.get('acc').tput).toBe(true);
    expect(result.get('plain').tput).toBe(false);
  });

  it('handles panels with missing metrics', () => {
    const panels = [
      { id: 'acc', timeMs: 100 },
      { id: 'plain', timeMs: 200 },
    ];
    const result = computeWinners(panels);
    expect(result.get('acc').fast).toBe(true);
    expect(result.get('acc').cheap).toBe(false);
  });
});
