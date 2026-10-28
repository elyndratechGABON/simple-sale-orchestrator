import { useEffect, useState } from "react";
import {
  fetchStorefront,
  fetchAccounts,
  fetchDevices,
  type Storefront,
  type Account,
  type DevicesSummary,
} from "../api";
import { fmtFcfa } from "../utils";
import { StoreIcon, BanknoteIcon, ActivityIcon, SmartphoneIcon } from "../icons";

/** Le récapitulatif : quatre cartes, rien de plus.
 *  1. le parc (boutiques en ligne / hors ligne)
 *  2. la rentrée (MRR — le revenu mensuel récurrent des abonnements)
 *  3. les boutiques en essai (jamais payées) → le taux de conversion
 *  4. les écrans (appareils) connectés
 *  AUCUNE donnée de vente des clients : leur CA reste sur leurs téléphones. */
export function TableauBord() {
  const [sf, setSf] = useState<Storefront | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [devices, setDevices] = useState<DevicesSummary | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [storefront, acc, dev] = await Promise.all([
          fetchStorefront().catch(() => null),
          fetchAccounts().catch(() => ({ accounts: [] })),
          fetchDevices().catch(() => null),
        ]);
        if (!alive) return;
        setSf(storefront);
        setAccounts(acc.accounts);
        setDevices(dev?.summary ?? null);
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
  const enEssai = accounts.filter((a) => (a.payments ?? 0) === 0).length;
  const abonnes = accounts.length - enEssai;
  const taux = accounts.length > 0 ? Math.round((abonnes / accounts.length) * 100) : 0;
  const ecransTotal = devices?.total ?? kpi?.devices_total ?? 0;
  const ecransEnLigne = devices?.online ?? kpi?.en_ligne ?? 0;

  return (
    <>
      {error && <div className="alert-banner">{error}</div>}

      <div className="kpi-grid" aria-label="Récapitulatif">
        <section className="kpi-card">
          <div className="kpi-head">
            <span className="kpi-icon accent"><StoreIcon size={16} /></span>
            <span className="kpi-label">Boutiques</span>
          </div>
          <div className="kpi-value">{kpi?.boutique_total ?? 0}</div>
          <div className="kpi-sub">
            {kpi?.en_ligne ?? 0} en ligne · {kpi?.hors_ligne ?? 0} hors ligne
          </div>
        </section>

        <section className="kpi-card">
          <div className="kpi-head">
            <span className="kpi-icon ok"><BanknoteIcon size={16} /></span>
            <span className="kpi-label">CA mensuel (MRR)</span>
          </div>
          <div className="kpi-value ok">{fmtFcfa(sf?.elyndra?.mrr_fcfa)}</div>
          <div className="kpi-sub">
            {fmtFcfa(sf?.elyndra?.arr_fcfa)} par an · {fmtFcfa(sf?.elyndra?.mois_encaisse)} encaissé ce mois
          </div>
        </section>

        <section className="kpi-card">
          <div className="kpi-head">
            <span className="kpi-icon warn"><ActivityIcon size={16} /></span>
            <span className="kpi-label">Boutiques en essai</span>
          </div>
          <div className="kpi-value warn">{enEssai}</div>
          <div className="kpi-sub">
            {taux}% de conversion · {abonnes} abonné{abonnes > 1 ? "s" : ""} sur {accounts.length}
          </div>
        </section>

        <section className="kpi-card">
          <div className="kpi-head">
            <span className="kpi-icon"><SmartphoneIcon size={16} /></span>
            <span className="kpi-label">Écrans connectés</span>
          </div>
          <div className="kpi-value">{ecransEnLigne}</div>
          <div className="kpi-sub">
            sur {ecransTotal} écrans au total · {devices?.offline ?? 0} hors ligne
          </div>
        </section>
      </div>
    </>
  );
}
