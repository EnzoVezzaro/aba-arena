import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

/**
 * Every provider the arena supports — the full Vercel AI SDK surface.
 * Keys are stored in localStorage and used only in the browser.
 *
 * Each provider can optionally expose a `models` list endpoint; when an API
 * key is configured, the UI fetches the live model list from the provider
 * (isbetter.ai pattern). The static `models` array is the offline fallback.
 */

// Models-list endpoints. OpenAI-compatible providers return { data: [{ id }] }.
// These are fetched through the ABA server (/api/models?provider=...) because
// some providers (NVIDIA) don't send CORS headers to localhost — the browser
// would silently block the direct fetch and the dropdown would fall back to
// the static list. `public` means the endpoint works without an API key.
const MODELS_API = {
  openai: { kind: 'openai', public: false },
  anthropic: { kind: 'anthropic', public: false },
  google: { kind: 'openai', public: false },
  openrouter: { kind: 'openai', public: true },
  groq: { kind: 'openai', public: false },
  deepseek: { kind: 'openai', public: false },
  mistral: { kind: 'openai', public: false },
  xai: { kind: 'openai', public: false },
  cerebras: { kind: 'openai', public: false },
  // The harness is model-driven: the model chooses its own tools and the
  // SDK executes them. NVIDIA's meta/llama-*instruct* models reject assistant
  // messages carrying 2+ tool calls ("only supports single tool-calls at
  // once"), so they can't run the agent loop — filter them out of the picker
  // and keep the nemotron family, which handles tool loops.
  nvidia: { kind: 'openai', public: true, toolFilter: (id) => !/^meta\/llama/.test(id) },
  ollama: { kind: 'openai', noKey: true, local: true },
  lmstudio: { kind: 'openai', noKey: true, local: true },
  // Optional local Freebuff proxy (aba/freebuff) — its /v1/models is the
  // "spawn endpoint" the provider's model list comes from. Only useful when
  // the proxy is running on :8080 (the UI gates the provider on that).
  freebuff: { kind: 'openai', noKey: true, public: true },
};

const EXCLUDE_MODEL =
  /embedding|embed|rerank|tts|audio|image|video|moderation|whisper|transcrib|realtime|dall|search/i;

function parseOpenAIModels(json) {
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
  return rows
    .map((m) => String(m?.id || m?.name || ''))
    .filter(Boolean)
    .filter((id) => !EXCLUDE_MODEL.test(id))
    .sort((a, b) => a.localeCompare(b));
}

function parseAnthropicModels(json) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows
    .map((m) => String(m?.id || ''))
    .filter(Boolean)
    .filter((id) => !EXCLUDE_MODEL.test(id))
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Fetch the live model list for a provider using the configured key.
 * Returns the array of model ids, or throws with a helpful message.
 * All fetches go through the ABA server (/api/models?provider=...) so CORS
 * restrictions (NVIDIA only allows build.nvidia.com) can't silently drop the
 * list. Local providers (Ollama/LM Studio) are fetched directly since they
 * run on the same machine and have no CORS.
 */
export async function fetchProviderModels(providerId, key) {
  const cfg = MODELS_API[providerId];
  if (!cfg) return [];
  if (cfg.local) {
    const url = `http://localhost:${providerId === 'ollama' ? 11434 : 1234}/v1/models`;
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const json = await res.json();
    return parseOpenAIModels(json);
  }
  const headers = {};
  if (!cfg.noKey && key) headers.Authorization = `Bearer ${key}`;
  if (providerId === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  }
  const res = await fetch(`/api/models?provider=${encodeURIComponent(providerId)}`, { headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  const ids = cfg.kind === 'anthropic' ? parseAnthropicModels(json) : parseOpenAIModels(json);
  return cfg.toolFilter ? ids.filter(cfg.toolFilter) : ids;
}

// Providers whose model list can be fetched without an API key (their
// /models endpoint is public) — used so the dropdown always shows the full
// live list even before a key is saved.
export const PUBLIC_MODELS_PROVIDERS = new Set(
  Object.entries(MODELS_API)
    .filter(([, cfg]) => cfg.public)
    .map(([id]) => id)
);

export const PROVIDERS = [
  {
    id: 'openai',
    label: 'OpenAI',
    needsKey: true,
    create: (key) => createOpenAI({ apiKey: key }),
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o3-mini'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    needsKey: true,
    create: (key) => createAnthropic({ apiKey: key }),
    models: [
      'claude-sonnet-4-20250514',
      'claude-3-7-sonnet-latest',
      'claude-3-5-sonnet-latest',
      'claude-3-5-haiku-latest',
    ],
  },
  {
    id: 'google',
    label: 'Google Gemini',
    needsKey: true,
    create: (key) => createGoogleGenerativeAI({ apiKey: key }),
    models: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    needsKey: true,
    create: (key) =>
      createOpenAICompatible({ name: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', apiKey: key }),
    models: [
      'anthropic/claude-3.5-sonnet',
      'openai/gpt-4o',
      'google/gemini-2.0-flash',
      'meta-llama/llama-3.3-70b-instruct',
      'deepseek/deepseek-chat',
    ],
  },
  {
    id: 'groq',
    label: 'Groq',
    needsKey: true,
    create: (key) =>
      createOpenAICompatible({ name: 'groq', baseURL: 'https://api.groq.com/openai/v1', apiKey: key }),
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'qwen-qwq-32b'],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    needsKey: true,
    create: (key) =>
      createOpenAICompatible({ name: 'deepseek', baseURL: 'https://api.deepseek.com', apiKey: key }),
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    needsKey: true,
    create: (key) =>
      createOpenAICompatible({ name: 'mistral', baseURL: 'https://api.mistral.ai/v1', apiKey: key }),
    models: ['open-mistral-nemo', 'mistral-large-latest'],
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    needsKey: true,
    create: (key) =>
      createOpenAICompatible({ name: 'xai', baseURL: 'https://api.x.ai/v1', apiKey: key }),
    models: ['grok-2', 'grok-beta'],
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    needsKey: true,
    create: (key) =>
      createOpenAICompatible({ name: 'cerebras', baseURL: 'https://api.cerebras.ai/v1', apiKey: key }),
    models: ['llama-3.3-70b', 'llama-3.1-8b'],
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    needsKey: true,
    create: (key) =>
      createOpenAICompatible({ name: 'nvidia', baseURL: 'https://integrate.api.nvidia.com/v1', apiKey: key }),
    // Only models that support the full multi-tool-call round trip belong
    // here — the harness is model-driven (the model chooses its own tools)
    // and NVIDIA's llama-3.1/3.3 *instruct* models reject assistant messages
    // with 2+ tool calls ("only supports single tool-calls at once"). The
    // nemotron family handles tool loops; this list is the offline fallback
    // when the live /v1/models endpoint is unreachable.
    models: [
      'nvidia/llama-3.3-nemotron-super-49b-v1',
      'nvidia/llama-3.3-nemotron-super-49b-v1.5',
    ],
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    needsKey: false,
    create: () =>
      createOpenAICompatible({ name: 'ollama', baseURL: 'http://localhost:11434/v1', apiKey: 'ollama' }),
    models: ['llama3.2', 'qwen2.5-coder', 'mistral'],
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    needsKey: false,
    create: () =>
      createOpenAICompatible({ name: 'lmstudio', baseURL: 'http://localhost:1234/v1', apiKey: 'lm-studio' }),
    models: ['local-model'],
  },
  {
    id: 'freebuff',
    label: 'Freebuff',
    needsKey: false,
    free: true, // every model through the Freebuff proxy is free
    // The auth tokens live in the local proxy process (aba/freebuff/start.cjs)
    // — the harness talks to http://localhost:8080/v1 with a dummy key. The
    // live model list comes from the proxy's /v1/models (the spawn endpoint);
    // this static list is the offline fallback when the proxy is down.
    create: () =>
      createOpenAICompatible({ name: 'freebuff', baseURL: 'http://localhost:8080/v1', apiKey: 'freebuff' }),
    models: [
      'minimax/minimax-m2.7',
      'z-ai/glm-5.1',
      'google/gemini-2.5-flash-lite',
      'google/gemini-3.1-flash-lite-preview',
    ],
  },
];

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
}

/**
 * True when a model is free of charge: the provider marks all its models
 * free (freebuff), or the model id carries a free marker (OpenRouter's
 * `:free` suffix, freebuff agent ids like `base2-free`). Used by the model
 * dropdown to render a FREE chip and to filter when the search says "free".
 */
export function isFreeModel(providerId, modelId) {
  const p = getProvider(providerId);
  if (p && p.free) return true;
  return /:\s*free$|\bfree\b/i.test(String(modelId || ''));
}

// Approximate $ per 1M tokens (input/output). Estimates — shown as "~".
const PRICING = {
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4.1': { in: 2, out: 8 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'o3-mini': { in: 1.1, out: 4.4 },
  'claude-sonnet-4-20250514': { in: 3, out: 15 },
  'claude-3-7-sonnet-latest': { in: 3, out: 15 },
  'claude-3-5-sonnet-latest': { in: 3, out: 15 },
  'claude-3-5-haiku-latest': { in: 0.8, out: 4 },
  'gemini-2.0-flash': { in: 0.1, out: 0.4 },
  'gemini-2.0-flash-lite': { in: 0.075, out: 0.3 },
  'gemini-1.5-pro': { in: 1.25, out: 5 },
  'gemini-1.5-flash': { in: 0.075, out: 0.3 },
  'deepseek-chat': { in: 0.27, out: 1.1 },
  'deepseek-reasoner': { in: 0.55, out: 2.19 },
  'llama-3.3-70b-versatile': { in: 0.59, out: 0.79 },
  'llama-3.1-8b-instant': { in: 0.05, out: 0.08 },
};

export function estimateCost(model, inputTokens, outputTokens) {
  const p = PRICING[model] || { in: 1, out: 3 };
  return (inputTokens / 1e6) * p.in + (outputTokens / 1e6) * p.out;
}

const KEY_STORE = 'aba.providerKeys.v1';

export function loadKeys() {
  try {
    return JSON.parse(localStorage.getItem(KEY_STORE) || '{}');
  } catch {
    return {};
  }
}

export function saveKey(providerId, key) {
  const keys = loadKeys();
  if (key) keys[providerId] = key;
  else delete keys[providerId];
  localStorage.setItem(KEY_STORE, JSON.stringify(keys));
}
