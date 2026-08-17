import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { calcPrice } from '@pydantic/genai-prices';

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

// Live model rows are { id, tools } — `tools` is the provider's own flag for
// tool-calling support (true | false), or null when the provider's /models
// endpoint doesn't say (assume capable). OpenRouter exposes it as
// `supported_parameters.tools` — the dynamic source that keeps the act-task
// gate honest without hardcoding model names that go stale.
function parseOpenAIModels(json) {
  const rows = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
  return rows
    .map((m) => {
      const sp = m?.supported_parameters;
      // OpenRouter's supported_parameters is an ARRAY of supported parameter
      // names — a model that doesn't list 'tools' can't call tools (image,
      // content-safety and some reasoning models). Older format: object with
      // `tools: false`. Either way, absence ⇒ no tool calling; anything else
      // stays null (unknown → assume capable).
      const noTools = Array.isArray(sp) ? !sp.includes('tools') : sp?.tools === false;
      return { id: String(m?.id || m?.name || ''), tools: noTools ? false : null };
    })
    .filter((m) => m.id && !EXCLUDE_MODEL.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function parseAnthropicModels(json) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  return rows
    .map((m) => ({ id: String(m?.id || ''), tools: null }))
    .filter((m) => m.id && !EXCLUDE_MODEL.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
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
  const rows = cfg.kind === 'anthropic' ? parseAnthropicModels(json) : parseOpenAIModels(json);
  return cfg.toolFilter ? rows.filter((m) => cfg.toolFilter(m.id)) : rows;
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
    local: true, // runs on your machine — local inference costs nothing
    create: () =>
      createOpenAICompatible({ name: 'ollama', baseURL: 'http://localhost:11434/v1', apiKey: 'ollama' }),
    models: ['llama3.2', 'qwen2.5-coder', 'mistral'],
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    needsKey: false,
    local: true, // runs on your machine — local inference costs nothing
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
 * Flat model-id list for a provider — live rows ({ id, tools }) or the
 * static fallback strings. Keeps every dropdown a plain array of ids.
 */
export function modelIdList(providerId, live) {
  const src = live && live.length ? live : getProvider(providerId).models;
  return (src || []).map((m) => (typeof m === 'string' ? m : m.id));
}

/**
 * True when a model can run 'act' tasks — the harness passes it file-edit
 * tools (write_file, delete_file, bash), so it needs tool-calling support.
 * Resolution order (dynamic first, manual only as fallback):
 *   1. live capability from the provider's /models endpoint
 *      (OpenRouter supported_parameters.tools — stays current over time)
 *   2. provider-level override (`toolCalling` on the provider config)
 *   3. assume capable (all SDK-backed models in the lists support tools)
 */
export function modelTools(providerId, live, modelId) {
  const src = live && live.length ? live : null;
  if (src) {
    const found = src.find((m) => (typeof m === 'string' ? m === modelId : m.id === modelId));
    if (found && typeof found === 'object' && found.tools != null) return found.tools;
  }
  const p = getProvider(providerId);
  if (p.toolCalling === false) return false;
  if (typeof p.toolCalling === 'function') return p.toolCalling(modelId);
  return true;
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

// Curated official prices — $ per 1M tokens (input/output), from the
// provider's own published pricing. These are the "provider's data directly"
// and win over the catalog below.
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

// genai-prices catalog lookup — the broad fallback for models without curated
// rates (OpenRouter's long tail, NVIDIA NIM models, new releases…). Bundles
// pydantic/genai-prices data (MIT) with intelligent id matching.
function catalogPrice(model, inputTokens, outputTokens, providerId) {
  try {
    const usage = { input_tokens: inputTokens, output_tokens: outputTokens };
    // Try the explicit provider first (best match). OpenRouter-style ids
    // ("author/model") only match under the openrouter provider, so retry
    // that when the id carries a slash, then a bare match as last resort.
    const attempts = [providerId];
    if (/\//.test(String(model || ''))) attempts.push('openrouter');
    for (const pid of attempts) {
      if (!pid) continue;
      const r = calcPrice(usage, model, { providerId: pid });
      if (r && typeof r.total_price === 'number') return r.total_price;
    }
    const r = calcPrice(usage, model, {});
    if (r && typeof r.total_price === 'number') return r.total_price;
  } catch {
    // Catalog errors must never break pricing — fall through to the default.
  }
  return null;
}

/**
 * Estimated cost of one run in USD.
 *
 * Priority: free providers/models ($0) → the provider's own published rates
 * (curated) → the genai-prices catalog → a generic $1/$3 per 1M fallback.
 */
export function estimateCost(model, inputTokens, outputTokens, providerId) {
  const p = providerId ? getProvider(providerId) : null;
  // Free proxies (freebuff) and local models (ollama/lmstudio) cost nothing;
  // OpenRouter `:free` models are free too.
  if (p && (p.free || p.local)) return 0;
  if (/:\s*free$|\bfree\b/i.test(String(model || ''))) return 0;
  const curated = PRICING[model];
  if (curated) return (inputTokens / 1e6) * curated.in + (outputTokens / 1e6) * curated.out;
  const catalog = catalogPrice(model, inputTokens, outputTokens, providerId);
  if (catalog != null) return catalog;
  return (inputTokens / 1e6) * 1 + (outputTokens / 1e6) * 3;
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
