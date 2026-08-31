import { useEffect, useState } from "react";
import { fetchClients, type Client } from "../api";
import { fmtFcfa, fmtDate, daysLeftOf, statusBadge } from "../utils";
import { StoreIcon, InboxIcon } from "../icons";
import { SearchBar } from "../components/ui/SearchBar";
import { Countdown } from "../components/ui/Countdown";

type Props = {
  onSelect: (id: number) => void;
};

export function Clients({ onSelect }: Props) {
  const [clients, setClients] = useState<Client[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetchClients();
        if (!alive) return;
        setClients(res.clients);
        setReady(true);
        setError("");
      } catch {
        if (alive) setError("Impossible de charger les comptes.");
      }
    };
    load();
    const t = setInterval(load, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const now = Date.now();
  const filtered = clients.filter((a) =>
    [a.name, a.owner_name, a.phone ?? "", ...a.devices.map((d) => `${d.store_name} ${d.device_id}`)]
      .join(" ")
      .toLowerCase()
      .includes(filter.toLowerCase())
  );

  const activeCount = clients.filter((a) => a.status === "active").length;
  const graceCount = clients.filter((a) => a.status === "grace").length;
  const suspendedCount = clients.filter((a) => a.status === "suspended").length;
  const expiredCount = clients.filter((a) => a.status === "expired").length;
  const expiringSoon = clients.filter((a) => a.status === "active" && daysLeftOf(a.expiry_date, now) <= 7);
  const mrr = clients.filter((a) => a.status === "active" || a.status === "grace").reduce((n, a) => n + a.monthly_price_fcfa, 0);

  return (
    <>
      {error && <div className="alert-banner">{error}</div>}

      <div className="topbar-controls">
        <SearchBar value={filter} onChange={setFilter} placeholder="Rechercher un compte, un t\u00e9l\u00e9phone, une caisse\u2026" />
      </div>

      <div className="stats" aria-label="Clients">
        <div className="stat">
          <div className="k">Clients</div>
          <div className="v">{clients.length}</div>
        </div>
        <div className="stat">
          <div className="k">Actifs</div>
          <div className="v ok">{activeCount}</div>
        </div>
        <div className="stat">
          <div className="k">En gr\u00e2ce</div>
          <div className="v" style={{ color: "#c2410c" }}>{graceCount}</div>
        </div>
        <div className="stat">
          <div className="k">Suspendus</div>
          <div className="v warn">{suspendedCount}</div>
        </div>
        <div className="stat">
          <div className="k">Expir\u00e9s</div>
          <div className="v danger">{expiredCount}</div>
        </div>
        <div className="stat">
          <div className="k">Expirent \u2264 7 j</div>
          <div className="v">{expiringSoon.length}</div>
        </div>
        <div className="stat">
          <div className="k">MRR estim\u00e9</div>
          <div className="v accent">{fmtFcfa(mrr)}</div>
        </div>
      </div>

      {expiringSoon.length > 0 && (
        <div className="alert-banner warn">
          <span>
            {expiringSoon.length} abonnement{expiringSoon.length > 1 ? "s" : ""} expire{expiringSoon.length > 1 ? "nt" : ""} sous 7 jours :{" "}
            {expiringSoon.map((a) => `${a.name} (J-${daysLeftOf(a.expiry_date, now)})`).join(", ")}
          </span>
        </div>
      )}

      <div className="acc-list">
        {!ready &&
          Array.from({ length: 3 }).map((_, i) => (
            <div className="acc" key={i}>
              <div className="acc-body">
                <div className="skeleton" style={{ height: 38 }} />
                <div className="skeleton" style={{ height: 14, marginTop: 10 }} />
              </div>
            </div>
          ))}
        {ready &&
          filtered.map((a) => (
            <ClientCard key={a.id} client={a} now={now} onSelect={() => onSelect(a.id)} />
          ))}
        {ready && filtered.length === 0 && (
          <div className="empty">
            <InboxIcon size={28} />
            <strong>Aucun client</strong>
            Un client est cr\u00e9\u00e9 au premier lancement d'une caisse.
          </div>
        )}
      </div>
    </>
  );
}

function ClientCard({ client, now, onSelect }: { client: Client; now: number; onSelect: () => void }) {
  const initial = (client.name || client.owner_name || "?").trim().charAt(0).toUpperCase();
  const present = client.online;
  return (
    <article className={`acc ${client.status !== "active" ? `acc-${client.status}` : ""}`}>
      <header className="acc-head" onClick={onSelect} style={{ cursor: "pointer" }}>
        <span className="avatar" aria-hidden>{initial}</span>
        <div className="acc-id">
          <strong>{client.name || "Sans nom"}</strong>
          <div className="meta">
            {client.owner_name}
            {client.phone ? ` \u00b7 ${client.phone}` : ""}
          </div>
        </div>
        <div className="acc-tier" title="Appareils utilis\u00e9s / palier de l'abonnement">
          <StoreIcon size={14} />
          <span className="mono">{client.device_count}/{client.max_devices}</span>
        </div>
        <div className="acc-status">
          <span className={`presence ${present ? "on" : ""}`}>
            <span className={`dot ${present ? "on" : "off"}`} />
            {present ? "En ligne" : "Hors ligne"}
          </span>
          {statusBadge(client.status)}
        </div>
      </header>
      <div className="acc-body">
        <Countdown expiry={client.expiry_date} status={client.status} now={now} />
      </div>
    </article>
  );
}
