import { InboxIcon } from "../../icons";
import type { RetentionMonth } from "../../api";

export function RetentionTable({ months }: { months: RetentionMonth[] }) {
  if (months.length === 0)
    return (
      <div className="chart-empty">
        <InboxIcon size={22} />
        Aucune donn\u00e9e.
      </div>
    );
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Mois</th>
            <th>Actifs</th>
            <th>Nouveaux</th>
            <th>Perdus</th>
            <th>R\u00e9tention</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m) => (
            <tr key={m.month}>
              <td className="mono">{m.month}</td>
              <td className="mono ok">{m.active}</td>
              <td className="mono">{m.new}</td>
              <td className="mono danger">{m.churned}</td>
              <td className="mono">
                <span className={`badge ${m.retention_pct >= 90 ? "active" : m.retention_pct >= 70 ? "suspended" : "expired"}`}>
                  {m.retention_pct}%
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
