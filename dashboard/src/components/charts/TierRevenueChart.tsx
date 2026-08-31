import { ChartIcon } from "../../icons";
import { fmtFcfa } from "../../utils";
import type { TierRevenueMonth } from "../../api";

export function TierRevenueChart({ months }: { months: TierRevenueMonth[] }) {
  if (months.length === 0)
    return (
      <div className="chart-empty">
        <ChartIcon size={22} />
        Aucune donn\u00e9e de revenus \u2014 les paiements appara\u00eetront ici.
      </div>
    );
  const W = 640;
  const H = 200;
  const PAD = 8;
  const max = Math.max(1, ...months.map((m) => m.total));
  const barW = Math.max(20, (W - PAD * 2) / months.length - 8);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Revenus par palier">
      {months.map((m, i) => {
        const x = PAD + i * ((W - PAD * 2) / months.length) + 4;
        const h10k = (m.tier_10k / max) * (H - PAD * 2 - 16);
        const h25k = (m.tier_25k / max) * (H - PAD * 2 - 16);
        const h50k = (m.tier_50k / max) * (H - PAD * 2 - 16);
        const totalH = (m.total / max) * (H - PAD * 2 - 16);
        const base = H - PAD - 16;
        return (
          <g key={m.month}>
            <rect x={x} y={base - h50k - h25k - h10k} width={barW} height={h10k} fill="#3b82f6" rx={2} />
            <rect x={x} y={base - h50k - h25k} width={barW} height={h25k} fill="#10b981" rx={2} />
            <rect x={x} y={base - h50k} width={barW} height={h50k} fill="#f59e0b" rx={2} />
            {totalH > 0 && (
              <text x={x + barW / 2} y={base - totalH - 4} fontSize="9" fill="var(--text)" textAnchor="middle" className="mono">
                {fmtFcfa(m.total)}
              </text>
            )}
            <text x={x + barW / 2} y={H} fontSize="9" fill="var(--muted)" textAnchor="middle">
              {m.month.slice(5)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
