import { InboxIcon } from "../../icons";
import { fmtFcfa } from "../../utils";
import type { TierRevenueMonth } from "../../api";

export function TierBreakdown({ months }: { months: TierRevenueMonth[] }) {
  if (months.length === 0)
    return (
      <div className="chart-empty">
        <InboxIcon size={22} />
        Aucune donn\u00e9e.
      </div>
    );
  return (
    <div className="bars">
      {months.map((m) => {
        const max = Math.max(1, m.total);
        return (
          <div key={m.month} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>{m.month}</div>
            {[
              { label: "10 000 F", value: m.tier_10k, color: "#3b82f6" },
              { label: "25 000 F", value: m.tier_25k, color: "#10b981" },
              { label: "50 000 F", value: m.tier_50k, color: "#f59e0b" },
            ].map((t) => (
              <div className="bar-row" key={t.label} title={t.label}>
                <span className="bar-name" style={{ fontSize: 11 }}>{t.label}</span>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${(t.value / max) * 100}%`, background: t.color }} />
                </div>
                <span className="bar-value mono" style={{ fontSize: 11 }}>{fmtFcfa(t.value)}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
