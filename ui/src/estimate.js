/**
 * Token / cost estimation fallback.
 *
 * The correct path is provider-reported usage: the harness accumulates the
 * AI SDK's per-step `usage` and streams it back, so battles with providers
 * that report usage show exact numbers. Some providers — notably the free
 * NVIDIA models — never report usage, so those battles fall back to
 * estimates computed from the exact text that was actually sent and
 * received:
 *
 *   input tokens  ≈ system prompt + task prompt + repo context (the real
 *                   prompt bytes, so the estimate tracks the real request)
 *   output tokens ≈ the agent's actual answer text
 *
 * chars/4 is the standard approximation (≈4 characters per token for prose;
 * code and JSON skew a little higher — acceptable for a fallback). These
 * estimates are labeled "(est.)" in the UI and never replace provider
 * numbers when those exist.
 */

/** Rough token count for a text: ~4 characters per token. */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.round(String(text).length / 4));
}

/**
 * Estimate usage for one agent run from the real request/response text.
 * Returns { inputTokens, outputTokens }.
 */
export function estimateUsage({ system = '', prompt = '', context = '', output = '' }) {
  return {
    inputTokens: estimateTokens(`${system}\n\n${prompt}\n\n${context}`),
    outputTokens: estimateTokens(output),
  };
}
