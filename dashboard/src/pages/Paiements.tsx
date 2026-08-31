import { useEffect, useState } from "react";
import { fetchPaymentsView, fetchAccounts, processSmsPayment, type PaymentEvent, type SmsPayment, type Account } from "../api";
import { fmtFcfa, fmtDateShort, fmtDateTime } from "../utils";
import { BanknoteIcon, InboxIcon } from "../icons";

export function Paiements() {
  const [smsPayments, setSmsPayments] = useState<SmsPayment[]>([]);
  const [paymentEvents, setPaymentEvents] = useState<PaymentEvent[]>([]);
  const [summary, setSummary] = useState<{ today: number; month: number; pending: number; confirmed: number; total: number }>({ today: 0, month: 0, pending: 0, confirmed: 0, total: 0 });
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [pickFor, setPickFor] = useState<SmsPayment | null>(null);
  const [pickAccountId, setPickAccountId] = useState("");

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetchPaymentsView().catch(() => null),
      fetchAccounts().catch(() => ({ accounts: [] })),
    ]).then(([view, acc]) => {
      if (!alive) return;
      if (view) {
        setSmsPayments(view.sms_payments);
        setPaymentEvents(view.payment_events);
        setSummary(view.summary);
      }
      setAccounts(acc.accounts);
      setReady(true);
    });
    return () => { alive = false; };
  }, []);

  const handleProcess = async (id: number, accountId: number) => {
    try {
      await processSmsPayment(id, accountId);
      setPickFor(null);
      setPickAccountId("");
      const view = await fetchPaymentsView();
      setSmsPayments(view.sms_payments);
      setPaymentEvents(view.payment_events);
      setSummary(view.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur.");
    }
  };

  const processed = smsPayments.filter((p) => p.status === "processed");
  const unmatched = smsPayments.filter((p) => p.status === "unmatched" || p.status === "pending");
  const duplicates = smsPayments.filter((p) => p.status === "duplicate");

  return (
    <>
      {error && <div className="alert-banner">{error}</div>}

      <div className="stats" aria-label="Paiements">
        <div className="stat">
          <div className="k">Aujourd'hui</div>
          <div className="v accent">{fmtFcfa(summary.today)}</div>
        </div>
        <div className="stat">
          <div className="k">Mois</div>
          <div className="v">{fmtFcfa(summary.month)}</div>
        </div>
        <div className="stat">
          <div className="k">Re\u00e7us (SMS)</div>
          <div className="v">{smsPayments.length}</div>
        </div>
        <div className="stat">
          <div className="k">\u00c0 v\u00e9rifier</div>
          <div className="v warn">{summary.pending}</div>
        </div>
        <div className="stat">
          <div className="k">Confirm\u00e9s</div>
          <div className="v ok">{summary.confirmed}</div>
        </div>
        <div className="stat">
          <div className="k">Total</div>
          <div className="v">{fmtFcfa(summary.total)}</div>
        </div>
      </div>

      <div className="panels">
        <section className="panel" aria-label="Paiements SMS">
          <div className="panel-head">
            <div className="panel-title">
              <BanknoteIcon size={15} />
              <span>Paiements SMS (auto-renouvellement TextBee)</span>
            </div>
          </div>

          {smsPayments.length === 0 ? (
            <div className="chart-empty">
              <InboxIcon size={22} />
              {ready ? "Aucun paiement SMS re\u00e7u." : "Chargement\u2026"}
            </div>
          ) : (
            <div className="sms-panel">
              {processed.length > 0 && (
                <>
                  <div className="sms-group-title">
                    <span className="legend-dot ok" /> Renouvel\u00e9s automatiquement ({processed.length})
                  </div>
                  <ul className="sms-list">
                    {processed.slice(0, 6).map((p) => (
                      <li key={p.id}>
                        <span className="sms-main">
                          <strong>{p.name}</strong> ({p.phone})
                        </span>
                        <span className="sms-amount ok">{p.amount_fcfa.toLocaleString("fr-FR")} F</span>
                        <span className="sms-sub">
                          {p.matched_account_name ? `\u2192 ${p.matched_account_name}` : ""} \u00b7 {fmtDateShort(p.received_at)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {unmatched.length > 0 && (
                <>
                  <div className="sms-group-title">
                    <span className="legend-dot" style={{ background: "var(--warn)" }} /> \u00c0 v\u00e9rifier ({unmatched.length})
                  </div>
                  <ul className="sms-list">
                    {unmatched.slice(0, 10).map((p) => (
                      <li key={p.id}>
                        <span className="sms-main">
                          <strong>{p.name}</strong> ({p.phone})
                        </span>
                        <span className="sms-amount warn">{p.amount_fcfa.toLocaleString("fr-FR")} F</span>
                        <span className="sms-sub">{p.error ?? ""} \u00b7 {fmtDateShort(p.received_at)}</span>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => { setPickFor(p); setPickAccountId(""); }}
                        >
                          Relier
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {duplicates.length > 0 && (
                <div className="sms-duplicates">
                  <span className="legend-dot" style={{ background: "var(--muted)" }} /> {duplicates.length} doublon(s) ignor\u00e9(s)
                </div>
              )}

              {pickFor && (
                <div className="sms-picker">
                  <span className="muted">Relier \u00ab {pickFor.name} \u00bb ({pickFor.amount_fcfa.toLocaleString("fr-FR")} F) \u00e0 :</span>
                  <select value={pickAccountId} onChange={(e) => setPickAccountId(e.target.value)} className="st-input">
                    <option value="">\u2014 Choisir un compte \u2014</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.name} ({a.phone ?? "sans t\u00e9l."})</option>
                    ))}
                  </select>
                  <button type="button" className="btn" disabled={!pickAccountId} onClick={() => { if (pickAccountId) handleProcess(pickFor.id, Number(pickAccountId)); }}>
                    Confirmer
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => setPickFor(null)}>
                    Annuler
                  </button>
                </div>
              )}
            </div>
          )}
        </section>

        {paymentEvents.length > 0 && (
          <section className="panel" aria-label="Historique des paiements">
            <div className="panel-head">
              <div className="panel-title">
                <BanknoteIcon size={15} />
                <span>Historique des paiements ({paymentEvents.length})</span>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Compte</th>
                    <th>Montant</th>
                    <th>Statut</th>
                    <th>Source</th>
                    <th>R\u00e9f\u00e9rence</th>
                    <th>Re\u00e7u</th>
                  </tr>
                </thead>
                <tbody>
                  {paymentEvents.slice(0, 20).map((pe) => {
                    const row = pe as PaymentEvent & { account_name?: string; store_name?: string };
                    return (
                      <tr key={pe.id}>
                        <td className="cell-store">
                          <strong>{row.account_name ?? `#${pe.account_id}`}</strong>
                          {row.store_name ? <div className="meta">{row.store_name}</div> : null}
                        </td>
                        <td className="mono">{fmtFcfa(pe.amount)}</td>
                        <td>
                          <span className={`badge ${pe.status === "confirmed" ? "active" : pe.status === "pending" ? "" : "expired"}`}>
                            {pe.status}
                          </span>
                        </td>
                        <td className="mono">{pe.source}</td>
                        <td className="mono">{pe.reference}</td>
                        <td className="mono">{fmtDateTime(pe.received_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
