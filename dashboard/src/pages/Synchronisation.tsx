import { useEffect, useState } from "react";
import { fetchSync, type SyncStatus } from "../api";
import { fmtDateTime } from "../utils";
import { InboxIcon } from "../icons";

export function Synchronisation() {
  const [status, setStatus] = useState<SyncStatus[]>([]);
  const [connected, setConnected] = useState(0);
  const [total, setTotal] = useState(0);
  const [pendingCommands, setPendingCommands] = useState(0);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetchSync();
        if (!alive) return;
        setStatus(res.status);
        setConnected(res.connected);
        setTotal(res.total);
        setPendingCommands(res.pending_commands);
        setReady(true);
        setError("");
      } catch {
        if (alive) setError("Impossible de charger les donn\u00e9es.");
      }
    };
    load();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  return (
    <>
      {error && <div className="alert-banner">{error}</div>}

      <div className="stats" aria-label="Synchronisation">
        <div className="stat">
          <div className="k">Connect\u00e9s</div>
          <div className="v ok">{connected}</div>
        </div>
        <div className="stat">
          <div className="k">Total</div>
          <div className="v">{total}</div>
        </div>
        <div className="stat">
          <div className="k">Hors ligne</div>
          <div className="v">{total - connected}</div>
        </div>
        <div className="stat">
          <div className="k">Ordres en attente</div>
          <div className="v warn">{pendingCommands}</div>
        </div>
      </div>

      {!ready ? (
        <div className="skeleton" style={{ height: 200 }} />
      ) : status.length === 0 ? (
        <div className="empty">
          <InboxIcon size={28} />
          <strong>Aucune donn\u00e9e</strong>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Boutique</th>
                <th>Statut</th>
                <th>Syncs</th>
                <th>En attente</th>
                <th>Erreurs</th>
                <th>Derni\u00e8re sync</th>
              </tr>
            </thead>
            <tbody>
              {status.map((s) => (
                <tr key={s.device_id}>
                  <td className="cell-store">
                    <strong>{s.store_name || "\u2014"}</strong>
                    <div className="meta">{s.device_id}</div>
                  </td>
                  <td>
                    <span className={`presence ${s.status === "online" ? "on" : ""}`}>
                      <span className={`dot ${s.status === "online" ? "on" : "off"}`} />
                      {s.status === "online" ? "En ligne" : s.status === "never" ? "Jamais connect\u00e9" : "Hors ligne"}
                    </span>
                  </td>
                  <td className="mono">{s.operations_count}</td>
                  <td className="mono">{s.pending}</td>
                  <td className="mono">{s.errors}</td>
                  <td className="mono">{fmtDateTime(s.last_sync_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
