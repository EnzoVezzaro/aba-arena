import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getProvider,
  isFreeModel,
  estimateCost,
  loadKeys,
  saveKey,
  PROVIDERS,
  PUBLIC_MODELS_PROVIDERS,
  modelIdList,
  modelTools,
} from '../providers.js';

describe('PROVIDERS', () => {
  it('has 13 providers', () => {
    expect(PROVIDERS).toHaveLength(13);
  });

  it('each provider has required fields', () => {
    PROVIDERS.forEach((p) => {
      expect(p.id).toBeDefined();
      expect(p.label).toBeDefined();
      expect(typeof p.needsKey).toBe('boolean');
      expect(typeof p.create).toBe('function');
      expect(Array.isArray(p.models)).toBe(true);
    });
  });

  it('includes openai', () => {
    const openai = PROVIDERS.find((p) => p.id === 'openai');
    expect(openai).toBeDefined();
    expect(openai.label).toBe('OpenAI');
    expect(openai.needsKey).toBe(true);
  });

  it('includes anthropic', () => {
    const anthropic = PROVIDERS.find((p) => p.id === 'anthropic');
    expect(anthropic).toBeDefined();
    expect(anthropic.label).toBe('Anthropic');
  });

  it('includes freebuff with free flag', () => {
    const freebuff = PROVIDERS.find((p) => p.id === 'freebuff');
    expect(freebuff).toBeDefined();
    expect(freebuff.free).toBe(true);
    expect(freebuff.needsKey).toBe(false);
  });

  it('includes ollama as local', () => {
    const ollama = PROVIDERS.find((p) => p.id === 'ollama');
    expect(ollama).toBeDefined();
    expect(ollama.needsKey).toBe(false);
  });
});

describe('PUBLIC_MODELS_PROVIDERS', () => {
  it('is a Set', () => {
    expect(PUBLIC_MODELS_PROVIDERS).toBeInstanceOf(Set);
  });

  it('includes openrouter', () => {
    expect(PUBLIC_MODELS_PROVIDERS.has('openrouter')).toBe(true);
  });

  it('includes nvidia', () => {
    expect(PUBLIC_MODELS_PROVIDERS.has('nvidia')).toBe(true);
  });

  it('includes freebuff', () => {
    expect(PUBLIC_MODELS_PROVIDERS.has('freebuff')).toBe(true);
  });

  it('does not include openai', () => {
    expect(PUBLIC_MODELS_PROVIDERS.has('openai')).toBe(false);
  });
});

describe('getProvider', () => {
  it('returns provider by id', () => {
    const openai = getProvider('openai');
    expect(openai.id).toBe('openai');
  });

  it('returns first provider for unknown id', () => {
    const unknown = getProvider('unknown');
    expect(unknown.id).toBe('openai');
  });

  it('returns anthropic provider', () => {
    const anthropic = getProvider('anthropic');
    expect(anthropic.id).toBe('anthropic');
  });
});

describe('isFreeModel', () => {
  it('returns true for freebuff provider', () => {
    expect(isFreeModel('freebuff', 'any-model')).toBe(true);
  });

  it('returns true for model with :free suffix', () => {
    expect(isFreeModel('openrouter', 'model:free')).toBe(true);
  });

  it('returns true for model with free in name', () => {
    expect(isFreeModel('openrouter', 'base2-free')).toBe(true);
  });

  it('returns false for regular model', () => {
    expect(isFreeModel('openai', 'gpt-4o')).toBe(false);
  });

  it('returns false for null model', () => {
    expect(isFreeModel('openai', null)).toBe(false);
  });
});

describe('estimateCost', () => {
  it('calculates cost for known model', () => {
    const cost = estimateCost('gpt-4o', 1000000, 1000000);
    expect(cost).toBe(12.5);
  });

  it('uses default pricing for unknown model', () => {
    const cost = estimateCost('unknown-model', 1000000, 1000000);
    expect(cost).toBe(4);
  });

  it('returns 0 for zero tokens', () => {
    const cost = estimateCost('gpt-4o', 0, 0);
    expect(cost).toBe(0);
  });

  it('handles small token counts', () => {
    const cost = estimateCost('gpt-4o', 100, 100);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeLessThan(0.01);
  });
});

describe('loadKeys', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns empty object when no keys stored', () => {
    expect(loadKeys()).toEqual({});
  });

  it('returns stored keys', () => {
    localStorage.setItem('aba.providerKeys.v1', JSON.stringify({ openai: 'test-key' }));
    expect(loadKeys()).toEqual({ openai: 'test-key' });
  });

  it('handles invalid JSON gracefully', () => {
    localStorage.setItem('aba.providerKeys.v1', 'invalid-json');
    expect(loadKeys()).toEqual({});
  });
});

describe('modelIdList', () => {
  it('flattens live { id, tools } rows to ids', () => {
    const live = [{ id: 'gpt-4o', tools: true }, { id: 'gpt-4o-mini', tools: null }];
    expect(modelIdList('openai', live)).toEqual(['gpt-4o', 'gpt-4o-mini']);
  });

  it('falls back to the static list when no live list', () => {
    expect(modelIdList('openai', null)).toEqual(getProvider('openai').models);
    expect(modelIdList('openai', [])).toEqual(getProvider('openai').models);
  });

  it('handles string-array live lists (old shape)', () => {
    expect(modelIdList('openai', ['gpt-4o'])).toEqual(['gpt-4o']);
  });
});

describe('modelTools', () => {
  it('assumes capable by default for SDK-backed models', () => {
    expect(modelTools('openai', null, 'gpt-4o')).toBe(true);
  });

  it('uses the live flag from the provider endpoint (OpenRouter)', () => {
    const live = [
      { id: 'deepseek/deepseek-r1', tools: false },
      { id: 'openai/gpt-4o', tools: true },
    ];
    expect(modelTools('openrouter', live, 'deepseek/deepseek-r1')).toBe(false);
    expect(modelTools('openrouter', live, 'openai/gpt-4o')).toBe(true);
  });

  it('ignores live null flags and falls back to capable', () => {
    const live = [{ id: 'gpt-4o', tools: null }];
    expect(modelTools('openai', live, 'gpt-4o')).toBe(true);
  });

  it('respects a provider-level toolCalling override', () => {
    const p = getProvider('nvidia');
    const original = p.toolCalling;
    p.toolCalling = () => false;
    expect(modelTools('nvidia', null, 'anything')).toBe(false);
    p.toolCalling = original;
  });

  it('returns true for a model not in the live list', () => {
    expect(modelTools('openai', [{ id: 'gpt-4o', tools: false }], 'gpt-4o-mini')).toBe(true);
  });
});

describe('saveKey', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('saves a key', () => {
    saveKey('openai', 'test-key');
    expect(loadKeys()).toEqual({ openai: 'test-key' });
  });

  it('deletes key when value is empty', () => {
    localStorage.setItem('aba.providerKeys.v1', JSON.stringify({ openai: 'old-key' }));
    saveKey('openai', '');
    expect(loadKeys()).toEqual({});
  });

  it('deletes key when value is null', () => {
    localStorage.setItem('aba.providerKeys.v1', JSON.stringify({ openai: 'old-key' }));
    saveKey('openai', null);
    expect(loadKeys()).toEqual({});
  });

  it('preserves other keys', () => {
    saveKey('openai', 'key1');
    saveKey('anthropic', 'key2');
    expect(loadKeys()).toEqual({ openai: 'key1', anthropic: 'key2' });
  });
});
