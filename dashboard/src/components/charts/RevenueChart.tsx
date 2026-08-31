import { ChartIcon } from "../../icons";
import { fmtDateShort } from "../../utils";

export function RevenueChart({ points }: { points: { day: number; revenue: number; profit: number }[] }) {
  if (points.length === 0)
    return (
      <div className="chart-empty">
        <ChartIcon size={22} />
        Aucune donn\u00e9e sur 7 jours \u2014 les caisses doivent synchroniser.
      </div>
    );
  const W = 640;
  const H = 200;
  const PAD = 8;
  const max = Math.max(1, ...points.map((p) => Math.max(p.revenue, p.profit)));
  const step = points.length > 1 ? (W - PAD * 2) / (points.length - 1) : 0;
  const x = (i: number) => PAD + i * step;
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
  const line = (key: "revenue" | "profit") =>
    points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  const area = `M${x(0)},${H - PAD} ${line("revenue").slice(1)} L${x(points.length - 1)},${H - PAD} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Chiffre d'affaires et b\u00e9n\u00e9fice des 7 derniers jours">
      <defs>
        <linearGradient id="rev-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {points.map((_, i) => (
        <g key={i}>
          <line x1={x(i)} y1={PAD} x2={x(i)} y2={H - PAD} stroke="var(--border)" strokeDasharray="2 4" />
          <text x={x(i)} y={H} fontSize="10" fill="var(--muted)" textAnchor="middle">
            {fmtDateShort(points[i].day)}
          </text>
        </g>
      ))}
      <path d={area} fill="url(#rev-fill)" />
      <path d={line("revenue")} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
      <path d={line("profit")} fill="none" stroke="var(--ok)" strokeWidth="1.75" strokeLinejoin="round" strokeDasharray="4 3" />
      {points.map((p, i) => (
        <g key={`dot-${i}`}>
          <circle cx={x(i)} cy={y(p.revenue)} r="2.6" fill="var(--accent)" />
          <circle cx={x(i)} cy={y(p.profit)} r="2.4" fill="var(--ok)" />
        </g>
      ))}
    </svg>
  );
}
