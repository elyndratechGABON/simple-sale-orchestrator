import { ChartIcon } from "../../icons";
import type { RetentionMonth } from "../../api";

export function RetentionChart({ months }: { months: RetentionMonth[] }) {
  if (months.length === 0)
    return (
      <div className="chart-empty">
        <ChartIcon size={22} />
        Aucune donn\u00e9e de r\u00e9tention.
      </div>
    );
  const W = 640;
  const H = 180;
  const PAD = 8;
  const max = 100;
  const step = months.length > 1 ? (W - PAD * 2) / (months.length - 1) : 0;
  const x = (i: number) => PAD + i * step;
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2 - 16);
  const line = months.map((m, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(m.retention_pct).toFixed(1)}`).join(" ");
  const area = `M${x(0)},${H - PAD} ${line.slice(1)} L${x(months.length - 1)},${H - PAD} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Taux de r\u00e9tention">
      <defs>
        <linearGradient id="ret-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--ok)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--ok)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {[0, 25, 50, 75, 100].map((v) => (
        <g key={v}>
          <line x1={PAD} y1={y(v)} x2={W - PAD} y2={y(v)} stroke="var(--border)" strokeDasharray="2 4" />
          <text x={PAD - 2} y={y(v) + 3} fontSize="9" fill="var(--muted)" textAnchor="end">{v}%</text>
        </g>
      ))}
      {months.map((m, i) => (
        <text key={m.month} x={x(i)} y={H} fontSize="9" fill="var(--muted)" textAnchor="middle">
          {m.month.slice(5)}
        </text>
      ))}
      <path d={area} fill="url(#ret-fill)" />
      <path d={line} fill="none" stroke="var(--ok)" strokeWidth="2.5" strokeLinejoin="round" />
      {months.map((m, i) => (
        <circle key={i} cx={x(i)} cy={y(m.retention_pct)} r="3" fill="var(--ok)" />
      ))}
    </svg>
  );
}
