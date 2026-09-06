import { useEffect, useState } from "react";
import { fetchShopsDetail, type ShopDetail } from "../api";
import { fmtDate, fmtDateTime, fmtFcfa, statusBadge } from "../utils";
import { InboxIcon } from "../icons";
import { DataTable } from "../components/ui/DataTable";

type Props = {
  onSelect: (deviceId: string) => void;
};

export function Boutiques({ onSelect }: Props) {
  const [shops, setShops] = useState<ShopDetail[]>([]);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetchShopsDetail();
        if (!alive) return;
        setShops(res.shops);
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

  return (
    <>
      {error && <div className="alert-banner">{error}</div>}

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
