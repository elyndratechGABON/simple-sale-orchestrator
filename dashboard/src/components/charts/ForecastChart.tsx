import { ChartIcon } from "../../icons";
import type { ForecastMonth } from "../../api";

export function ForecastChart({ forecast, currentMrr }: { forecast: ForecastMonth[]; currentMrr: number }) {
  if (forecast.length === 0)
    return (
      <div className="chart-empty">
        <ChartIcon size={22} />
        Aucune donn\u00e9e pr\u00e9visionnelle.
      </div>
    );
  const W = 640;
  const H = 200;
  const PAD = 8;
  const max = Math.max(currentMrr * 1.1, ...forecast.map((f) => f.mrr_fcfa)) || 1;
  const step = forecast.length > 1 ? (W - PAD * 2) / (forecast.length - 1) : 0;
  const x = (i: number) => PAD + i * step;
  const y = (v: number) => H - PAD - 20 - (v / max) * (H - PAD * 2 - 30);
  const mrrLine = forecast.map((f, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(f.mrr_fcfa).toFixed(1)}`).join(" ");
  const mrrArea = `M${x(0)},${H - PAD} ${mrrLine.slice(1)} L${x(forecast.length - 1)},${H - PAD} Z`;
  const maxChurn = Math.max(...forecast.map((f) => f.churn_fcfa), 1);
  const yChurn = (v: number) => PAD + 10 + ((maxChurn - v) / maxChurn) * 30;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Forecast MRR">
      <defs>
        <linearGradient id="fcst-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {[0, 0.25, 0.5, 0.75, 1].map((pct) => {
        const val = Math.round(max * pct);
        return (
          <g key={pct}>
            <line x1={PAD} y1={y(val)} x2={W - PAD} y2={y(val)} stroke="var(--border)" strokeDasharray="2 4" />
            <text x={PAD - 2} y={y(val) + 3} fontSize="9" fill="var(--muted)" textAnchor="end">
              {(val / 1000).toFixed(0)}k
            </text>
          </g>
        );
      })}
      {forecast.map((f, i) => (
        <text key={f.month} x={x(i)} y={H} fontSize="9" fill="var(--muted)" textAnchor="middle">
          {f.month.slice(5)}
        </text>
      ))}
      <path d={mrrArea} fill="url(#fcst-fill)" />
      <path d={mrrLine} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinejoin="round" />
      {forecast.map((f, i) => (
        <circle key={i} cx={x(i)} cy={y(f.mrr_fcfa)} r="3" fill="var(--accent)" />
      ))}
      {forecast.some((f) => f.churn_fcfa > 0) && (
        <path
          d={forecast.map((f, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${yChurn(f.churn_fcfa).toFixed(1)}`).join(" ")}
          fill="none"
          stroke="var(--danger)"
          strokeWidth="1.5"
          strokeDasharray="4 3"
          opacity="0.6"
        />
      )}
      <rect x={W - 130} y={PAD} width="10" height="10" fill="var(--accent)" rx="2" />
      <text x={W - 115} y={PAD + 9} fontSize="9" fill="var(--text)">MRR projet\u00e9</text>
      {forecast.some((f) => f.churn_fcfa > 0) && (
        <>
          <line x1={W - 130} y1={PAD + 18} x2={W - 120} y2={PAD + 18} stroke="var(--danger)" strokeWidth="1.5" strokeDasharray="4 3" opacity="0.6" />
          <text x={W - 115} y={PAD + 21} fontSize="9" fill="var(--muted)">Churn</text>
        </>
      )}
    </svg>
  );
}
