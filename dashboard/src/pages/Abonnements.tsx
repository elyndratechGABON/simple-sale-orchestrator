import { useEffect, useState } from "react";
import { fetchRequests, approveRequest, rejectRequest, type SubscriptionRequest } from "../api";
import { fmtFcfa, fmtDateTime, statusBadge } from "../utils";
import { BanknoteIcon, StoreIcon, InboxIcon, XIcon } from "../icons";

export function Abonnements() {
  const [requests, setRequests] = useState<SubscriptionRequest[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const res = await fetchRequests({ status: "pending" });
      setRequests(res.requests);
      setReady(true);
      setError("");
    } catch {
      setError("Impossible de charger les demandes.");
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  const pending = requests.filter((r) => r.status === "pending");

  const handleApprove = async (req: SubscriptionRequest) => {
    setBusy(true);
    try {
      await approveRequest(req.id);
      setNotice(`Abonnement de « ${req.store_name || req.account_name} » validé.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur.");
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async (req: SubscriptionRequest) => {
    setBusy(true);
    try {
      await rejectRequest(req.id);
      setNotice(`Demande de « ${req.store_name || req.account_name} » refusée.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error && (
        <div className="alert-banner">
          {error}
          <button className="btn btn-ghost btn-sm" onClick={() => setError("")} style={{ marginLeft: "auto" }}><XIcon size={13} /></button>
        </div>
      )}
      {notice && (
        <div className="alert-banner ok">
          {notice}
          <button className="btn btn-ghost btn-sm" onClick={() => setNotice("")} style={{ marginLeft: "auto" }}><XIcon size={13} /></button>
        </div>
      )}

      <div className="stats" aria-label="Abonnements">
        <div className="stat">
          <div className="k">En attente</div>
          <div className="v warn">{pending.length}</div>
        </div>
      </div>

      <div className="acc-list">
        {!ready &&
          Array.from({ length: 2 }).map((_, i) => (
            <div className="acc" key={i}>
              <div className="acc-body">
                <div className="skeleton" style={{ height: 38 }} />
                <div className="skeleton" style={{ height: 14, marginTop: 10 }} />
              </div>
            </div>
          ))}
        {ready &&
          pending.map((r) => (
            <article className={`acc ${r.status === "rejected" ? "acc-suspended" : ""}`} key={r.id}>
              <header className="acc-head">
                <span className="avatar" aria-hidden>
                  {(r.store_name || r.account_name || "?").trim().charAt(0).toUpperCase()}
                </span>
                <div className="acc-id">
                  <strong>{r.store_name || "Boutique"}</strong>
                  <div className="meta">
                    {r.owner_name}
                    {r.account_phone ? ` · ${r.account_phone}` : ""}
                  </div>
                </div>
                <div className="acc-tier" title="Montant encaissé et palier demandé">
                  <BanknoteIcon size={14} />
                  <span className="mono">{fmtFcfa(r.plan_price)}</span>
                  {r.plan_devices > 0 && (
                    <span className="badge delivered" title="Palier demandé">{r.plan_devices} appareils</span>
                  )}
                  {r.plan_name && <span className="muted">{r.plan_name}</span>}
                </div>
                <div className="acc-status">
                  {r.status === "pending" ? (
                    <span className="badge pending">En attente</span>
                  ) : r.status === "approved" ? (
                    <span className="badge delivered">Validée</span>
                  ) : (
                    <span className="badge superseded">Refusée</span>
                  )}
                </div>
              </header>

              <div className="acc-body">
                <div className="history">
                  <h3>Dépôt du marchand — {fmtDateTime(r.created_at)}</h3>
                  <div className="history-item">
                    <StoreIcon size={14} />
                    <span>
                      Compte : <strong>{r.account_name ?? `#${r.account_id}`}</strong>{" "}
                      {statusBadge(r.account_status)}
                    </span>
                  </div>
                  {r.reference && (
                    <div className="history-item">
                      <BanknoteIcon size={14} />
                      <span>Référence mobile money :</span>
                      <span className="mono">{r.reference}</span>
                    </div>
                  )}
                </div>

                {r.status === "pending" ? (
                  <div className="row-actions">
                    <button className="btn btn-sm btn-primary" onClick={() => handleApprove(r)} disabled={busy}>
                      <BanknoteIcon size={13} />
                      Valider — prolonger le compte
                    </button>
                    <button className="btn btn-sm btn-danger-ghost" onClick={() => handleReject(r)} disabled={busy}>
                      <XIcon size={13} />
                      Refuser
                    </button>
                  </div>
                ) : (
                  <div className="row-actions muted">
                    {r.status === "approved" ? "Prolongation appliquée au compte" : "Aucune action"}
                    {r.decided_at != null && <>· décision le {fmtDateTime(r.decided_at)}</>}
                  </div>
                )}
              </div>
            </article>
          ))}
        {ready && pending.length === 0 && (
          <div className="empty">
            <InboxIcon size={28} />
            <strong>Aucune demande en attente</strong>
            Les caisses déposent leurs demandes après un paiement mobile money.
          </div>
        )}
      </div>
    </>
  );
}
