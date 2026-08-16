import { downsample } from './arena.js';

const W = 640;
const H = 120;
const PAD_L = 44;
const PAD_R = 10;
const PAD_T = 10;
const PAD_B = 18;

/**
 * Tokens-vs-time timeline for one task, one line per panel
 * (adapted from isbetter.ai's battle timeline).
 * `labelFor(panelId)` overrides the default ACC/no-ACC label — blind mode
 * passes it so the aliases (Panel A / Panel B) are used instead.
 */
export default function Timeline({ panels, panelsResult, labelFor }) {
  const series = panels
    .map((p) => {
      const r = panelsResult[p.id];
      // Blind mode: color the line by position (alias), not by ACC identity —
      // the accent color must not tell you which panel runs the framework.
      const color = labelFor
        ? ['var(--color-accent, oklch(0.58 0.22 355))', 'var(--color-ink-dim, oklch(0.42 0.014 355))'][panels.indexOf(p) % 2]
        : p.acc
          ? 'var(--color-accent, oklch(0.58 0.22 355))'
          : 'var(--color-ink-dim, oklch(0.42 0.014 355))';
      return {
        id: p.id,
        label: labelFor ? labelFor(p.id) : p.acc ? 'ACC' : 'no-ACC',
        color,
        samples: (r && Array.isArray(r.samples) ? r.samples : []).filter((s) => s.tMs > 0),
      };
    })
    .filter((s) => s.samples.length > 1);

  if (series.length === 0) return null;

  const all = series.flatMap((s) => s.samples);
  const maxTime = Math.max(1, ...all.map((s) => s.tMs));
  const maxTokens = Math.max(1, ...all.map((s) => s.completionTokens)) * 1.1;

  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const x = (t) => PAD_L + (t / maxTime) * plotW;
  const y = (v) => PAD_T + plotH - (v / maxTokens) * plotH;

  const ticks = Array.from({ length: 5 }, (_, i) => (maxTime * i) / 4);
  const yTicks = Array.from({ length: 4 }, (_, i) => (maxTokens * i) / 3);
  const fmtT = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
  const fmtN = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`);

  return (
    <div className="mt-2 rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] px-4 py-3">
      <div className="mb-2 flex items-center gap-4 font-pixel text-[9px] uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
        <span>generation timeline</span>
        {series.map((s) => (
          <span key={s.id} className="text-[10px] normal-case tracking-normal" style={{ color: s.color }}>
            {s.label}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="timeline-svg" role="img" aria-label="Tokens generated over time for each panel">
        <g stroke="var(--color-line)" strokeWidth="1">
          {ticks.map((t, i) => (
            <line key={i} x1={x(t)} y1={PAD_T} x2={x(t)} y2={PAD_T + plotH} />
          ))}
          {yTicks.map((v, i) => (
            <line key={i} x1={PAD_L} y1={y(v)} x2={W - PAD_R} y2={y(v)} />
          ))}
        </g>
        <g fontSize="9" fill="var(--color-ink-faint)" fontFamily="var(--font-mono, monospace)">
          {ticks.map((t, i) => (
            <text key={i} x={x(t)} y={H - 5} textAnchor="middle">
              {fmtT(t)}
            </text>
          ))}
          {yTicks.map((v, i) => (
            <text key={i} x={PAD_L - 6} y={y(v) + 3} textAnchor="end">
              {fmtN(v)}
            </text>
          ))}
        </g>
        {series.map((s) => {
          const pts = downsample(s.samples, 60)
            .map((p) => `${x(p.tMs).toFixed(1)},${y(p.completionTokens).toFixed(1)}`)
            .join(' ');
          return (
            <polyline
              key={s.id}
              points={pts}
              fill="none"
              stroke={s.color}
              strokeWidth="1.6"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          );
        })}
      </svg>
    </div>
  );
}
