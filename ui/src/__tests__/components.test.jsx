import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  makePanel,
  INITIAL_PANELS,
  loadHistory,
  saveHistory,
  shuffle,
  dotColor,
  HISTORY_KEY,
  PENDING_BATTLE_KEY,
  MAX_HISTORY,
} from '../components.jsx';

describe('makePanel', () => {
  it('creates panel with correct properties', () => {
    const panel = makePanel('test', true, 'Test Panel');
    expect(panel.id).toBe('test');
    expect(panel.acc).toBe(true);
    expect(panel.label).toBe('Test Panel');
    expect(panel.provider).toBe('openai');
    expect(panel.model).toBe('gpt-4o');
    expect(panel.apiKey).toBe('');
  });

  it('creates non-ACC panel', () => {
    const panel = makePanel('plain', false, 'Plain Panel');
    expect(panel.acc).toBe(false);
  });
});

describe('INITIAL_PANELS', () => {
  it('has two panels', () => {
    expect(INITIAL_PANELS).toHaveLength(2);
  });

  it('first panel is ACC', () => {
    expect(INITIAL_PANELS[0].acc).toBe(true);
    expect(INITIAL_PANELS[0].id).toBe('acc');
  });

  it('second panel is plain', () => {
    expect(INITIAL_PANELS[1].acc).toBe(false);
    expect(INITIAL_PANELS[1].id).toBe('plain');
  });
});

describe('loadHistory', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns empty array when no history', () => {
    expect(loadHistory()).toEqual([]);
  });

  it('returns stored history', () => {
    const history = [{ id: '1', ts: 123 }];
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    expect(loadHistory()).toEqual(history);
  });

  it('handles invalid JSON gracefully', () => {
    localStorage.setItem(HISTORY_KEY, 'invalid-json');
    expect(loadHistory()).toEqual([]);
  });
});

describe('saveHistory', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('saves history to localStorage', () => {
    const history = [{ id: '1', ts: 123 }];
    saveHistory(history);
    expect(loadHistory()).toEqual(history);
  });

  it('truncates to MAX_HISTORY', () => {
    const history = Array.from({ length: MAX_HISTORY + 10 }, (_, i) => ({
      id: String(i),
      ts: i,
    }));
    saveHistory(history);
    const saved = loadHistory();
    expect(saved.length).toBe(MAX_HISTORY);
  });

  it('keeps first entries when truncating', () => {
    const history = Array.from({ length: MAX_HISTORY + 5 }, (_, i) => ({
      id: String(i),
      ts: i,
    }));
    saveHistory(history);
    const saved = loadHistory();
    expect(saved[0].id).toBe('0');
  });
});

describe('shuffle', () => {
  it('returns array with same elements', () => {
    const items = [1, 2, 3, 4, 5];
    const shuffled = shuffle(items);
    expect(shuffled.sort()).toEqual(items.sort());
  });

  it('does not mutate original array', () => {
    const items = [1, 2, 3, 4, 5];
    const original = [...items];
    shuffle(items);
    expect(items).toEqual(original);
  });

  it('returns empty array for empty input', () => {
    expect(shuffle([])).toEqual([]);
  });

  it('returns single element array', () => {
    expect(shuffle([1])).toEqual([1]);
  });

  it('returns new array instance', () => {
    const items = [1, 2, 3];
    const shuffled = shuffle(items);
    expect(shuffled).not.toBe(items);
  });
});

describe('dotColor', () => {
  it('returns pulse class for running states', () => {
    expect(dotColor('loading')).toContain('animate-pulse');
    expect(dotColor('running')).toContain('animate-pulse');
    expect(dotColor('streaming')).toContain('animate-pulse');
  });

  it('returns red for error', () => {
    expect(dotColor('error')).toContain('red-500');
  });

  it('returns green for done/pending', () => {
    expect(dotColor('done')).toContain('emerald-400');
    expect(dotColor('pending')).toContain('emerald-400');
  });
});
