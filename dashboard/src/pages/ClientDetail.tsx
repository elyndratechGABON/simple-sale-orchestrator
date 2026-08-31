import { useEffect, useState } from "react";
import { fetchClient, sendAccountCommand, setAccountPassword, type ClientDetail } from "../api";
import { fmtFcfa, fmtDate, fmtDateTime, statusBadge, ONLINE_WINDOW_MS, daysLeftOf } from "../utils";
import { BanknoteIcon, LockIcon, StoreIcon, ChevronRightIcon } from "../icons";

type Props = {
  id: number;
  onBack: () => void;
};

export function ClientDetail({ id, onBack }: Props) {
  const [data, setData] = useState<ClientDetail | null>(null);
  const [error, setError] = useState("");
  const [pw, setPw] = useState("");
  const [msgText, setMsgText] = useState("");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetchClient(id);
        if (!alive) return;
        setData(res);
        setError("");
      } catch {
        if (alive) setError("Impossible de charger le client.");
      }
    };
    load();
    return () => { alive = false; };
  }, [id]);

  if (error) return <div className="alert-banner">{error}</div>;
  if (!data) return <div className="skeleton" style={{ height: 200 }} />;

  const client = data.client;
  const subscription = data.subscription;
  const now = Date.now();
  const initial = (client.name || client.owner_name || "?").trim().charAt(0).toUpperCase();

  return (
    <>
      <button className="btn btn-ghost" onClick={onBack} style={{ marginBottom: 12 }}>
        <ChevronRightIcon size={14} />
        Retour
      </button>

      <article className={`acc ${client.status !== "active" ? `acc-${client.status}` : ""}`}>
        <header className="acc-head">
          <span className="avatar" aria-hidden>{initial}</span>
          <div className="acc-id">
            <strong>{client.name || "Sans nom"}</strong>
            <div className="meta">
              {client.owner_name}
              {client.phone ? ` \u00b7 ${client.phone}` : ""}
            </div>
          </div>
          <div className="acc-tier">
            <StoreIcon size={14} />
            <span className="mono">{data.shops.length}/{subscription.max_devices}</span>
          </div>
          <div className="acc-status">
            {statusBadge(client.status)}
          </div>
        </header>

        <div className="acc-body">
          <div style={{ fontSize: 13, color: "var(--muted)" }}>
            <div>Palier : <strong>{fmtFcfa(subscription.plan_price)}/mois</strong> \u00b7 {subscription.max_devices} appareils</div>
            <div>Expire dans : <strong>{daysLeftOf(subscription.expiry_date, now)} j</strong> (le {fmtDate(subscription.expiry_date)})</div>
            <div>Cr\u00e9\u00e9 le {fmtDate(client.created_at)}</div>
          </div>

          {data.shops.length > 0 && (
            <ul className="devices">
              {data.shops.map((d) => (
                <li key={d.device_id}>
                  <span className={`dot ${d.last_sync_at && now - d.last_sync_at < ONLINE_WINDOW_MS ? "on" : "off"}`} />
                  <div className="device-main">
                    <strong>{d.store_name || "\u2014"}</strong>
                    <span className="mono meta">{d.device_id.length > 18 ? `${d.device_id.slice(0, 8)}\u2026${d.device_id.slice(-6)}` : d.device_id}</span>
                  </div>
                  <span className="meta" title={fmtDateTime(d.last_sync_at)}>
                    {d.last_sync_at ? `sync ${fmtDateTime(d.last_sync_at)}` : "jamais"}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="row-actions">
            {client.status === "active" ? (
              <button className="btn btn-sm btn-danger-ghost" onClick={() => sendAccountCommand(client.id, { action_type: "suspend" }).then(() => onBack())}>
                Suspendre
              </button>
            ) : (
              <button className="btn btn-sm btn-primary" onClick={() => sendAccountCommand(client.id, { action_type: "renew", days: 30 }).then(() => onBack())}>
                Relancer
              </button>
            )}
            <button className="btn btn-sm" onClick={() => { if (pw.trim()) setAccountPassword(client.id, pw.trim()).then(() => { setPw(""); onBack(); }); }}>
              <LockIcon size={13} />
              Mot de passe
            </button>
            <button className="btn btn-sm" onClick={() => { if (msgText.trim()) sendAccountCommand(client.id, { action_type: "broadcast_message", message: msgText.trim() }).then(() => { setMsgText(""); onBack(); }); }}>
              Message
            </button>
          </div>
        </div>
      </article>

      <div className="acc-detail" style={{ marginTop: 12 }}>
        <div className="history">
          <h3>Paiements ({data.payments.history?.length ?? 0})</h3>
          {data.payments.history?.length ? (
            data.payments.history.slice(0, 50).map((p: any) => (
              <div className="history-item" key={`${p.id}-${p.created_at}`}>
                <BanknoteIcon size={14} />
                <span className="mono">{fmtFcfa(p.amount)}</span>
                <span className="muted">+{p.days_added} j</span>
                <span className="muted">le {fmtDate(p.created_at)}</span>
              </div>
            ))
          ) : (
            <div className="muted">Aucun paiement enregistr\u00e9.</div>
          )}
        </div>
        <div className="history">
          <h3>Ordres r\u00e9cents</h3>
          {data.commands?.length ? (
            data.commands.map((c: any) => (
              <div className="history-item" key={c.id}>
                <span>{c.action_type === "suspend" ? "Suspension" : c.action_type === "renew" ? "Prolongation" : "Message"}</span>
                <span className="muted mono">le {fmtDate(c.created_at)}</span>
                {c.payload.days != null && <span className="muted">+{c.payload.days} j</span>}
                {c.payload.amount_fcfa != null && <span className="muted mono">{fmtFcfa(c.payload.amount_fcfa)}</span>}
                {c.payload.message_text && <span className="muted">\u00ab {c.payload.message_text} \u00bb</span>}
              </div>
            ))
          ) : (
            <div className="muted">Aucun ordre envoy\u00e9.</div>
          )}
        </div>
      </div>
    </>
  );
}
