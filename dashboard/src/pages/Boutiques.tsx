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
  setAccountCustom,
  setAccountPassword,
  activateAccount,
  attachDeviceToAccount,
  revokeDevice,
  type ShopDetail,
  type DeleteRequest,
} from "../api";
import { fmtDateTime, fmtFcfa, statusBadge } from "../utils";
import {
  AlertIcon,
  BanknoteIcon,
  HourglassIcon,
  InboxIcon,
  LockIcon,
  PlusIcon,
  SendIcon,
  SmartphoneIcon,
  StoreIcon,
  TrashIcon,
  XIcon,
} from "../icons";
import { Modal } from "../components/ui/Modal";
import { OnlineDot } from "../components/ui/OnlineDot";

type Props = {
  onSelect: (deviceId: string) => void;
};

/** Les abonnements : le montant fixe le nombre de places. */
const ABONNEMENTS = [
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

/** Une boutique « en essai » n'a jamais payé ; « abonné » a au moins un paiement. */
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
  // Les modales d'action sur une boutique.
  const [planPour, setPlanPour] = useState<ShopDetail | null>(null);
  const [messagePour, setMessagePour] = useState<ShopDetail | null>(null);
  const [messageTexte, setMessageTexte] = useState("");
  const [accesPour, setAccesPour] = useState<ShopDetail | null>(null);
  const [deviceIdRattache, setDeviceIdRattache] = useState("");
  // Option SUR-MESURE : +N appareils / prix libre / durée — au-delà des paliers.
  const [customPour, setCustomPour] = useState<ShopDetail | null>(null);
  const [customDevices, setCustomDevices] = useState("");
  const [customPrix, setCustomPrix] = useState("");
  const [customJours, setCustomJours] = useState("");
  // Changement de mot de passe du compte (support : le patron l'a perdu).
  const [nouveauMotDePasse, setNouveauMotDePasse] = useState("");
  // Menu « ⋯ » d'actions secondaires, UNE seule carte à la fois (identifiant compte).
  const [menuOuvertId, setMenuOuvertId] = useState<string | null>(null);

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
      // La recherche porte aussi sur les EMPLOYÉS : « Jean » ou « 077… » doivent
      // retrouver la boutique — c'est le nom de la personne, pas le device_id.
      const employes = s.employes ?? [];
      return [
        s.store_name,
        s.owner_name,
        s.account_name,
        s.phone,
        s.location,
        ...employes.map((e) => e.nom),
        ...employes.map((e) => e.telephone),
      ]
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

  /** Suspendre / réactiver une boutique entière (tous ses écrans d'un coup). */
  const handleToggleSuspend = async (s: ShopDetail) => {
    if (s.account_id == null) {
      setError("Cette boutique n'est rattachée à aucun compte : suspendez l'écran depuis sa fiche.");
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

  /** Rattacher un écran à cette boutique (recours quand l'écran n'a pas pu rejoindre). */
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

  /** Révoquer l'accès d'un écran : il quitte la boutique (la fiche est supprimée). */
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

  /** Changer l'abonnement : le montant fixe le nombre de places. */
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

  /** OPTION SUR-MESURE : +N appareils et/ou un prix libre et/ou des jours — pour les
   *  clients généreux, au-delà des paliers. Contrairement au changement de palier,
   *  les appareils s'ADDITIONNENT au quota actuel au lieu de l'écraser. */
  const handleCustom = async () => {
    if (!customPour?.account_id) return;
    const extra = Math.max(0, Math.round(Number(customDevices) || 0));
    const prix = Math.max(0, Math.round(Number(customPrix) || 0));
    const jours = Math.max(0, Math.round(Number(customJours) || 0));
    if (extra === 0 && prix === 0 && jours === 0) {
      setError("Renseigne au moins : +appareils, un prix ou une durée.");
      return;
    }
    setBusy(true);
    try {
      await setAccountCustom(customPour.account_id, {
        extra_devices: extra,
        price_fcfa: prix,
        days: jours,
        reason: "Option sur-mesure depuis la console",
      });
      const morceaux = [
        extra ? `+${extra} écran(s)` : null,
        prix ? `${prix.toLocaleString("fr-FR")} F` : null,
        jours ? `+${jours} j` : null,
      ].filter(Boolean).join(" · ");
      setNotice(`Option sur-mesure appliquée à « ${customPour.account_name || customPour.store_name} » : ${morceaux}.`);
      setCustomPour(null);
      setCustomDevices("");
      setCustomPrix("");
      setCustomJours("");
      await rafraichir();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur.");
    } finally {
      setBusy(false);
    }
  };

  /** Changer le mot de passe du COMPTE (le patron s'est trompé / l'a perdu). */
  const handleChangePassword = async () => {
    if (!accesPour?.account_id || nouveauMotDePasse.trim().length < 6) return;
    setBusy(true);
    try {
      await setAccountPassword(accesPour.account_id, nouveauMotDePasse.trim());
      setNotice(`Mot de passe de « ${accesPour.account_name || accesPour.store_name} » changé.`);
      setNouveauMotDePasse("");
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
          placeholder="Rechercher une boutique, un patron, un téléphone…"
          value={recherche}
          onChange={(e) => setRecherche(e.target.value)}
          style={{ flex: 1, minWidth: 220, maxWidth: 420 }}
          aria-label="Rechercher"
        />
      </div>

      {!ready ? (
        <div className="boutiques-grid">
          {Array.from({ length: 3 }).map((_, i) => (
            <div className="boutique-card" key={i}>
              <div className="skeleton" style={{ height: 22, width: "55%" }} />
              <div className="skeleton" style={{ height: 14, marginTop: 10 }} />
              <div className="skeleton" style={{ height: 60, marginTop: 14 }} />
            </div>
          ))}
        </div>
      ) : shops.length === 0 ? (
        <div className="empty">
          <InboxIcon size={28} />
          <strong>Aucune boutique</strong>
          Les caisses apparaissent ici après leur premier lancement.
        </div>
      ) : visibles.length === 0 ? (
        <div className="empty">
          <InboxIcon size={28} />
          <strong>Aucune boutique ne correspond</strong>
          Change de filtre ou efface la recherche.
        </div>
      ) : (
        /* Une CARTE par boutique : l'enseigne, le patron, et la liste des EMPLOYÉS
           (nom + numéro) plutôt qu'une ligne par écran technique. */
        <div className="boutiques-grid">
          {visibles.map((s: ShopDetail) => {
            const employes = s.employes ?? [];
            return (
              <article className="boutique-card" key={s.account_id ?? s.id}>
                <header className="bc-head">
                  <div className="bc-titre">
                    <strong>{s.store_name || "—"}</strong>
                    <span className="muted">{s.owner_name || "—"}</span>
                  </div>
                  <div className="bc-meta">
                    <span className="bc-compte">
                      {s.nombre_employes ?? employes.length} employé
                      {(s.nombre_employes ?? employes.length) > 1 ? "s" : ""}
                    </span>
                    {statusBadge(s.status)}
                  </div>
                </header>

                <div className="bc-sous-titre">
                  {s.phone ? <span className="mono">{s.phone}</span> : null}
                  {s.plan_name ? <span>{s.plan_name}</span> : null}
                  {s.account_max_devices != null ? (
                    <span className="mono">
                      {s.account_device_count}/{s.account_max_devices} écrans
                    </span>
                  ) : null}
                  <span className="muted">Sync {fmtDateTime(s.last_sync_at)}</span>
                </div>

                <ul className="bc-employes">
                  {employes.map((e) => (
                    <li key={e.device_id} className={e.confirme === false ? "non-confirme" : undefined}>
                      <OnlineDot online={e.en_ligne} />
                      <span className="bc-emp-nom">
                        {e.nom ?? <span className="muted">Écran non déclaré</span>}
                        {e.est_proprietaire && e.nom ? (
                          <span className="badge patron">patron</span>
                        ) : null}
                        {e.confirme === false ? (
                          <span className="badge attente" title="Appairage jamais confirmé — ne compte pas comme employé">
                            non confirmé
                          </span>
                        ) : null}
                      </span>
                      <span className="bc-emp-tel mono">
                        {e.telephone ?? <span className="muted">numéro non déclaré</span>}
                      </span>
                      <span className={`presence ${e.en_ligne ? "on" : ""}`}>
                        <span className={`dot ${e.en_ligne ? "on" : "off"}`} />
                        {e.en_ligne ? "En ligne" : "Hors ligne"}
                      </span>
                      <button
                        className="btn btn-ghost btn-xs"
                        onClick={() => onSelect(e.device_id)}
                        title="Voir la fiche de cet écran"
                      >
                        Fiche
                      </button>
                      <button
                        className="btn btn-ghost btn-xs text-destructive hover:text-destructive"
                        onClick={() => handleDeleteDevice(e.device_id, e.nom ?? e.device_id.slice(0, 8))}
                        disabled={deleting === e.device_id || busy}
                        title="Supprimer cet écran"
                        aria-label={`Supprimer l'écran ${e.nom ?? e.device_id.slice(0, 8)}`}
                      >
                        {deleting === e.device_id ? <HourglassIcon size={13} /> : <TrashIcon size={13} />}
                      </button>
                    </li>
                  ))}
                  {employes.length === 0 && (
                    <li className="muted">Aucun écran actif sur cette boutique.</li>
                  )}
                </ul>

                <footer className="bc-pied bc-actions-footer">
                  {s.account_id != null && (
                    <>
                      <div className="row-actions">
                        {/* Le [+] du cahier des charges : ouvrir une place de plus pour un
                            employé (le prix et la durée restent libres). */}
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={() => {
                            setCustomPour(s);
                            setCustomDevices("1");
                            setCustomPrix("");
                            setCustomJours("");
                          }}
                          disabled={busy}
                          title="Ajouter un employé (une place de plus)"
                        >
                          <PlusIcon size={13} />
                          Ajouter un employé
                        </button>
                        <button
                          className="btn btn-sm"
                          onClick={() => onSelect(s.device_id || employes[0]?.device_id || "")}
                          disabled={!s.device_id && employes.length === 0}
                          title="Voir la fiche détaillée de cette boutique"
                        >
                          Détails
                        </button>
                      </div>
                      {/* Les 4 actions secondaires (abonnement, accès, message,
                          suspension, suppression) vivent dans un menu « ⋯ » — 7 boutons
                          affichés côte à côte ne se lisaient plus (audit design §3). */}
                      <div className="bc-more">
                        {menuOuvertId === String(s.account_id) && (
                          <>
                            <button
                              className="bc-menu-backdrop"
                              aria-label="Fermer le menu"
                              onClick={() => setMenuOuvertId(null)}
                            />
                            <div className="bc-menu" role="menu">
                              <button
                                role="menuitem"
                                className="btn btn-ghost"
                                onClick={() => {
                                  setMenuOuvertId(null);
                                  setPlanPour(s);
                                }}
                                disabled={busy}
                              >
                                <BanknoteIcon size={13} />
                                Gérer l&apos;abonnement
                              </button>
                              <button
                                role="menuitem"
                                className="btn btn-ghost"
                                onClick={() => {
                                  setMenuOuvertId(null);
                                  setAccesPour(s);
                                  setDeviceIdRattache("");
                                }}
                                disabled={busy}
                              >
                                <SmartphoneIcon size={13} />
                                Accès
                              </button>
                              <button
                                role="menuitem"
                                className="btn btn-ghost"
                                onClick={() => {
                                  setMenuOuvertId(null);
                                  setMessagePour(s);
                                  setMessageTexte("");
                                }}
                                disabled={busy}
                              >
                                <SendIcon size={13} />
                                Message au patron
                              </button>
                              <button
                                role="menuitem"
                                className="btn btn-ghost"
                                onClick={() => {
                                  setMenuOuvertId(null);
                                  void handleToggleSuspend(s);
                                }}
                                disabled={busy}
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
                              <button
                                role="menuitem"
                                className="btn btn-ghost text-destructive hover:text-destructive"
                                onClick={() => {
                                  setMenuOuvertId(null);
                                  handleDeleteAccount(s.account_id!, s.account_name || `compte #${s.account_id}`);
                                }}
                                disabled={deleting === `account-${s.account_id}` || busy}
                              >
                                {deleting === `account-${s.account_id}` ? <HourglassIcon size={13} /> : <TrashIcon size={13} />}
                                Supprimer la boutique
                              </button>
                            </div>
                          </>
                        )}
                        <button
                          className="btn btn-ghost btn-icon"
                          aria-label="Autres actions"
                          aria-expanded={menuOuvertId === String(s.account_id)}
                          onClick={() =>
                            setMenuOuvertId(
                              menuOuvertId === String(s.account_id) ? null : String(s.account_id),
                            )
                          }
                        >
                          <span aria-hidden>⋯</span>
                        </button>
                      </div>
                    </>
                  )}
                  {s.account_id == null && (
                    <button className="btn btn-sm" onClick={() => onSelect(s.device_id)}>
                      Détails de l&apos;écran
                    </button>
                  )}
                </footer>
              </article>
            );
          })}
        </div>
      )}

      {/* Gérer les accès : les écrans de la boutique, et le rattachement d'un écran
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
        <hr style={{ margin: "16px 0", border: "none", borderTop: "1px solid var(--border, #ddd)" }} />
        {/* Le compte a SON mot de passe (celui du patron, distinct des codes écran) —
            le support doit pouvoir le réinitialiser. */}
        <label htmlFor="account-password">Changer le mot de passe du compte (min. 6 caractères)</label>
        <input
          id="account-password"
          type="password"
          value={nouveauMotDePasse}
          onChange={(e) => setNouveauMotDePasse(e.target.value)}
          placeholder="Nouveau mot de passe"
          autoComplete="new-password"
        />
        <div className="row-actions" style={{ marginTop: 12 }}>
          <button
            className="btn"
            onClick={() => void handleChangePassword()}
            disabled={busy || nouveauMotDePasse.trim().length < 6}
          >
            Enregistrer le mot de passe
          </button>
        </div>
      </Modal>

      {/* Changer l'abonnement : le montant fixe le nombre de places. */}
      <Modal
        open={planPour !== null}
        onClose={() => setPlanPour(null)}
        title={`Abonnement — ${planPour?.account_name || planPour?.store_name || ""}`}
      >
        <p className="modal-note">
          L&apos;abonnement choisi fixe le nombre de places (écrans) et la durée. L&apos;abonnement en
          cours : {planPour?.plan_name || "aucun"} — {fmtFcfa(planPour?.plan_price_fcfa ?? null)} —
          {" "}
          {planPour?.account_device_count ?? 0}/{planPour?.account_max_devices ?? "?"} écrans.
        </p>
        <div className="tier-chips">
          {ABONNEMENTS.map((p) => (
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

      {/* Option SUR-MESURE / AJOUTER UN ÉCRAN : au-delà des paliers — pour les clients
          généreux. Les appareils s'additionnent au quota ACTUEL (au lieu de l'écraser),
          le prix et la durée sont libres. Laisser à 0 ce qu'on ne veut pas changer. */}
      <Modal
        open={customPour !== null}
        onClose={() => setCustomPour(null)}
        title={`Sur-mesure — ${customPour?.account_name || customPour?.store_name || ""}`}
      >
        <p className="modal-note">
          On ADDITIONNE des appareils au quota actuel ({customPour?.account_device_count ?? 0}/
          {customPour?.account_max_devices ?? "?"} en ce moment), on encaisse le prix qu&apos;on
          veut, on prolonge d&apos;autant de jours. Laisser à 0 ce qui ne change pas.
          <br />
          L&apos;écran lui-même rejoint la boutique avec son code de pairing (ou via « Accès →
          Rattacher ») : ici, on lui ouvre une place.
        </p>
        <label htmlFor="custom-devices">+ Appareils (places en plus)</label>
        <input
          id="custom-devices"
          type="number"
          min={0}
          max={50}
          value={customDevices}
          onChange={(e) => setCustomDevices(e.target.value)}
          placeholder="ex. 1"
        />
        <label htmlFor="custom-prix">Prix encaissé (FCFA — libre)</label>
        <input
          id="custom-prix"
          type="number"
          min={0}
          step={500}
          value={customPrix}
          onChange={(e) => setCustomPrix(e.target.value)}
          placeholder="ex. 15000"
        />
        <label htmlFor="custom-jours">Durée (jours de prolongation)</label>
        <input
          id="custom-jours"
          type="number"
          min={0}
          max={3650}
          value={customJours}
          onChange={(e) => setCustomJours(e.target.value)}
          placeholder="ex. 30"
        />
        <div className="row-actions" style={{ marginTop: 12 }}>
          <button
            className="btn btn-primary"
            onClick={() => void handleCustom()}
            disabled={busy || (!Number(customDevices) && !Number(customPrix) && !Number(customJours))}
          >
            Appliquer
          </button>
          <button className="btn btn-ghost" onClick={() => setCustomPour(null)}>
            <XIcon size={13} />
            Annuler
          </button>
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
