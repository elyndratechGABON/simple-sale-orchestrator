import { useEffect, useState } from "react";
import { fetchStorefront, fetchRevenueTimeseries, fetchRevenueSummary, type Storefront, type RevenueTimeseries, type RevenueSummary, type StorefrontShop } from "../api";
import { fmtDate, fmtFcfa, statusBadge } from "../utils";
import { TrendingUpIcon, ChartIcon } from "../icons";

function OnlineDot({ online }: { online: boolean }) {
  return (
    <span title={online ? "En ligne" : "Hors ligne"}>
      <span
        style={{
          display: "inline-block",
          width: 8,
          height: 8,
          borderRadius: 8,
          marginRight: 6,
          background: online ? "#16a34a" : "#9ca3af",
        }}
      />
      {online ? "En ligne" : "Hors ligne"}
    </span>
  );
}

export function Dashboard() {
  const [sf, setSf] = useState<Storefront | null>(null);
  const [timeseries, setTimeseries] = useState<RevenueTimeseries | null>(null);
  const [revSummary, setRevSummary] = useState<RevenueSummary | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [storefront, ts, rs] = await Promise.all([
          fetchStorefront().catch(() => null),
          fetchRevenueTimeseries("30d").catch(() => null),
          fetchRevenueSummary().catch(() => null),
        ]);
        if (!alive) return;
        setSf(storefront);
        setTimeseries(ts);
        setRevSummary(rs);
        setError("");
      } catch {
        if (alive) setError("Impossible de charger les données.");
      }
    };
    load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const kpi = sf?.kpi;
  const elyndra = sf?.elyndra;
  const shops = sf?.shops ?? [];

  const maxSeries = Math.max(...(timeseries?.by_day ?? []).map((d) => d.revenue), 1);
  const maxAccounts = Math.max(...(timeseries?.by_account ?? []).map((a) => a.total), 1);

  return (
    <>
      {error && <div className="alert-banner">{error}</div>}

      <div className="stats" aria-label="Mes boutiques">
        <div className="stat">
          <div className="k">Boutiques</div>
          <div className="v accent">{kpi?.boutique_total ?? 0}</div>
        </div>
        <div className="stat">
          <div className="k">Actives</div>
          <div className="v ok">{kpi?.boutique_active ?? 0}</div>
        </div>
        <div className="stat">
          <div className="k">En ligne</div>
          <div className="v">{kpi?.en_ligne ?? 0}</div>
        </div>
        <div className="stat">
          <div className="k">Hors ligne</div>
          <div className="v warn">{kpi?.hors_ligne ?? 0}</div>
        </div>
        <div className="stat">
          <div className="k">En gr\u00e2ce</div>
          <div className="v" style={{ color: "#c2410c" }}>{kpi?.en_grace ?? 0}</div>
        </div>
        <div className="stat">
          <div className="k">Suspendues</div>
          <div className="v">{kpi?.suspendues ?? 0}</div>
        </div>
        <div className="stat">
          <div className="k">Expir\u00e9es</div>
          <div className="v danger">{kpi?.expirees ?? 0}</div>
        </div>
        <div className="stat">
          <div className="k">Employ\u00e9s</div>
          <div className="v">{kpi?.employees ?? 0}</div>
        </div>
      </div>

      <div className="stats" aria-label="Ma rentr\u00e9e Elyndra">
        <div className="stat">
          <div className="k">Encaiss\u00e9 ce mois</div>
          <div className="v accent">{fmtFcfa(elyndra?.mois_encaisse)}</div>
        </div>
        <div className="stat">
          <div className="k">MRR (abonnements)</div>
          <div className="v">{fmtFcfa(elyndra?.mrr_fcfa)}</div>
        </div>
        <div className="stat">
          <div className="k">ARR</div>
          <div className="v">{fmtFcfa(elyndra?.arr_fcfa)}</div>
        </div>
        <div className="stat">
          <div className="k">CA boutiques ce mois</div>
          <div className="v ok">{fmtFcfa(elyndra?.ca_boutiques_mois)}</div>
        </div>
      </div>

      <section className="panel" aria-label="Chaque boutique">
        <div className="panel-head">
          <div className="panel-title">
            <ChartIcon size={15} />
            <span>Chaque boutique</span>
          </div>
          <span className="panel-legend">
            <span className="legend-dot ok" /> CA boutique ce mois
            <span className="legend-dot" style={{ background: "var(--accent)" }} /> Revenu Elyndra / mois
          </span>
        </div>
        {!sf ? (
          <div className="table-wrap">
            <table>
              <tbody>
                {Array.from({ length: 3 }).map((_, i) => (
                  <tr key={i} className="skeleton-row">
                    <td colSpan={7}><div className="skeleton" style={{ height: 20 }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : shops.length === 0 ? (
          <div className="empty">
            <strong>Aucune boutique</strong>
            Les caisses apparaissent ici apr\u00e8s leur premier lancement.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Boutique</th>
                  <th>Abonnement</th>
                  <th>\u00c9crans</th>
                  <th>Statut</th>
                  <th>\u00c9tat</th>
                  <th>Derni\u00e8re sync</th>
                  <th>CA ce mois</th>
                  <th>Elyndra/mois</th>
                </tr>
              </thead>
              <tbody>
                {shops.map((s: StorefrontShop) => (
                  <tr key={s.device_id}>
                    <td>
                      <div className="cell-store">
                        <strong>{s.store_name || "\u2014"}</strong>
                        <div className="meta">{s.owner_name || s.phone || "\u2014"}</div>
                      </div>
                    </td>
                    <td>
                      {s.plan_name ? (
                        <span className="mono">{s.plan_name}</span>
                      ) : s.plan_price_fcfa != null ? (
                        <span className="mono">{fmtFcfa(s.plan_price_fcfa)}</span>
                      ) : (
                        "\u2014"
                      )}
                    </td>
                    <td>
                      <span className="mono">
                        {s.device_count}/{s.max_devices}
                        {s.over_limit ? <span className="badge suspended">Hors quota</span> : null}
                      </span>
                    </td>
                    <td>{statusBadge(s.status)}</td>
                    <td><OnlineDot online={s.online} /></td>
                    <td><span className="mono">{fmtDate(s.last_sync_at)}</span></td>
                    <td><span className="mono ok">{fmtFcfa(s.ca_month_fcfa)}</span></td>
                    <td><span className="mono" style={{ color: "var(--accent)" }}>{fmtFcfa(s.elyndra_month_fcfa)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="panels">
        <section className="panel" aria-label="Revenu Elyndra sur 30 jours">
          <div className="panel-head">
            <div className="panel-title">
              <TrendingUpIcon size={15} />
              <span>Revenu Elyndra \u2014 30 jours ({timeseries?.days ?? 0} j)</span>
            </div>
            <span className="panel-legend">
              <span className="legend-dot accent" /> Paiements abonnements
            </span>
          </div>
          <div className="bar-chart" style={{ height: 160 }}>
            {(timeseries?.by_day ?? []).map((d) => (
              <div key={d.day} className="bar-item">
                <div className="bar-track">
                  <div
                    className="bar-fill"
                    style={{ height: `${Math.max(4, (d.revenue / maxSeries) * 100)}%`, background: "var(--accent)" }}
                    title={`${d.day} : ${fmtFcfa(d.revenue)}`}
                  />
                </div>
                <span className="bar-label">{new Date(d.day + "T00:00:00").toLocaleDateString("fr-FR", { day: "2-digit" })}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel" aria-label="Revenu par client">
          <div className="panel-head">
            <div className="panel-title">
              <ChartIcon size={15} />
              <span>Revenu Elyndra par client \u2014 30 jours</span>
            </div>
          </div>
          <div className="bars">
            {(timeseries?.by_account ?? []).map((a) => (
              <div key={a.name} className="bar-row">
                <span className="bar-name">{a.name}</span>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${Math.max(4, (a.total / maxAccounts) * 100)}%` }} />
                </div>
                <span className="bar-value mono">{fmtFcfa(a.total)}</span>
              </div>
            ))}
            {(timeseries?.by_account ?? []).length === 0 && <div className="muted">Aucun paiement sur la p\u00e9riode.</div>}
          </div>
        </section>
      </div>

      <div className="stats" aria-label="Synth\u00e8se des revenus">
        <div className="stat"><div className="k">Aujourd'hui</div><div className="v">{fmtFcfa(revSummary?.today)}</div></div>
        <div className="stat"><div className="k">Semaine</div><div className="v">{fmtFcfa(revSummary?.week)}</div></div>
        <div className="stat"><div className="k">Mois</div><div className="v">{fmtFcfa(revSummary?.month)}</div></div>
        <div className="stat"><div className="k">Ann\u00e9e</div><div className="v">{fmtFcfa(revSummary?.year)}</div></div>
        <div className="stat"><div className="k">MRR r\u00e9current</div><div className="v ok">{fmtFcfa(revSummary?.recurring_mrr)}</div></div>
        <div className="stat"><div className="k">En attente</div><div className="v warn">{revSummary?.pending ?? 0}</div></div>
        <div className="stat"><div className="k">Confirm\u00e9s</div><div className="v ok">{revSummary?.confirmed ?? 0}</div></div>
      </div>
    </>
  );
}