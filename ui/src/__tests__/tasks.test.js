import { describe, it, expect } from 'vitest';
import { DEFAULT_TASKS, checkSuccess } from '../tasks.js';

describe('DEFAULT_TASKS', () => {
  it('has 4 tasks', () => {
    expect(DEFAULT_TASKS).toHaveLength(4);
  });

  it('each task has required fields', () => {
    DEFAULT_TASKS.forEach((task) => {
      expect(task.title).toBeDefined();
      expect(task.prompt).toBeDefined();
      expect(task.hints).toBeDefined();
      expect(task.minChars).toBeDefined();
      expect(task.mode).toBeDefined();
    });
  });

  it('has plan and act modes', () => {
    const modes = DEFAULT_TASKS.map((t) => t.mode);
    expect(modes).toContain('plan');
    expect(modes).toContain('act');
  });

  it('first task is repository comprehension', () => {
    expect(DEFAULT_TASKS[0].title).toBe('Repository comprehension');
    expect(DEFAULT_TASKS[0].mode).toBe('plan');
  });

  it('second task is write a unit test', () => {
    expect(DEFAULT_TASKS[1].title).toBe('Write a unit test');
    expect(DEFAULT_TASKS[1].mode).toBe('act');
  });

  it('third task is find and fix a bug', () => {
    expect(DEFAULT_TASKS[2].title).toBe('Find and fix a bug');
    expect(DEFAULT_TASKS[2].mode).toBe('act');
  });

  it('fourth task is add a feature plan', () => {
    expect(DEFAULT_TASKS[3].title).toBe('Add a feature (plan)');
    expect(DEFAULT_TASKS[3].mode).toBe('plan');
  });

  it('all hints are RegExp instances', () => {
    DEFAULT_TASKS.forEach((task) => {
      task.hints.forEach((hint) => {
        expect(hint).toBeInstanceOf(RegExp);
      });
    });
  });
});

describe('checkSuccess', () => {
  const task = {
    minChars: 10,
    hints: [/test|assert|expect/i, /```/],
  };

  it('returns false for empty output', () => {
    expect(checkSuccess('', task)).toBe(false);
  });

  it('returns false for null output', () => {
    expect(checkSuccess(null, task)).toBe(false);
  });

  it('returns false for output too short', () => {
    expect(checkSuccess('short', task)).toBe(false);
  });

  it('returns true when output meets minChars and matches hint', () => {
    expect(checkSuccess('This is a test with assert statements', task)).toBe(true);
  });

  it('returns false when output meets minChars but no hint matches', () => {
    const longText = 'This is a long text that does not contain any matching hints whatsoever at all here';
    expect(checkSuccess(longText, task)).toBe(false);
  });

  it('matches code fence hint', () => {
    const text = 'Here is the code:\n```js\nconst x = 1;\n```';
    expect(checkSuccess(text, task)).toBe(true);
  });

  it('handles string hints (localStorage round-trip)', () => {
    const stringHintTask = {
      minChars: 10,
      hints: ['test|assert|expect'],
    };
    expect(checkSuccess('This is a test with assert statements', stringHintTask)).toBe(true);
  });

  it('handles invalid regex string hints gracefully', () => {
    const invalidHintTask = {
      minChars: 10,
      hints: ['[invalid'],
    };
    expect(checkSuccess('[invalid is in this long text', invalidHintTask)).toBe(true);
  });

  it('returns true when no hints provided', () => {
    const noHintsTask = { minChars: 10 };
    expect(checkSuccess('This is a long enough text', noHintsTask)).toBe(true);
  });

  it('uses default minChars of 100', () => {
    const defaultTask = { hints: [/test/i] };
    expect(checkSuccess('short', defaultTask)).toBe(false);
    expect(checkSuccess('This is a text with more than one hundred characters that also contains the word test inside it right here', defaultTask)).toBe(true);
  });
});
