/**
 * Arena helpers adapted from midudev/isbetter.ai (MIT/FSL-1.1-MIT) — see the
 * Credits section in aba/README.md. Formatting, code extraction, and the
 * per-metric winner logic that makes side-by-side battles readable.
 */

export const fmtInt = (n) => (n == null || Number.isNaN(n) ? '—' : n.toLocaleString('en-US'));

export const fmtDur = (ms) =>
  ms == null || Number.isNaN(ms) ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;

export const fmtCost = (v) => {
  if (v == null || Number.isNaN(v)) return '—';
  if (!v) return '$0';
  if (v >= 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toPrecision(2)}`;
};

export const fmtRate = (n) => (n >= 1 ? `${Math.round(n)}` : n.toFixed(1));

/** Rough token estimate from text length (used live, before usage arrives). */
export const estTokens = (s) => (s ? Math.max(1, Math.round(s.length / 4)) : 0);

/** Extract the first fenced code block (or bare HTML doc) from a model answer. */
export function extractCode(text) {
  const blocks = [...text.matchAll(/```[\w+-]*[^\S\r\n]*\r?\n?([\s\S]*?)(?:```|$)/g)].map(
    (block) => block[1].trim(),
  );
  let code = blocks.find((b) => /<!doctype html|<html[\s>]/i.test(b));
  if (!code && blocks.length) code = blocks[0];
  if (!code) {
    const start = text.search(/<!doctype html|<html[\s>]/i);
    if (start >= 0) code = text.slice(start).trim();
  }
  return code || '';
}

/** The prose answer with fenced code blocks removed. */
export function extractAnswer(text) {
  let answer = text
    .replace(/```[\w+-]*[^\S\r\n]*\r?\n?[\s\S]*?(?:```|$)/g, '')
    .trim();
  const htmlStart = answer.search(/<!doctype html|<html[\s>]/i);
  if (htmlStart >= 0) answer = answer.slice(0, htmlStart).trim();
  if (answer) return answer;
  return extractCode(text) ? '' : text.trim();
}

export function hasIncompleteCodeFence(text) {
  return (text.match(/```/g)?.length || 0) % 2 === 1;
}

/**
 * Downsample a metric series to at most maxPoints (adapted from
 * isbetter.ai's metrics.ts). Keeps the first and last points.
 */
export function downsample(samples, maxPoints = 60) {
  if (samples.length <= maxPoints || maxPoints < 2) return samples.slice(0, Math.max(1, maxPoints));
  const result = [samples[0]];
  const step = (samples.length - 1) / (maxPoints - 1);
  for (let i = 1; i < maxPoints - 1; i++) result.push(samples[Math.round(i * step)]);
  result.push(samples[samples.length - 1]);
  return result;
}

/**
 * Compute per-metric winners across the completed panels of one task.
 * Returns a map: panelId → { fast, ttft, gen, cheap, tput }.
 *
 * A panel wins a metric only when its value is STRICTLY better than every
 * other panel's — ties award nobody. Panels without a value for a metric
 * never win it.
 */
export function computeWinners(donePanels) {
  const best = new Map();
  if (donePanels.length < 2) return best;

  const durationOf = (r) => r.timeMs ?? r.durationMs;
  const known = (fn) =>
    donePanels
      .map((r) => ({ r, v: fn(r) }))
      .filter((x) => x.v != null && Number.isFinite(x.v));
  // Winner: the unique panel holding the extreme value. If two panels share
  // the extreme value (a tie), nobody wins that metric.
  const uniqueBest = (fn, lowerIsBetter) => {
    const rows = known(fn);
    if (rows.length < 2) return null;
    const bestVal = lowerIsBetter
      ? Math.min(...rows.map((x) => x.v))
      : Math.max(...rows.map((x) => x.v));
    const ties = rows.filter((x) => x.v === bestVal);
    if (ties.length !== 1) return null;
    return ties[0].r;
  };

  const fast = uniqueBest(durationOf, true);
  const ttft = uniqueBest((r) => r.ttftMs, true);
  const gen = uniqueBest((r) => r.genMs, true);
  const cheap = uniqueBest((r) => r.cost, true);
  const rate = (r) =>
    r.genMs || r.durationMs ? (r.outputTokens || 0) / ((r.genMs || r.durationMs) / 1000) : 0;
  const tput = uniqueBest((r) => (r.outputTokens ? rate(r) : null), false);

  for (const v of donePanels) {
    best.set(v.id, {
      fast: v === fast,
      ttft: v === ttft,
      gen: v === gen,
      cheap: v === cheap,
      tput: v === tput,
    });
  }
  return best;
}
