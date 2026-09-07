import { useEffect, useState } from "react";
import {
  fetchShopsDetail,
  fetchDeleteRequests,
  approveDeleteRequest,
  rejectDeleteRequest,
  type ShopDetail,
  type DeleteRequest,
} from "../api";
import { fmtDate, fmtDateTime, fmtFcfa, statusBadge } from "../utils";
import { InboxIcon } from "../icons";
import { DataTable } from "../components/ui/DataTable";

type Props = {
  onSelect: (deviceId: string) => void;
};

export function Boutiques({ onSelect }: Props) {
  const [shops, setShops] = useState<ShopDetail[]>([]);
  const [deletions, setDeletions] = useState<DeleteRequest[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [shopRes, reqRes] = await Promise.all([
          fetchShopsDetail(),
          fetchDeleteRequests({ status: "pending" }),
        ]);
        if (!alive) return;
        setShops(shopRes.shops);
        setDeletions(reqRes.requests);
        setReady(true);
        setError("");
      } catch {
        if (alive) setError("Impossible de charger les boutiques.");
      }
    };
    load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const handleApprove = async (req: DeleteRequest) => {
    setBusy(true);
    try {
      await approveDeleteRequest(req.id);
      setNotice(`Suppression de « ${req.store_name} » approuv\u00e9e — la caisse est lib\u00e9r\u00e9e.`);
      const [shopRes, reqRes] = await Promise.all([fetchShopsDetail(), fetchDeleteRequests({ status: "pending" })]);
      setShops(shopRes.shops);
      setDeletions(reqRes.requests);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur.");
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async (req: DeleteRequest) => {
    setBusy(true);
    try {
      await rejectDeleteRequest(req.id);
      setNotice(`Demande de suppression de « ${req.store_name} » refus\u00e9e.`);
      const res = await fetchDeleteRequests({ status: "pending" });
      setDeletions(res.requests);
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
          <button className="btn btn-ghost btn-sm" onClick={() => setError("")} style={{ marginLeft: "auto" }}>✕</button>
        </div>
      )}
      {notice && (
        <div className="alert-banner ok">
          {notice}
          <button className="btn btn-ghost btn-sm" onClick={() => setNotice("")} style={{ marginLeft: "auto" }}>✕</button>
        </div>
      )}

      {deletions.length > 0 && (
        <section className="acc-list" aria-label="Demandes de suppression">
          {deletions.map((r) => (
            <article className="acc" key={r.id}>
              <header className="acc-head">
                <span className="avatar" aria-hidden>
                  {(r.store_name || "?").trim().charAt(0).toUpperCase()}
                </span>
                <div className="acc-id">
                  <strong>{r.store_name || "Boutique"}</strong>
                  <div className="meta">
                    {r.owner_name}
                    {r.reason ? ` \u00b7 « ${r.reason} »` : ""}
                  </div>
                </div>
                <div className="acc-status">
                  <span className="badge pending">Suppression demand\u00e9e</span>
                </div>
              </header>
              <div className="acc-body">
                <div className="history">
                  <h3>L'employ\u00e9 veut partir \u2014 {fmtDateTime(r.created_at)}</h3>
                  <div className="history-item">
                    <span className="mono">{r.device_id}</span>
                    <span className="muted">Appareil concern\u00e9</span>
                  </div>
                </div>
                <div className="row-actions">
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => handleApprove(r)}
                    disabled={busy}
                  >
                    Supprimer
                  </button>
                  <button
                    className="btn btn-sm btn-danger-ghost"
                    onClick={() => handleReject(r)}
                    disabled={busy}
                  >
                    Refuser
                  </button>
                </div>
              </div>
            </article>
          ))}
        </section>
      )}

      {!ready ? (
        <div className="table-wrap">
          <table>
            <tbody>
              {Array.from({ length: 3 }).map((_, i) => (
                <tr key={i} className="skeleton-row">
                  <td colSpan={6}><div className="skeleton" style={{ height: 20 }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : shops.length === 0 ? (
        <div className="empty">
          <InboxIcon size={28} />
          <strong>Aucune boutique</strong>
          Les caisses apparaissent ici apr\u00e8s leur premier lancement.
        </div>
      ) : (
        <DataTable
          columns={[
            {
              key: "store_name",
              label: "Boutique",
              render: (s: ShopDetail) => (
                <div className="cell-store">
                  <strong>{s.store_name || "\u2014"}</strong>
                  <div className="meta">{s.owner_name}</div>
                </div>
              ),
            },
            {
              key: "account_name",
              label: "Compte",
              render: (s: ShopDetail) => <span>{s.account_name ?? "\u2014"}</span>,
            },
            {
              key: "account_tier",
              label: "Abonnement",
              render: (s: ShopDetail) =>
                s.account_max_devices != null ? (
                  <span className="mono">
                    {s.account_device_count}/{s.account_max_devices} \u00e9crans
                    {s.plan_name ? (
                      <span className="muted"> \u00b7 {s.plan_name}</span>
                    ) : s.plan_price_fcfa != null ? (
                      <span className="muted"> \u00b7 {fmtFcfa(s.plan_price_fcfa)}</span>
                    ) : null}
                  </span>
                ) : (
                  "\u2014"
                ),
            },
            {
              key: "device_id",
              label: "Appareil",
              className: "cell-device",
              render: (s: ShopDetail) => <span className="mono">{s.device_id}</span>,
            },
            { key: "status", label: "Statut", render: (s: ShopDetail) => statusBadge(s.status) },
            {
              key: "expiry_date",
              label: "\u00c9ch\u00e9ance",
              render: (s: ShopDetail) => <span className="mono">{fmtDate(s.expiry_date)}</span>,
            },
            {
              key: "last_sync_at",
              label: "Derni\u00e8re sync",
              render: (s: ShopDetail) => <span className="mono">{fmtDateTime(s.last_sync_at)}</span>,
            },
            {
              key: "actions",
              label: "",
              render: (s: ShopDetail) => (
                <button className="btn btn-sm" onClick={() => onSelect(s.device_id)}>
                  D\u00e9tails
                </button>
              ),
            },
          ]}
          data={shops}
          keyFn={(s) => s.device_id}
          emptyMessage="Aucune boutique."
        />
      )}
    </>
  );
}
