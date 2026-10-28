import { useEffect, useState } from "react";
import {
  fetchSync,
  fetchMaintenance,
  setMaintenance,
  fetchAudit,
  type SyncStatus,
  type AuditAction,
} from "../api";
import { fmtDate, fmtDateTime } from "../utils";
import { InboxIcon, ShieldIcon, XIcon } from "../icons";
import { Modal } from "../components/ui/Modal";

/** SYSTÈME — la partie technique : la maintenance, l'état des syncs et le journal
 *  d'audit (qui a fait quoi). Tout ce qui n'est ni le parc, ni l'argent. */
export function Systeme({ isMaster = true }: { isMaster?: boolean } = {}) {
  const [status, setStatus] = useState<SyncStatus[]>([]);
  const [connected, setConnected] = useState(0);
  const [total, setTotal] = useState(0);
  const [pendingCommands, setPendingCommands] = useState(0);
  const [actions, setActions] = useState<AuditAction[]>([]);
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
        if (alive) setError("Impossible de charger l'état des synchronisations.");
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
    const loadAudit = async () => {
      if (!isMaster) return;
      try {
        const res = await fetchAudit({ limit: 100 });
        if (alive) setActions(res.actions);
      } catch {
        /* l'audit est réservé au master : sans session master, pas de journal. */
      }
    };
    load();
    loadMaintenance();
    loadAudit();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, [isMaster]);

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
      {error && (
        <div className="alert-banner">
          {error}
          <button className="btn btn-ghost btn-sm" onClick={() => setError("")} style={{ marginLeft: "auto" }}>
            <XIcon size={13} />
          </button>
        </div>
      )}
      {notice && (
        <div className="alert-banner ok">
          {notice}
          <button className="btn btn-ghost btn-sm" onClick={() => setNotice("")} style={{ marginLeft: "auto" }}>
            <XIcon size={13} />
          </button>
        </div>
      )}

      {maintenance.enabled && (
        <div className="alert-banner warn">
          <strong>Mode maintenance actif.</strong> Les caisses ne synchronisent plus leurs
          opérations (elles encassent normalement, hors ligne).{maintenance.message ? ` ${maintenance.message}` : ""}
        </div>
      )}

      {/* ── Maintenance ─────────────────────────────────────────────────────── */}
      <section className="panel" aria-label="Maintenance">
        <div className="panel-head">
          <div className="panel-title">
            <ShieldIcon size={15} />
            <span>Mode maintenance</span>
          </div>
          <span className="panel-legend">
            {maintenance.enabled ? "ACTIF — les caisses encassent mais ne synchronisent plus" : "Inactif — tout circule normalement"}
          </span>
        </div>
        <div className="acc-body">
          <p className="modal-note" style={{ marginTop: 0 }}>
            Quand il est activé, les caisses cessent de pousser et de tirer leurs opérations.
            Elles ENCAISSENT toujours (hors ligne d&apos;abord) ; leurs opérations restent en
            file et repartiront à la levée. Un message peut être affiché sur les caisses.
          </p>
          <div className="row-actions">
            <button
              className={maintenance.enabled ? "btn btn-primary" : "btn btn-danger"}
              onClick={() => {
                setMessage(maintenance.message);
                setMaintenanceOpen(true);
              }}
            >
              {maintenance.enabled ? "Lever le mode maintenance" : "Activer le mode maintenance"}
            </button>
          </div>
        </div>
      </section>

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

      {/* ── Synchronisation ──────────────────────────────────────────────────── */}
      <section className="panel" aria-label="État des synchronisations">
        <div className="panel-head">
          <div className="panel-title">
            <span className="legend-dot ok" /> Synchronisation des écrans
          </div>
          <span className="panel-legend">
            {connected} connecté{connected > 1 ? "s" : ""} sur {total} · {pendingCommands} ordre{pendingCommands > 1 ? "s" : ""} en attente
          </span>
        </div>
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
      </section>

      {/* ── Journal d'audit ──────────────────────────────────────────────────── */}
      <section className="panel" aria-label="Journal d'audit">
        <div className="panel-head">
          <div className="panel-title">
            <ShieldIcon size={15} />
            <span>Journal d&apos;audit ({actions.length})</span>
          </div>
          <span className="panel-legend">qui a fait quoi</span>
        </div>
        {!isMaster ? (
          <div className="empty">
            <ShieldIcon size={28} />
            <strong>Réservé à l&apos;administrateur principal</strong>
            Le journal des actions n&apos;est visible que depuis une session master.
          </div>
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
                      <span className="meta">{a.reason || "—"}</span>
                    </td>
                    <td className="mono" title={fmtDateTime(a.created_at)}>{fmtDate(a.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
