import { useEffect, useMemo, useState } from "react";
import {
  fetchShopsDetail,
  fetchDeleteRequests,
  approveDeleteRequest,
  rejectDeleteRequest,
  deleteShop,
  deleteAccount,
  sendAccountCommand,
  setAccountPlan,
  activateAccount,
  attachDeviceToAccount,
  revokeDevice,
  type ShopDetail,
  type DeleteRequest,
} from "../api";
import { fmtDate, fmtDateTime, fmtFcfa, statusBadge } from "../utils";
import {
  AlertIcon,
  BanknoteIcon,
  InboxIcon,
  LockIcon,
  SendIcon,
  SmartphoneIcon,
  XIcon,
} from "../icons";
import { DataTable } from "../components/ui/DataTable";
import { Modal } from "../components/ui/Modal";
import { OnlineDot } from "../components/ui/OnlineDot";

type Props = {
  onSelect: (deviceId: string) => void;
};

/** Les paliers : le montant fixe le nombre de places. */
const PALIERS = [
  { montant: 10000, nom: "Essentiel", places: 3 },
  { montant: 25000, nom: "Confort", places: 5 },
  { montant: 50000, nom: "Affluence", places: 9 },
];

type Filtre = "all" | "trial" | "subscribed" | "suspended";

const FILTRES: { cle: Filtre; label: string }[] = [
  { cle: "all", label: "Tous" },
  { cle: "trial", label: "En essai" },
  { cle: "subscribed", label: "Abonnés" },
  { cle: "suspended", label: "Suspendus" },
];

/** Un commerce « en essai » n'a jamais payé ; « abonné » a au moins un paiement. */
function categorie(s: ShopDetail): "trial" | "subscribed" | "suspended" {
  if (s.status === "suspended") return "suspended";
  return (s.payments ?? 0) > 0 ? "subscribed" : "trial";
}

export function Boutiques({ onSelect }: Props) {
  const [shops, setShops] = useState<ShopDetail[]>([]);
  const [deletions, setDeletions] = useState<DeleteRequest[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  // Filtres et recherche : c'est le quotidien du support (« le client de Port-Gentil »).
  const [filtre, setFiltre] = useState<Filtre>("all");
  const [recherche, setRecherche] = useState("");
  // Les modales d'action sur un commerce.
  const [planPour, setPlanPour] = useState<ShopDetail | null>(null);
  const [messagePour, setMessagePour] = useState<ShopDetail | null>(null);
  const [messageTexte, setMessageTexte] = useState("");
  const [accesPour, setAccesPour] = useState<ShopDetail | null>(null);
  const [deviceIdRattache, setDeviceIdRattache] = useState("");

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [shopRes, reqRes] = await Promise.all([
          fetchShopsDetail(),
          fetchDeleteRequests({ status: "pending" }),
        ]);
        if (!alive) return;
        setShops(shopRes.shops);
        setDeletions(reqRes.requests);
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

  const rafraichir = async () => {
    const [shopRes, reqRes] = await Promise.all([
      fetchShopsDetail(),
      fetchDeleteRequests({ status: "pending" }),
    ]);
    setShops(shopRes.shops);
    setDeletions(reqRes.requests);
  };

  // La liste affichée : filtres + recherche. Les compteurs restent sur le TOTAL
  // (pas sur la liste filtrée) : « 12 en essai » doit dire la vérité, même filtré.
  const visibles = useMemo(() => {
    const q = recherche.trim().toLowerCase();
    return shops.filter((s) => {
      if (filtre !== "all" && categorie(s) !== filtre) return false;
      if (!q) return true;
      return [s.store_name, s.owner_name, s.account_name, s.phone, s.location]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    });
  }, [shops, filtre, recherche]);

  const compteurs = useMemo(() => {
    const c: Record<Filtre, number> = { all: shops.length, trial: 0, subscribed: 0, suspended: 0 };
    for (const s of shops) c[categorie(s)]++;
    return c;
  }, [shops]);


  const handleApprove = async (req: DeleteRequest) => {
    setBusy(true);
    try {
      await approveDeleteRequest(req.id);
      setNotice(`Suppression de « ${req.store_name} » approuvée — la caisse est libérée.`);
      const [shopRes, reqRes] = await Promise.all([fetchShopsDetail(), fetchDeleteRequests({ status: "pending" })]);
      setShops(shopRes.shops);
      setDeletions(reqRes.requests);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur.");
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async (req: DeleteRequest) => {
    setBusy(true);
    try {
      await rejectDeleteRequest(req.id);
      setNotice(`Demande de suppression de « ${req.store_name} » refusée.`);
      const res = await fetchDeleteRequests({ status: "pending" });
      setDeletions(res.requests);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur.");
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteDevice = async (deviceId: string, storeName: string) => {
    if (!window.confirm(`Supprimer l'écran « ${storeName} » ? Cette action est irréversible.`)) return;
    setDeleting(deviceId);
    try {
      await deleteShop(deviceId);
      setNotice(`Écran « ${storeName} » supprimé.`);
      const shopRes = await fetchShopsDetail();
      setShops(shopRes.shops);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors de la suppression.");
    } finally {
      setDeleting(null);
    }
  };

  const handleDeleteAccount = async (accountId: number, accountName: string) => {
    if (!window.confirm(
      `Supprimer TOUTE la boutique « ${accountName} » (compte + tous ses écrans) ?\n` +
      `Cette action est IRRÉVERSIBLE : toutes les ventes, le stock et l'historique seront perdus.`
    )) return;
    setDeleting(`account-${accountId}`);
    try {
      await deleteAccount(accountId);
      setNotice(`Boutique « ${accountName} » supprimée.`);
      const shopRes = await fetchShopsDetail();
      setShops(shopRes.shops);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur lors de la suppression.");
    } finally {
      setDeleting(null);
    }
  };

  /** Suspendre / réactiver un commerce entier (tous ses écrans d'un coup). */
  const handleToggleSuspend = async (s: ShopDetail) => {
    if (s.account_id == null) {
      setError("Ce commerce n'est rattaché à aucun compte : suspendez l'écran depuis sa fiche.");
      return;
    }
    const nom = s.account_name || s.store_name;
    if (s.status === "suspended") {
      if (!window.confirm(`Réactiver « ${nom} » ? La caisse reprendra service.`)) return;
      setBusy(true);
      try {
        await activateAccount(s.account_id);
        setNotice(`« ${nom} » réactivé.`);
        await rafraichir();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Erreur.");
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!window.confirm(
      `Suspendre « ${nom} » ?\nTous ses écrans se verrouillent (l'accès est coupé, les données restent).`
    )) return;
    setBusy(true);
    try {
      await sendAccountCommand(s.account_id, { action_type: "suspend" });
      setNotice(`« ${nom} » suspendu.`);
      await rafraichir();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur.");
    } finally {
      setBusy(false);
    }
  };

  /** Rattacher un écran à ce commerce (recours quand l'écran n'a pas pu rejoindre). */
  const handleAttach = async () => {
    if (!accesPour?.account_id || !deviceIdRattache.trim()) return;
    setBusy(true);
    try {
      await attachDeviceToAccount(accesPour.account_id, deviceIdRattache.trim());
      setNotice(`Écran rattaché à « ${accesPour.account_name || accesPour.store_name} ».`);
      setDeviceIdRattache("");
      await rafraichir();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur.");
    } finally {
      setBusy(false);
    }
  };

  /** Révoquer l'accès d'un écran : il quitte le commerce (la fiche est supprimée). */
  const handleRevokeDevice = async (deviceId: string, label: string) => {
    if (
      !window.confirm(
        `Révoquer l'accès de l'écran « ${label} » ?\nIl devra être rattaché à nouveau.`,
      )
    )
      return;
    setBusy(true);
    try {
      await revokeDevice(deviceId);
      setNotice(`Accès de « ${label} » révoqué.`);
      await rafraichir();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur.");
    } finally {
      setBusy(false);
    }
  };

  /** Changer l'abonnement : le palier fixe le nombre de places. */
  const handleChangePlan = async (s: ShopDetail, montant: number) => {
    if (s.account_id == null) return;
    setBusy(true);
    try {
      await setAccountPlan(s.account_id, { amount_fcfa: montant, reason: "Changement depuis la console" });
      setNotice(`Abonnement de « ${s.account_name || s.store_name} » mis à jour.`);
      setPlanPour(null);
      await rafraichir();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur.");
    } finally {
      setBusy(false);
    }
  };

  /** Envoyer un message au patron (il le reçoit à la prochaine synchronisation). */
  const handleSendMessage = async () => {
    if (!messagePour?.account_id || !messageTexte.trim()) return;
    setBusy(true);
    try {
      await sendAccountCommand(messagePour.account_id, {
        action_type: "broadcast_message",
        message: messageTexte.trim(),
      });
      setNotice(`Message envoyé à « ${messagePour.account_name || messagePour.store_name} ».`);
      setMessagePour(null);
      setMessageTexte("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {error && (
        <div className="alert-banner">
          {error}
          <button className="btn btn-ghost btn-sm" onClick={() => setError("")} style={{ marginLeft: "auto" }}>✕</button>
        </div>
      )}
      {notice && (
        <div className="alert-banner ok">
          {notice}
          <button className="btn btn-ghost btn-sm" onClick={() => setNotice("")} style={{ marginLeft: "auto" }}>✕</button>
        </div>
      )}

      {deletions.length > 0 && (
        <section className="acc-list" aria-label="Demandes de suppression">
          {deletions.map((r) => (
            <article className="acc" key={r.id}>
              <header className="acc-head">
                <span className="avatar" aria-hidden>
                  {(r.store_name || "?").trim().charAt(0).toUpperCase()}
                </span>
                <div className="acc-id">
                  <strong>{r.store_name || "Boutique"}</strong>
                  <div className="meta">
                    {r.owner_name}
                    {r.reason ? ` · « ${r.reason} »` : ""}
                  </div>
                </div>
                <div className="acc-status">
                  <span className="badge pending">Suppression demandée</span>
                </div>
              </header>
              <div className="acc-body">
                <div className="history">
                  <h3>L'employé veut partir — {fmtDateTime(r.created_at)}</h3>
                  <div className="history-item">
                    <span className="mono">{r.device_id}</span>
                    <span className="muted">Appareil concerné</span>
                  </div>
                </div>
                <div className="row-actions">
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => handleApprove(r)}
                    disabled={busy}
                  >
                    Supprimer
                  </button>
                  <button
                    className="btn btn-sm btn-danger-ghost"
                    onClick={() => handleReject(r)}
                    disabled={busy}
                  >
                    Refuser
                  </button>
                </div>
              </div>
            </article>
          ))}
        </section>
      )}

      {/* Filtres + recherche : le quotidien du support (« le client de Port-Gentil »). */}
      <div className="row-actions" style={{ marginBottom: 12, gap: 12, alignItems: "center" }}>
        <div className="segmented segmented-inline" role="tablist" aria-label="Filtrer les boutiques">
          {FILTRES.map((f) => (
            <button
              key={f.cle}
              role="tab"
              aria-selected={filtre === f.cle}
              className={`segment ${filtre === f.cle ? "active" : ""}`}
              onClick={() => setFiltre(f.cle)}
            >
              {f.label} <span className="muted">{compteurs[f.cle]}</span>
            </button>
          ))}
        </div>
        <input
          className="input"
          placeholder="Rechercher un commerce, un patron, un téléphone…"
          value={recherche}
          onChange={(e) => setRecherche(e.target.value)}
          style={{ flex: 1, minWidth: 220, maxWidth: 420 }}
          aria-label="Rechercher"
        />
      </div>

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
          Les caisses apparaissent ici après leur premier lancement.
        </div>
      ) : (
        <DataTable
          columns={[
            {
              key: "store_name",
              label: "Boutique",
              render: (s: ShopDetail) => (
                <div className="cell-store">
                  <strong>{s.store_name || "—"}</strong>
                  <div className="meta">{s.owner_name}</div>
                </div>
              ),
            },
            {
              key: "account_name",
              label: "Compte",
              render: (s: ShopDetail) => <span>{s.account_name ?? "—"}</span>,
            },
            {
              key: "account_tier",
              label: "Abonnement",
              render: (s: ShopDetail) =>
                s.account_max_devices != null ? (
                  <span className="mono">
                    {s.account_device_count}/{s.account_max_devices} écrans
                    {s.plan_name ? (
                      <span className="muted"> · {s.plan_name}</span>
                    ) : s.plan_price_fcfa != null ? (
                      <span className="muted"> · {fmtFcfa(s.plan_price_fcfa)}</span>
                    ) : null}
                  </span>
                ) : (
                  "—"
                ),
            },
            {
              key: "devices",
              label: "Écrans",
              render: (s: ShopDetail) => (
                <div className="space-y-1">
                  {(s.devices ?? [{ device_id: s.device_id, store_name: s.store_name, online: s.online, last_sync_at: s.last_sync_at }]).map((d) => (
                    <div key={d.device_id} className="flex items-center gap-1.5">
                      <OnlineDot online={d.online} />
                      <button
                        className="mono underline-offset-2 hover:underline"
                        onClick={() => onSelect(d.device_id)}
                        title={`Détail de l'écran ${d.store_name}`}
                      >
                        {d.store_name || d.device_id.slice(0, 8)}
                      </button>
                      <button
                        className="btn btn-ghost btn-xs text-destructive hover:text-destructive opacity-0 group-hover:opacity-100"
                        onClick={() => handleDeleteDevice(d.device_id, d.store_name || d.device_id.slice(0, 8))}
                        disabled={deleting === d.device_id || busy}
                        title="Supprimer cet écran"
                        aria-label={`Supprimer l'écran ${d.store_name || d.device_id.slice(0, 8)}`}
                      >
                        {deleting === d.device_id ? "⏳" : "🗑"}
                      </button>
                    </div>
                  ))}
                </div>
              ),
            },
            { key: "status", label: "Statut", render: (s: ShopDetail) => statusBadge(s.status) },
            {
              key: "expiry_date",
              label: "Échéance",
              render: (s: ShopDetail) => <span className="mono">{fmtDate(s.expiry_date)}</span>,
            },
            {
              key: "last_sync_at",
              label: "Dernière sync",
              render: (s: ShopDetail) => <span className="mono">{fmtDateTime(s.last_sync_at)}</span>,
            },
            {
              key: "actions",
              label: "",
              render: (s: ShopDetail) => (
                <div className="flex items-center gap-1.5">
                  <button className="btn btn-sm" onClick={() => onSelect(s.device_id)}>
                    Détails
                  </button>
                  {s.account_id != null && (
                    <>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => {
                          setAccesPour(s);
                          setDeviceIdRattache("");
                        }}
                        disabled={busy}
                        title="Gérer les écrans de ce commerce"
                      >
                        <SmartphoneIcon size={13} />
                        Accès
                      </button>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => setPlanPour(s)}
                        disabled={busy}
                        title="Changer l'abonnement (nombre de places)"
                      >
                        <BanknoteIcon size={13} />
                        Abonnement
                      </button>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => {
                          setMessagePour(s);
                          setMessageTexte("");
                        }}
                        disabled={busy}
                        title="Envoyer un message au patron"
                      >
                        <SendIcon size={13} />
                        Message
                      </button>
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => handleToggleSuspend(s)}
                        disabled={busy}
                        title={
                          s.status === "suspended"
                            ? "Réactiver ce commerce"
                            : "Suspendre ce commerce (l'accès est coupé, les données restent)"
                        }
                      >
                        {s.status === "suspended" ? (
                          <>
                            <AlertIcon size={13} />
                            Réactiver
                          </>
                        ) : (
                          <>
                            <LockIcon size={13} />
                            Suspendre
                          </>
                        )}
                      </button>
                    </>
                  )}
                  {s.account_id != null && (
                    <button
                      className="btn btn-sm btn-ghost text-destructive hover:text-destructive"
                      onClick={() => handleDeleteAccount(s.account_id!, s.account_name || `compte #${s.account_id}`)}
                      disabled={deleting === `account-${s.account_id}` || busy}
                      title="Supprimer toute la boutique (compte + tous ses écrans)"
                    >
                      {deleting === `account-${s.account_id}` ? "⏳" : "🗑"}
                    </button>
                  )}
                </div>
              ),
            },
          ]}
          data={visibles}
          keyFn={(s) => s.device_id}
          emptyMessage={
            shops.length === 0
              ? "Aucune boutique."
              : "Aucun commerce ne correspond à ce filtre."
          }
        />
      )}

      {/* Gérer les accès : les écrans du commerce, et le rattachement d'un écran
          qui n'a pas pu rejoindre de lui-même. */}
      <Modal
        open={accesPour !== null}
        onClose={() => setAccesPour(null)}
        title={`Accès — ${accesPour?.account_name || accesPour?.store_name || ""}`}
      >
        <p className="modal-note">
          {accesPour?.account_device_count ?? 0}/{accesPour?.account_max_devices ?? "?"} places
          utilisées. Pour rattacher un écran, donnez son identifiant (visible dans la fiche de
          l&apos;écran, ou dans « Appareils »).
        </p>
        <div className="acc-list">
          {(accesPour?.devices ?? []).map((d) => (
            <article className="acc" key={d.device_id}>
              <header className="acc-head">
                <span className="avatar" aria-hidden>
                  {(d.store_name || "?").trim().charAt(0).toUpperCase()}
                </span>
                <div className="acc-id">
                  <strong>{d.store_name || d.device_id.slice(0, 8)}</strong>
                  <div className="meta mono">{d.device_id}</div>
                </div>
                <div className="acc-status">
                  <span className={`badge ${d.status === "suspended" ? "suspended" : "delivered"}`}>
                    {d.status === "suspended" ? "Suspendu" : "Actif"}
                  </span>
                </div>
              </header>
              <div className="row-actions">
                <button
                  className="btn btn-sm btn-danger-ghost"
                  onClick={() => void handleRevokeDevice(d.device_id, d.store_name || d.device_id.slice(0, 8))}
                  disabled={busy}
                >
                  Révoquer l'accès
                </button>
              </div>
            </article>
          ))}
          {(accesPour?.devices ?? []).length === 0 && (
            <div className="muted">Aucun écran rattaché.</div>
          )}
        </div>
        <label htmlFor="attach-device">Rattacher un écran (identifiant de l&apos;écran)</label>
        <input
          id="attach-device"
          value={deviceIdRattache}
          onChange={(e) => setDeviceIdRattache(e.target.value)}
          placeholder="ex. 3f2a…-…"
        />
        <div className="row-actions" style={{ marginTop: 12 }}>
          <button
            className="btn btn-primary"
            onClick={() => void handleAttach()}
            disabled={busy || !deviceIdRattache.trim()}
          >
            Rattacher
          </button>
          <button className="btn btn-ghost" onClick={() => setAccesPour(null)}>
            Fermer
          </button>
        </div>
      </Modal>

      {/* Changer l'abonnement : le palier fixe le nombre de places. */}
      <Modal
        open={planPour !== null}
        onClose={() => setPlanPour(null)}
        title={`Abonnement — ${planPour?.account_name || planPour?.store_name || ""}`}
      >
        <p className="modal-note">
          Le palier choisi fixe le nombre de places (écrans) et la durée. L&apos;abonnement en
          cours : {planPour?.plan_name || "aucun"} — {fmtFcfa(planPour?.plan_price_fcfa ?? null)} —
          {" "}
          {planPour?.account_device_count ?? 0}/{planPour?.account_max_devices ?? "?"} écrans.
        </p>
        <div className="tier-chips">
          {PALIERS.map((p) => (
            <button
              key={p.montant}
              className="chip-btn"
              onClick={() => planPour && handleChangePlan(planPour, p.montant)}
              disabled={busy}
            >
              <strong>{p.nom}</strong>
              <span className="muted">
                {fmtFcfa(p.montant)} · {p.places} écrans
              </span>
            </button>
          ))}
        </div>
      </Modal>

      {/* Message au patron : il le reçoit à sa prochaine synchronisation. */}
      <Modal
        open={messagePour !== null}
        onClose={() => setMessagePour(null)}
        title={`Message — ${messagePour?.account_name || messagePour?.store_name || ""}`}
      >
        <p className="modal-note">
          Le message est affiché chez le patron à sa prochaine synchronisation. Utile pour une
          consigne ponctuelle (une information, une demande de vérification).
        </p>
        <textarea
          value={messageTexte}
          onChange={(e) => setMessageTexte(e.target.value)}
          placeholder="Votre message…"
          rows={4}
        />
        <div className="row-actions" style={{ marginTop: 12 }}>
          <button
            className="btn btn-primary"
            onClick={() => void handleSendMessage()}
            disabled={busy || !messageTexte.trim()}
          >
            <SendIcon size={13} />
            Envoyer
          </button>
          <button className="btn btn-ghost" onClick={() => setMessagePour(null)}>
            <XIcon size={13} />
            Annuler
          </button>
        </div>
      </Modal>
    </>
  );
}
