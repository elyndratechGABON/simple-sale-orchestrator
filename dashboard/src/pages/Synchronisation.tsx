import { useEffect, useState } from "react";
import { fetchSync, fetchMaintenance, setMaintenance, type SyncStatus } from "../api";
import { fmtDateTime } from "../utils";
import { InboxIcon } from "../icons";
import { Modal } from "../components/ui/Modal";

export function Synchronisation() {
  const [status, setStatus] = useState<SyncStatus[]>([]);
  const [connected, setConnected] = useState(0);
  const [total, setTotal] = useState(0);
  const [pendingCommands, setPendingCommands] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  // Le mode maintenance : les caisses cessent de synchroniser, elles encassent
  // toujours (hors ligne d'abord).
  const [maintenance, setMaintenanceState] = useState({ enabled: false, message: "" });
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [message, setMessage] = useState("");

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
        if (alive) setError("Impossible de charger les données.");
      }
    };
    const loadMaintenance = async () => {
      try {
        const res = await fetchMaintenance();
        if (alive) setMaintenanceState(res.maintenance);
      } catch {
        /* le mode maintenance n'est visible que par l'administrateur : sans session
           master, on ignore l'absence de réponse. */
      }
    };
    load();
    loadMaintenance();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const applyMaintenance = async (enabled: boolean, texte: string) => {
    try {
      const res = await setMaintenance({ enabled, message: texte });
      setMaintenanceState(res.maintenance);
      setNotice(
        enabled
          ? "Mode maintenance activé — les caisses cessent de synchroniser (elles encassent toujours)."
          : "Mode maintenance levé — la synchronisation reprend.",
      );
      setMaintenanceOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur.");
    }
  };

  return (
    <>
      {error && <div className="alert-banner">{error}</div>}
      {notice && (
        <div className="alert-banner ok">
          {notice}
          <button className="btn btn-ghost btn-sm" onClick={() => setNotice("")} style={{ marginLeft: "auto" }}>✕</button>
        </div>
      )}

      {maintenance.enabled && (
        <div className="alert-banner warn">
          <strong>Mode maintenance actif.</strong> Les caisses ne synchronisent plus leurs
          opérations (elles encassent normalement, hors ligne).{maintenance.message ? ` ${maintenance.message}` : ""}
        </div>
      )}

      <div className="stats" aria-label="Synchronisation">
        <div className="stat">
          <div className="k">Connectés</div>
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

      <div className="row-actions" style={{ marginBottom: 14 }}>
        <button
          className={maintenance.enabled ? "btn btn-primary" : "btn"}
          onClick={() => {
            setMessage(maintenance.message);
            setMaintenanceOpen(true);
          }}
        >
          {maintenance.enabled ? "Lever le mode maintenance" : "Activer le mode maintenance"}
        </button>
      </div>

      <Modal
        open={maintenanceOpen}
        onClose={() => setMaintenanceOpen(false)}
        title={maintenance.enabled ? "Lever le mode maintenance" : "Activer le mode maintenance"}
        danger={!maintenance.enabled}
      >
        <p className="modal-note">
          {maintenance.enabled
            ? "Les caisses reprendront la synchronisation à leur prochain passage (toutes les minutes)."
            : "Les caisses cesseront de pousser et de tirer leurs opérations. Elles ENCAISSENT toujours (hors ligne d'abord) ; leurs opérations restent en file et repartiront à la levée."}
        </p>
        <label htmlFor="maintenance-message">Message affiché sur les caisses (facultatif)</label>
        <textarea
          id="maintenance-message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Ex. : mise à jour du catalogue, interruption prévue de 14h à 15h."
          rows={3}
        />
        <div className="row-actions" style={{ marginTop: 12 }}>
          <button
            className={maintenance.enabled ? "btn btn-primary" : "btn btn-danger"}
            onClick={() => void applyMaintenance(!maintenance.enabled, message)}
          >
            {maintenance.enabled ? "Lever" : "Activer"}
          </button>
          <button className="btn btn-ghost" onClick={() => setMaintenanceOpen(false)}>
            Annuler
          </button>
        </div>
      </Modal>

      {!ready ? (
        <div className="skeleton" style={{ height: 200 }} />
      ) : status.length === 0 ? (
        <div className="empty">
          <InboxIcon size={28} />
          <strong>Aucune donnée</strong>
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
                <th>Dernière synchronisation</th>
              </tr>
            </thead>
            <tbody>
              {status.map((s) => (
                <tr key={s.device_id}>
                  <td className="cell-store">
                    <strong>{s.store_name || "—"}</strong>
                    <div className="meta">{s.device_id}</div>
                  </td>
                  <td>
                    <span className={`presence ${s.status === "online" ? "on" : ""}`}>
                      <span className={`dot ${s.status === "online" ? "on" : "off"}`} />
                      {s.status === "online" ? "En ligne" : s.status === "never" ? "Jamais connecté" : "Hors ligne"}
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
