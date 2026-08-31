import { fmtDate, daysLeftOf } from "../../utils";

export function Countdown({ expiry, status, now }: { expiry: number; status: string; now: number }) {
  const span = Math.max(expiry - now, 86_400_000 * 30);
  const pct = Math.max(0, Math.min(100, ((expiry - now) / span) * 100));
  const d = daysLeftOf(expiry, now);
  const cls = status === "expired" ? "expired" : status === "suspended" ? "suspended" : d <= 7 ? "expiring" : d <= 30 ? "warning" : "ok";
  const label = status === "expired" ? "Expir\u00e9" : status === "suspended" ? "Suspendu" : d <= 0 ? "Aujourd'hui" : `J-${d}`;
  return (
    <div className="countdown" title={`\u00c9ch\u00e9ance : ${fmtDate(expiry)}`}>
      <span className={`countdown-label ${cls}`}>{label}</span>
      <div className="countdown-bar">
        <div className={`countdown-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="countdown-date mono">{fmtDate(expiry)}</span>
    </div>
  );
}
