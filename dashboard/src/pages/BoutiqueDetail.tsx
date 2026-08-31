import { useEffect, useState } from "react";
import { fetchShopDetail, deleteShop, type ShopFull } from "../api";
import { fmtFcfa, fmtDate, fmtDateTime, statusBadge } from "../utils";
import { StoreIcon, BanknoteIcon, ChevronRightIcon } from "../icons";

type Props = {
  deviceId: string;
  onBack: () => void;
};

export function BoutiqueDetail({ deviceId, onBack }: Props) {
  const [data, setData] = useState<ShopFull | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    fetchShopDetail(deviceId)
      .then((r) => { if (alive) setData(r); })
      .catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [deviceId]);

  if (error) return <div className="alert-banner">{error}</div>;
  if (!data) return <div className="skeleton" style={{ height: 200 }} />;

  const s = data.shop as any;
  return (
    <>
      <button className="btn btn-ghost" onClick={onBack} style={{ marginBottom: 12 }}>
        <ChevronRightIcon size={14} />
        Retour
      </button>

      <article className={`acc ${s.status !== "active" ? `acc-${s.status}` : ""}`}>
        <header className="acc-head">
          <span className="avatar" aria-hidden>{(s.store_name || "?").charAt(0).toUpperCase()}</span>
          <div className="acc-id">
            <strong>{s.store_name || "Sans nom"}</strong>
            <div className="meta">
              {s.owner_name}
              {s.phone ? ` \u00b7 ${s.phone}` : ""}
            </div>
          </div>
          <div className="acc-tier">
            <StoreIcon size={14} />
            <span className="mono">{s.app_version_used ?? "\u2014"}</span>
          </div>
          <div className="acc-status">{statusBadge(s.status)}</div>
        </header>

        <div className="acc-body">
          <div style={{ fontSize: 13, color: "var(--muted)" }}>
            <div>Device : <span className="mono">{s.device_id}</span></div>
            <div>Enregistr\u00e9 le {fmtDate(s.registration_date)}</div>
            <div>\u00c9ch\u00e9ance : {fmtDate(s.expiry_date)}</div>
            {s.last_sync_at && <div>Derni\u00e8re sync : {fmtDateTime(s.last_sync_at)}</div>}
          </div>
        </div>
      </article>

      {data.stats && (
        <div className="panels" style={{ marginTop: 12 }}>
          <section className="panel">
            <div className="panel-head">
              <div className="panel-title">
                <BanknoteIcon size={15} />
                <span>Statistiques</span>
              </div>
            </div>
            <div className="stats" aria-label="Stats boutique">
              <div className="stat">
                <div className="k">Revenus</div>
                <div className="v accent">{fmtFcfa(data.stats.totals?.revenue)}</div>
              </div>
              <div className="stat">
                <div className="k">Ventes</div>
                <div className="v">{data.stats.totals?.sales ?? 0}</div>
              </div>
              <div className="stat">
                <div className="k">B\u00e9n\u00e9fice</div>
                <div className="v ok">{fmtFcfa(data.stats.totals?.profit)}</div>
              </div>
            </div>
          </section>
        </div>
      )}

      {data.payments && data.payments.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="history">
            <h3>Paiements ({data.payments.length})</h3>
            {data.payments.map((p: any) => (
              <div className="history-item" key={`${p.id}-${p.created_at}`}>
                <BanknoteIcon size={14} />
                <span className="mono">{fmtFcfa(p.amount)}</span>
                <span className="muted">+{p.days_added} j</span>
                <span className="muted">le {fmtDate(p.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="row-actions" style={{ marginTop: 16 }}>
        <button
          className="btn btn-sm btn-danger-ghost"
          onClick={() => { if (confirm("Supprimer d\u00e9finitivement cette boutique ?")) deleteShop(deviceId).then(() => onBack()); }}
        >
          Supprimer
        </button>
      </div>
    </>
  );
}
