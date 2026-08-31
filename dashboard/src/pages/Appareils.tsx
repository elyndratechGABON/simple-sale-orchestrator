import { useEffect, useState } from "react";
import { fetchDevices, type Device, type DevicesSummary } from "../api";
import { fmtDateTime, fmtDate } from "../utils";
import { InboxIcon } from "../icons";
import { DataTable } from "../components/ui/DataTable";

export function Appareils() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [summary, setSummary] = useState<DevicesSummary | null>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetchDevices();
        if (!alive) return;
        setDevices(res.devices);
        setSummary(res.summary);
        setReady(true);
        setError("");
      } catch {
        if (alive) setError("Impossible de charger les appareils.");
      }
    };
    load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const versions = summary?.versions ?? {};

  return (
    <>
      {error && <div className="alert-banner">{error}</div>}

      <div className="stats" aria-label="Appareils">
        <div className="stat">
          <div className="k">Total</div>
          <div className="v">{summary?.total ?? devices.length}</div>
        </div>
        <div className="stat">
          <div className="k">En ligne</div>
          <div className="v ok">{summary?.online ?? 0}</div>
        </div>
        <div className="stat">
          <div className="k">Hors ligne</div>
          <div className="v">{summary?.offline ?? 0}</div>
        </div>
        <div className="stat">
          <div className="k">En attente de sync</div>
          <div className="v warn">{summary?.sync_pending ?? 0}</div>
        </div>
        {Object.entries(versions).map(([v, n]) => (
          <div className="stat" key={v}>
            <div className="k">v{v}</div>
            <div className="v">{n}</div>
          </div>
        ))}
      </div>

      {!ready ? (
        <div className="table-wrap">
          <table><tbody>
            {Array.from({ length: 3 }).map((_, i) => (
              <tr key={i} className="skeleton-row"><td colSpan={5}><div className="skeleton" style={{ height: 20 }} /></td></tr>
            ))}
          </tbody></table>
        </div>
      ) : devices.length === 0 ? (
        <div className="empty">
          <InboxIcon size={28} />
          <strong>Aucun appareil</strong>
        </div>
      ) : (
        <DataTable
          columns={[
            {
              key: "store_name",
              label: "Boutique",
              render: (d: Device) => (
                <div className="cell-store">
                  <strong>{d.store_name || "\u2014"}</strong>
                  <div className="meta">{d.owner_name}</div>
                </div>
              ),
            },
            {
              key: "device_id",
              label: "Appareil",
              className: "cell-device",
              render: (d: Device) => <span className="mono">{d.device_id}</span>,
            },
            {
              key: "status",
              label: "Statut",
              render: (d: Device) => (
                <span className={`presence ${d.status === "online" ? "on" : ""}`}>
                  <span className={`dot ${d.status === "online" ? "on" : "off"}`} />
                  {d.status === "online" ? "En ligne" : d.suspended_at ? "Suspendu" : "Hors ligne"}
                </span>
              ),
            },
            {
              key: "app_version_used",
              label: "Version",
              render: (d: Device) => <span className="mono">{d.app_version_used ?? "\u2014"}</span>,
            },
            {
              key: "sync_pending",
              label: "Ordres en attente",
              render: (d: Device) => <span className="mono">{d.sync_pending}</span>,
            },
            {
              key: "expiry_date",
              label: "Expiration",
              render: (d: Device) => <span className="mono">{fmtDate(d.expiry_date)}</span>,
            },
            {
              key: "last_sync_at",
              label: "Derni\u00e8re sync",
              render: (d: Device) => <span className="mono">{fmtDateTime(d.last_sync_at)}</span>,
            },
          ]}
          data={devices}
          keyFn={(d) => d.device_id}
          emptyMessage="Aucun appareil."
        />
      )}
    </>
  );
}
