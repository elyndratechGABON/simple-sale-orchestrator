import { useEffect, useState } from "react";
import { fetchAudit, type AuditAction } from "../api";
import { fmtDate, fmtDateTime } from "../utils";
import { ShieldIcon, InboxIcon } from "../icons";

export function Audit() {
  const [actions, setActions] = useState<AuditAction[]>([]);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetchAudit({ limit: 100 });
        if (!alive) return;
        setActions(res.actions);
        setReady(true);
        setError("");
      } catch {
        if (alive) setError("Impossible de charger l'audit.");
      }
    };
    load();
    return () => { alive = false; };
  }, []);

  return (
    <>
      {error && <div className="alert-banner">{error}</div>}

      {!ready ? (
        <div className="skeleton" style={{ height: 200 }} />
      ) : actions.length === 0 ? (
        <div className="empty">
          <ShieldIcon size={28} />
          <strong>Aucune action</strong>
          Les actions administratives apparaissent ici.
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Administrateur</th>
                <th>Cible</th>
                <th>Action</th>
                <th>Raison</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {actions.map((a) => (
                <tr key={a.id}>
                  <td className="cell-store">
                    <strong>{a.admin_id}</strong>
                  </td>
                  <td>
                    <span className="mono">{a.target_type}:{a.target_id}</span>
                  </td>
                  <td>
                    <span className="badge">{a.action}</span>
                  </td>
                  <td>
                    <span className="meta">{a.reason || "\u2014"}</span>
                  </td>
                  <td className="mono" title={fmtDateTime(a.created_at)}>{fmtDate(a.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
