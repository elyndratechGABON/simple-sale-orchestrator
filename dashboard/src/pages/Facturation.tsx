import { useEffect, useState } from "react";
import {
  fetchPaymentsView,
  fetchAccounts,
  fetchRequests,
  approveRequest,
  rejectRequest,
  processSmsPayment,
  rejectSmsPayment,
  type PaymentEvent,
  type SmsPayment,
  type SubscriptionRequest,
  type Account,
} from "../api";
import { fmtFcfa, fmtDateShort, fmtDateTime, statusBadge } from "../utils";
import { BanknoteIcon, InboxIcon, StoreIcon, XIcon, CheckIcon } from "../icons";
import { Modal } from "../components/ui/Modal";

/** ABONNEMENTS & PAIEMENTS — l'argent de l'orchestrateur, au même endroit.
 *
 *  §1  PAIEMENTS EN ATTENTE  — ce qui attend une décision humaine :
 *        (a) les demandes d'abonnement déposées par les caisses,
 *        (b) les SMS de paiement (TextBee) : [Valider] / [Rejeter].
 *  §2  HISTORIQUE & STATISTIQUES — les abonnements en cours et la conversion des essais.
 *
 *  Rappel : un SMS n'est JAMAIS un renouvellement automatique — c'est une requête.
 *  Valider = choisir le compte concerné et l'appliquer. Rejeter = sortir la ligne de
 *  la file d'attente, sans toucher à aucun abonnement. */
export function Facturation() {
  const [smsPayments, setSmsPayments] = useState<SmsPayment[]>([]);
  const [paymentEvents, setPaymentEvents] = useState<PaymentEvent[]>([]);
  const [summary, setSummary] = useState<{ today: number; month: number; pending: number; confirmed: number; total: number }>({
    today: 0, month: 0, pending: 0, confirmed: 0, total: 0,
  });
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [requests, setRequests] = useState<SubscriptionRequest[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  // Choix du compte pour un SMS à valider.
  const [pickFor, setPickFor] = useState<SmsPayment | null>(null);
  const [pickAccountId, setPickAccountId] = useState("");

  const load = async () => {
    const [view, acc, req] = await Promise.all([
      fetchPaymentsView().catch(() => null),
      fetchAccounts().catch(() => ({ accounts: [] })),
      fetchRequests({ status: "pending" }).catch(() => ({ requests: [] })),
    ]);
    if (view) {
      setSmsPayments(view.sms_payments);
      setPaymentEvents(view.payment_events);
      setSummary(view.summary);
    }
    setAccounts(acc.accounts);
    setRequests(req.requests);
    setReady(true);
  };

  useEffect(() => {
    let alive = true;
    const loadOnce = async () => {
      try {
        const [view, acc, req] = await Promise.all([
          fetchPaymentsView().catch(() => null),
          fetchAccounts().catch(() => ({ accounts: [] })),
          fetchRequests({ status: "pending" }).catch(() => ({ requests: [] })),
        ]);
        if (!alive) return;
        if (view) {
          setSmsPayments(view.sms_payments);
          setPaymentEvents(view.payment_events);
          setSummary(view.summary);
        }
        setAccounts(acc.accounts);
        setRequests(req.requests);
        setReady(true);
        setError("");
      } catch {
        if (alive) setError("Impossible de charger les données.");
      }
    };
    loadOnce();
    const t = setInterval(loadOnce, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // ── Actions ────────────────────────────────────────────────────────────────────
  const handleApproveRequest = async (req: SubscriptionRequest) => {
    setBusy(true);
    try {
      await approveRequest(req.id);
      setNotice(`Abonnement de « ${req.store_name || req.account_name} » validé.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur.");
    } finally {
      setBusy(false);
    }
  };

  const handleRejectRequest = async (req: SubscriptionRequest) => {
    setBusy(true);
    try {
      await rejectRequest(req.id);
      setNotice(`Demande de « ${req.store_name || req.account_name} » refusée.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur.");
    } finally {
      setBusy(false);
    }
  };

  const handleProcessSms = async (id: number, accountId: number) => {
    setBusy(true);
    try {
      await processSmsPayment(id, accountId);
      setNotice(`Paiement SMS validé — le compte a été prolongé.`);
      setPickFor(null);
      setPickAccountId("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur.");
    } finally {
      setBusy(false);
    }
  };

  const handleRejectSms = async (p: SmsPayment) => {
    if (!window.confirm(
      `Rejeter le SMS de « ${p.name} » (${p.amount_fcfa.toLocaleString("fr-FR")} F) ?\n` +
      `Aucun abonnement n'est modifié : la ligne sort de la file d'attente.`,
    )) return;
    setBusy(true);
    try {
      await rejectSmsPayment(p.id);
      setNotice(`SMS de « ${p.name} » rejeté.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur.");
    } finally {
      setBusy(false);
    }
  };

  // ── Dérivés ────────────────────────────────────────────────────────────────────
  // Statuts SIMPLIFIÉS : 'pending' (à traiter) | 'processed' (validé) | 'rejected' (refusé).
  // Un SMS en attente se distingue par la PRÉSENCE d'un compte apparié : sans compte,
  // il reste « à relier » (le choix du compte est une décision humaine).
  const smsEnAttente = smsPayments.filter((p) => p.status === "pending");
  const smsRejetes = smsPayments.filter((p) => p.status === "rejected").length;
  const demandesEnAttente = requests.filter((r) => r.status === "pending");
  const abonnes = accounts.filter((a) => a.status === "active" || a.status === "grace");
  const enEssai = accounts.filter((a) => (a.payments ?? 0) === 0);
  const taux = accounts.length > 0
    ? Math.round(((accounts.length - enEssai.length) / accounts.length) * 100)
    : 0;

  return (
    <>
      {error && (
        <div className="alert-banner">
          {error}
          <button className="btn btn-ghost btn-sm" onClick={() => setError("")} style={{ marginLeft: "auto" }}>
            <XIcon size={13} />
          </button>
        </div>
      )}
      {notice && (
        <div className="alert-banner ok">
          {notice}
          <button className="btn btn-ghost btn-sm" onClick={() => setNotice("")} style={{ marginLeft: "auto" }}>
            <XIcon size={13} />
          </button>
        </div>
      )}

      <div className="stats" aria-label="Vue d'ensemble des paiements">
        <div className="stat">
          <div className="k">SMS à traiter</div>
          <div className="v warn">{smsEnAttente.length}</div>
        </div>
        <div className="stat">
          <div className="k">Demandes d'abonnement</div>
          <div className="v warn">{demandesEnAttente.length}</div>
        </div>
        <div className="stat">
          <div className="k">Encaissé ce mois</div>
          <div className="v accent">{fmtFcfa(summary.month)}</div>
        </div>
        <div className="stat">
          <div className="k">Confirmés</div>
          <div className="v ok">{summary.confirmed}</div>
        </div>
      </div>

      {/* ═══ §1 — PAIEMENTS EN ATTENTE ═══════════════════════════════════════════ */}
      <section className="panel" aria-label="Paiements en attente">
        <div className="panel-head">
          <div className="panel-title">
            <BanknoteIcon size={15} />
            <span>Paiements en attente ({smsEnAttente.length + demandesEnAttente.length})</span>
          </div>
          <span className="panel-legend">Rien ne se renouvelle tout seul : chaque ligne attend ta décision.</span>
        </div>

        {/* (a) Demandes d'abonnement déposées par les caisses */}
        {demandesEnAttente.length > 0 && (
          <>
            <div className="sms-group-title">
              <span className="legend-dot" style={{ background: "var(--warn)" }} /> Demandes d&apos;abonnement ({demandesEnAttente.length})
            </div>
            <div className="acc-list">
              {demandesEnAttente.map((r) => (
                <article className="acc" key={r.id}>
                  <header className="acc-head">
                    <span className="avatar" aria-hidden>
                      {(r.store_name || r.account_name || "?").trim().charAt(0).toUpperCase()}
                    </span>
                    <div className="acc-id">
                      <strong>{r.store_name || "Boutique"}</strong>
                      <div className="meta">
                        {r.owner_name}
                        {r.account_phone ? ` · ${r.account_phone}` : ""}
                      </div>
                    </div>
                    <div className="acc-tier">
                      <BanknoteIcon size={14} />
                      <span className="mono">{fmtFcfa(r.plan_price)}</span>
                      {r.plan_devices > 0 && (
                        <span className="badge delivered">{r.plan_devices} appareils</span>
                      )}
                    </div>
                    <div className="acc-status">
                      <span className="badge pending">En attente</span>
                    </div>
                  </header>
                  <div className="acc-body">
                    <div className="history">
                      <h3>Dépôt du marchand — {fmtDateTime(r.created_at)}</h3>
                      {r.reference && (
                        <div className="history-item">
                          <BanknoteIcon size={14} />
                          <span>Référence mobile money :</span>
                          <span className="mono">{r.reference}</span>
                        </div>
                      )}
                      {r.note && (
                        <div className="history-item">
                          <StoreIcon size={14} />
                          <span>Note : {r.note}</span>
                        </div>
                      )}
                    </div>
                    <div className="row-actions">
                      <button
                        className="btn btn-sm btn-primary"
                        onClick={() => handleApproveRequest(r)}
                        disabled={busy}
                      >
                        <CheckIcon size={13} />
                        Valider — prolonger le compte
                      </button>
                      <button
                        className="btn btn-sm btn-danger-ghost"
                        onClick={() => handleRejectRequest(r)}
                        disabled={busy}
                      >
                        <XIcon size={13} />
                        Refuser
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}

        {/* (b) SMS de paiement — la file d'attente principale */}
        <div className="sms-group-title">
          <span className="legend-dot" style={{ background: "var(--warn)" }} /> SMS de paiement ({smsEnAttente.length})
        </div>
        {!ready ? (
          <div className="skeleton" style={{ height: 80, margin: "10px 0" }} />
        ) : smsEnAttente.length === 0 ? (
          <div className="chart-empty">
            <InboxIcon size={22} />
            Aucun SMS de paiement en attente.
            {smsRejetes > 0 ? ` (${smsRejetes} rejeté${smsRejetes > 1 ? "s" : ""} — aucun abonnement touché)` : ""}
          </div>
        ) : (
          <>
            {/* Tableau : desktop uniquement. Sur téléphone, les colonnes de texte du SMS
                dépassent — c'est une pile de cartes qui prend le relais. */}
            <div className="table-wrap hidden md:block">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Boutique</th>
                    <th>Montant</th>
                    <th>Texte du SMS</th>
                    <th>État</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {smsEnAttente.map((p) => (
                    <tr key={p.id}>
                      <td className="mono">{fmtDateTime(p.received_at)}</td>
                      <td>
                        <div className="cell-store">
                          <strong>{p.matched_account_name || p.name || "—"}</strong>
                          <div className="meta">{p.phone}</div>
                        </div>
                      </td>
                      <td className="mono warn">{fmtFcfa(p.amount_fcfa)}</td>
                      <td className="mono muted" style={{ maxWidth: 260 }}>
                        {p.raw_sms ?? "—"}
                      </td>
                      <td>
                        <span className={`badge ${p.matched_account_id ? "delivered" : "pending"}`}>
                          {p.matched_account_id ? "Reconnu" : "À relier"}
                        </span>
                      </td>
                      <td>
                        <div className="row-actions" style={{ justifyContent: "flex-end" }}>
                          <button
                            className="btn btn-sm btn-primary"
                            onClick={() => {
                              setPickFor(p);
                              setPickAccountId(p.matched_account_id ? String(p.matched_account_id) : "");
                            }}
                            disabled={busy}
                          >
                            <CheckIcon size={13} />
                            Valider
                          </button>
                          <button
                            className="btn btn-sm btn-danger-ghost"
                            onClick={() => handleRejectSms(p)}
                            disabled={busy}
                          >
                            <XIcon size={13} />
                            Rejeter
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* mobile : une carte par SMS — montant et état d'abord, SMS tronqué ensuite. */}
            <div className="pay-cards md:hidden">
              {smsEnAttente.map((p) => (
                <article className="pay-card flat-card" key={p.id}>
                  <header className="pay-card-top">
                    <strong className="mono warn">{fmtFcfa(p.amount_fcfa)}</strong>
                    <span className={`badge ${p.matched_account_id ? "delivered" : "pending"}`}>
                      {p.matched_account_id ? "Reconnu" : "À relier"}
                    </span>
                  </header>
                  <div className="pay-card-store">
                    <strong>{p.matched_account_name || p.name || "—"}</strong>
                    <span className="meta mono">{p.phone}</span>
                    <span className="meta">{fmtDateTime(p.received_at)}</span>
                  </div>
                  <p className="pay-card-sms">{p.raw_sms ?? "—"}</p>
                  <div className="row-actions">
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => {
                        setPickFor(p);
                        setPickAccountId(p.matched_account_id ? String(p.matched_account_id) : "");
                      }}
                      disabled={busy}
                    >
                      <CheckIcon size={13} />
                      Valider
                    </button>
                    <button
                      className="btn btn-sm btn-danger-ghost"
                      onClick={() => handleRejectSms(p)}
                      disabled={busy}
                    >
                      <XIcon size={13} />
                      Rejeter
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </section>

      {/* ═══ §2 — HISTORIQUE & STATISTIQUES ═════════════════════════════════════ */}
      <div className="panels">
        <section className="panel" aria-label="Abonnements en cours">
          <div className="panel-head">
            <div className="panel-title">
              <StoreIcon size={15} />
              <span>Abonnements en cours ({abonnes.length})</span>
            </div>
            <span className="panel-legend">classés par échéance</span>
          </div>
          {abonnes.length === 0 ? (
            <div className="chart-empty">
              <InboxIcon size={22} />
              Aucun abonnement actif.
            </div>
          ) : (
            <>
              <div className="table-wrap hidden md:block">
                <table>
                  <thead>
                    <tr>
                      <th>Boutique</th>
                      <th>Patron</th>
                      <th>Téléphone</th>
                      <th>Palier</th>
                      <th>Échéance</th>
                      <th>Statut</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...abonnes]
                      .sort((a, b) => a.expiry_date - b.expiry_date)
                      .map((a) => (
                        <tr key={a.id}>
                          <td className="cell-store"><strong>{a.name}</strong></td>
                          <td>{a.owner_name || "—"}</td>
                          <td className="mono">{a.phone ?? "—"}</td>
                          <td className="mono">{fmtFcfa(a.monthly_price_fcfa)}</td>
                          <td className="mono">{fmtDateShort(a.expiry_date)}</td>
                          <td>{statusBadge(a.status)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              {/* mobile : une carte par compte. */}
              <div className="pay-cards md:hidden">
                {[...abonnes]
                  .sort((a, b) => a.expiry_date - b.expiry_date)
                  .map((a) => (
                    <article className="pay-card flat-card" key={a.id}>
                      <header className="pay-card-top">
                        <strong>{a.name}</strong>
                        {statusBadge(a.status)}
                      </header>
                      <div className="pay-card-store">
                        <span>{a.owner_name || "—"}</span>
                        <span className="mono">{a.phone ?? "—"}</span>
                      </div>
                      <div className="pay-card-top">
                        <span className="mono">{fmtFcfa(a.monthly_price_fcfa)}</span>
                        <span className="meta">échéance {fmtDateShort(a.expiry_date)}</span>
                      </div>
                    </article>
                  ))}
              </div>
            </>
          )}
        </section>

        <section className="panel" aria-label="Conversion des essais">
          <div className="panel-head">
            <div className="panel-title">
              <BanknoteIcon size={15} />
              <span>Conversion des essais</span>
            </div>
          </div>
          <div className="stats" style={{ marginBottom: 0, border: "none", boxShadow: "none", background: "transparent" }}>
            <div className="stat" style={{ padding: "10px 0" }}>
              <div className="k">Comptes</div>
              <div className="v">{accounts.length}</div>
            </div>
            <div className="stat" style={{ padding: "10px 0" }}>
              <div className="k">En essai (jamais payés)</div>
              <div className="v warn">{enEssai.length}</div>
            </div>
            <div className="stat" style={{ padding: "10px 0" }}>
              <div className="k">Abonnés</div>
              <div className="v ok">{accounts.length - enEssai.length}</div>
            </div>
            <div className="stat" style={{ padding: "10px 0" }}>
              <div className="k">Taux de conversion</div>
              <div className="v accent">{taux}%</div>
            </div>
          </div>
        </section>
      </div>

      {paymentEvents.length > 0 && (
        <section className="panel" aria-label="Historique des paiements">
          <div className="panel-head">
            <div className="panel-title">
              <BanknoteIcon size={15} />
              <span>Derniers paiements enregistrés ({paymentEvents.length})</span>
            </div>
          </div>
          <div className="table-wrap hidden md:block">
            <table>
              <thead>
                <tr>
                  <th>Compte</th>
                  <th>Montant</th>
                  <th>Statut</th>
                  <th>Source</th>
                  <th>Référence</th>
                  <th>Reçu</th>
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
          {/* mobile : une carte par paiement — montant + statut, puis la trace. */}
          <div className="pay-cards md:hidden">
            {paymentEvents.slice(0, 20).map((pe) => {
              const row = pe as PaymentEvent & { account_name?: string; store_name?: string };
              return (
                <article className="pay-card flat-card" key={pe.id}>
                  <header className="pay-card-top">
                    <strong className="mono">{fmtFcfa(pe.amount)}</strong>
                    <span className={`badge ${pe.status === "confirmed" ? "active" : pe.status === "pending" ? "" : "expired"}`}>
                      {pe.status}
                    </span>
                  </header>
                  <div className="pay-card-store">
                    <strong>{row.account_name ?? `#${pe.account_id}`}</strong>
                    <span className="meta">{row.store_name}</span>
                  </div>
                  <p className="pay-card-sms mono">
                    {pe.source} · {pe.reference} · {fmtDateTime(pe.received_at)}
                  </p>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {/* Choix du compte pour valider un SMS. */}
      <Modal
        open={pickFor !== null}
        onClose={() => setPickFor(null)}
        title={`Valider le paiement de « ${pickFor?.name || ""} »`}
      >
        <p className="modal-note">
          {fmtFcfa(pickFor?.amount_fcfa ?? 0)} reçus de {pickFor?.phone}. Choisis le compte à
          prolonger : la prolongation est appliquée immédiatement et le SMS est marqué traité.
        </p>
        <label htmlFor="sms-account">Compte à créditer</label>
        <select
          id="sms-account"
          className="input"
          value={pickAccountId}
          onChange={(e) => setPickAccountId(e.target.value)}
        >
          <option value="">— Choisir un compte —</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} ({a.phone ?? "sans tél."})
            </option>
          ))}
        </select>
        <div className="row-actions" style={{ marginTop: 12 }}>
          <button
            className="btn btn-primary"
            onClick={() => { if (pickAccountId) handleProcessSms(pickFor!.id, Number(pickAccountId)); }}
            disabled={busy || !pickAccountId}
          >
            <CheckIcon size={13} />
            Valider le paiement
          </button>
          <button className="btn btn-ghost" onClick={() => setPickFor(null)}>
            <XIcon size={13} />
            Annuler
          </button>
        </div>
      </Modal>
    </>
  );
}
