import { useEffect, useState } from "react";
import { fetchOverview, fetchRevenueTimeseries, fetchRevenueSummary, type Overview, type RevenueTimeseries, type RevenueSummary } from "../api";
import { fmtFcfa } from "../utils";
import { BanknoteIcon, TrendingUpIcon, ChartIcon, CalendarIcon } from "../icons";

export function Dashboard() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [timeseries, setTimeseries] = useState<RevenueTimeseries | null>(null);
  const [revSummary, setRevSummary] = useState<RevenueSummary | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [o, ts, rs] = await Promise.all([
          fetchOverview().catch(() => null),
          fetchRevenueTimeseries("30d").catch(() => null),
          fetchRevenueSummary().catch(() => null),
        ]);
        if (!alive) return;
        setOv(o);
        setTimeseries(ts);
        setRevSummary(rs);
        setError("");
      } catch {
        if (alive) setError("Impossible de charger les donn\u00e9es.");
      }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const kpi = ov?.kpi;
  const subs = ov?.subscriptions;
  const elyndra = ov?.business?.elyndra_revenue;
  const boutiques = ov?.business?.shop_revenue;

  const maxSeries = Math.max(...(timeseries?.by_day ?? []).map((d) => d.revenue), 1);
  const maxAccounts = Math.max(...(timeseries?.by_account ?? []).map((a) => a.total), 1);

  return (
    <>
      {error && <div className="alert-banner">{error}</div>}

      <div className="stats" aria-label="Chiffre d'affaires Elyndra (abonnements)">
        <div className="stat">
          <div className="k">CA Elyndra jour</div>
          <div className="v accent">{fmtFcfa(elyndra?.today)}</div>
        </div>
        <div className="stat">
          <div className="k">CA Elyndra semaine</div>
          <div className="v">{fmtFcfa(elyndra?.week)}</div>
        </div>
        <div className="stat">
          <div className="k">CA Elyndra mois</div>
          <div className="v">{fmtFcfa(elyndra?.month)}</div>
        </div>
        <div className="stat">
          <div className="k">MRR</div>
          <div className="v accent">{fmtFcfa(elyndra?.mrr)}</div>
        </div>
        <div className="stat">
          <div className="k">ARR</div>
          <div className="v">{fmtFcfa(elyndra?.arr)}</div>
        </div>
      </div>

      <div className="stats" aria-label="Chiffre d'affaires boutique">
        <div className="stat">
          <div className="k">CA boutiques 7 j</div>
          <div className="v ok">{fmtFcfa(boutiques?.week)}</div>
        </div>
        <div className="stat">
          <div className="k">CA boutiques total</div>
          <div className="v">{fmtFcfa(boutiques?.total_revenue)}</div>
        </div>
        <div className="stat">
          <div className="k">Ventes</div>
          <div className="v">{boutiques?.total_sales ?? 0}</div>
        </div>
        <div className="stat">
          <div className="k">B\u00e9n\u00e9fice total</div>
          <div className="v ok">{fmtFcfa(boutiques?.total_profit)}</div>
        </div>
      </div>

      <div className="stats" aria-label="Abonnements">
        <div className="stat">
          <div className="k">Clients</div>
          <div className="v">{kpi?.clients ?? 0}</div>
        </div>
        <div className="stat">
          <div className="k">Abonnements actifs</div>
          <div className="v ok">{subs?.active ?? 0}</div>
        </div>
        <div className="stat">
          <div className="k">En ligne</div>
          <div className="v">{subs?.online ?? 0}</div>
        </div>
        <div className="stat">
          <div className="k">En gr\u00e2ce</div>
          <div className="v" style={{ color: "#c2410c" }}>{subs?.grace ?? 0}</div>
        </div>
        <div className="stat">
          <div className="k">Suspendus</div>
          <div className="v">{subs?.suspended ?? 0}</div>
        </div>
        <div className="stat">
          <div className="k">Expir\u00e9s</div>
          <div className="v danger">{subs?.expired ?? 0}</div>
        </div>
      </div>

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

      <div className="panels">
        <section className="panel" aria-label="Synthèse revenu">
          <div className="panel-head">
            <div className="panel-title">
              <BanknoteIcon size={15} />
              <span>Synth\u00e8se des revenus</span>
            </div>
          </div>
          <div className="stats" style={{ marginBottom: 0 }}>
            <div className="stat"><div className="k">Aujourd'hui</div><div className="v">{fmtFcfa(revSummary?.today)}</div></div>
            <div className="stat"><div className="k">Semaine</div><div className="v">{fmtFcfa(revSummary?.week)}</div></div>
            <div className="stat"><div className="k">Mois</div><div className="v">{fmtFcfa(revSummary?.month)}</div></div>
            <div className="stat"><div className="k">Ann\u00e9e</div><div className="v">{fmtFcfa(revSummary?.year)}</div></div>
            <div className="stat"><div className="k">MRR r\u00e9current</div><div className="v ok">{fmtFcfa(revSummary?.recurring_mrr)}</div></div>
            <div className="stat"><div className="k">En attente</div><div className="v warn">{revSummary?.pending ?? 0}</div></div>
            <div className="stat"><div className="k">Confirm\u00e9s</div><div className="v ok">{revSummary?.confirmed ?? 0}</div></div>
          </div>
        </section>
      </div>

      {subs && subs.expiring_7d > 0 && (
        <div className="alert-banner warn">
          <CalendarIcon size={15} />
          <span>
            {subs.expiring_7d} abonnement{subs.expiring_7d > 1 ? "s" : ""} expire{subs.expiring_7d > 1 ? "nt" : ""} sous 7 jours
          </span>
        </div>
      )}
    </>
  );
}
