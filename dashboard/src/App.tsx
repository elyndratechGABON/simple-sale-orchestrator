import { useCallback, useEffect, useState, type ReactElement } from "react";
import {
  AuthError,
  clearToken,
  createProject,
  fetchCommandHistory,
  fetchConfig,
  fetchProjects,
  fetchShops,
  getProjectName,
  getScope,
  login as apiLogin,
  sendCommand,
  setProjectPassword,
  subscribeStatus,
  type AdminCommand,
  type Config,
  type Project,
  type Shop,
} from "./api";
import {
  AlertIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  InboxIcon,
  LockIcon,
  LogOutIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  SendIcon,
  StoreIcon,
  XIcon,
} from "./icons";

const fmtDate = (ms: number | null | undefined): string =>
  ms ? new Date(ms).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

const fmtDateTime = (ms: number | null | undefined): string =>
  ms
    ? new Date(ms).toLocaleString("fr-FR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

// Une caisse est « en ligne » si on a eu de ses nouvelles il y a moins de 2 minutes
// (le handshake a lieu chaque minute quand l'app est ouverte).
const ONLINE_WINDOW_MS = 120_000;

function statusBadge(shop: Shop) {
  const cls = shop.status === "active" ? "active" : shop.status === "suspended" ? "suspended" : "expired";
  const label = shop.status === "active" ? "Actif" : shop.status === "suspended" ? "Suspendu" : "Expiré";
  return <span className={`badge ${cls}`}>{label}</span>;
}

function deliveryBadge(cmd: AdminCommand | null): { node: ReactElement; label: string } {
  if (!cmd) return { node: <span className="muted">aucune</span>, label: "aucune" };
  if (cmd.superseded_at)
    return { node: <span className="badge superseded">Remplacée</span>, label: "remplacée" };
  if (cmd.delivered_at)
    return { node: <span className="badge delivered">Récupérée</span>, label: "récupérée" };
  return { node: <span className="badge pending">En attente</span>, label: "en attente" };
}

const actionLabel = (cmd: AdminCommand | null): string =>
  cmd ? { suspend: "Suspension", renew: "Prolongation", broadcast_message: "Message" }[cmd.action_type] : "—";

// ── Connexion ──────────────────────────────────────────────────────────────────────
function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [project, setProject] = useState("");
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await apiLogin(password, project.trim() || undefined);
      onLogin();
    } catch (err) {
      setError(err instanceof AuthError ? "Connexion requise." : "Projet ou mot de passe incorrect.");
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">
          <span className="rail-logo">
            <StoreIcon size={18} />
          </span>
          <h1>Orchestrateur</h1>
        </div>
        <p className="lead">Console d'administration des caisses.</p>
        <label htmlFor="login-project">Projet (vide = administrateur)</label>
        <input
          id="login-project"
          value={project}
          onChange={(e) => setProject(e.target.value)}
          placeholder="pos, resto-yaounde…"
          autoFocus
          autoComplete="off"
        />
        <label htmlFor="login-password">Mot de passe</label>
        <input
          id="login-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
        />
        <button className="btn btn-primary" type="submit" disabled={!password}>
          Se connecter
        </button>
        {error && <div className="error">{error}</div>}
      </form>
    </div>
  );
}

// ── Ligne client ──────────────────────────────────────────────────────────────────
function ShopRow({
  shop,
  lastSeen,
  present,
  onExtend,
  onSuspend,
  onMessage,
}: {
  shop: Shop;
  lastSeen: number | null;
  present: boolean;
  onExtend: (shop: Shop) => void;
  onSuspend: (shop: Shop) => void;
  onMessage: (shop: Shop) => void;
}) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<AdminCommand[] | null>(null);

  const toggle = async () => {
    setOpen((v) => {
      if (v) return false;
      fetchCommandHistory(shop.device_id)
        .then((r) => setHistory(r.commands))
        .catch(() => setHistory([]));
      return true;
    });
  };

  return (
    <>
      <tr>
        <td>
          <button className="expand-btn" onClick={toggle} title={open ? "Réduire" : "Historique"} aria-label="Historique">
            {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </button>
        </td>
        <td className="cell-store">
          <strong>{shop.store_name || "—"}</strong>
          <div className="meta">{shop.owner_name}</div>
        </td>
        <td className="cell-device">
          <span className="mono">{shop.device_id}</span>
          <div className="meta">projet : {shop.app_origin || "pos"}</div>
        </td>
        <td>{statusBadge(shop)}</td>
        <td className="mono">{fmtDate(shop.expiry_date)}</td>
        <td className="mono">{fmtDateTime(lastSeen)}</td>
        <td>
          <span className={`presence ${present ? "on" : ""}`}>
            <span className={`dot ${present ? "on" : "off"}`} />
            {present ? "En ligne" : "Hors ligne"}
          </span>
        </td>
        <td className="mono">{shop.app_version_used ?? "—"}</td>
        <td>
          <span className="muted">{actionLabel(shop.last_command)}</span> {deliveryBadge(shop.last_command).node}
        </td>
        <td>
          <div className="row-actions">
            {shop.status === "active" ? (
              <button className="btn btn-sm btn-danger" onClick={() => onSuspend(shop)}>
                Suspendre
              </button>
            ) : (
              <button className="btn btn-sm" onClick={() => onExtend(shop)}>
                Relancer
              </button>
            )}
            <button className="btn btn-sm" onClick={() => onExtend(shop)}>
              Prolonger
            </button>
            <button className="btn btn-sm" onClick={() => onMessage(shop)}>
              Message
            </button>
          </div>
        </td>
      </tr>
      {open && (
        <tr className="detail-row">
          <td colSpan={10}>
            <div className="history">
              <h3>Commandes récentes</h3>
              {!history ? (
                <div className="muted">Chargement…</div>
              ) : history.length === 0 ? (
                <div className="muted">Aucune commande.</div>
              ) : (
                history.map((c) => (
                  <div className="history-item" key={c.id}>
                    <span>{actionLabel(c)}</span>
                    <span className="muted mono">le {fmtDate(c.created_at)}</span>
                    {c.payload.days != null && <span className="muted">+{c.payload.days} j</span>}
                    {c.payload.message_text && <span className="muted">« {c.payload.message_text} »</span>}
                    {deliveryBadge(c).node}
                  </div>
                ))
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Rail latéral : projets, changement en un clic ────────────────────────────────
function Rail({
  scope,
  projectName,
  projects,
  activeProject,
  onSelect,
  onCreate,
  onEditPw,
  onLogout,
}: {
  scope: "master" | "project";
  projectName: string;
  projects: Project[];
  activeProject: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (id: string, name: string, password: string) => Promise<boolean>;
  onEditPw: (project: Project) => void;
  onLogout: () => void;
}) {
  const [showCreate, setShowCreate] = useState(false);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    const ok = await onCreate(id.trim(), name.trim(), password);
    setBusy(false);
    if (ok) {
      setId("");
      setName("");
      setPassword("");
      setShowCreate(false);
    }
  };

  return (
    <aside className="rail">
      <div className="rail-brand">
        <span className="rail-logo">
          <StoreIcon size={17} />
        </span>
        <div>
          <strong>Orchestrateur</strong>
          <div className="scope">{scope === "master" ? "Administrateur" : `Projet « ${projectName} »`}</div>
        </div>
      </div>

      <nav className="rail-section" aria-label="Projets">
        <div className="rail-label">Projets</div>
        {scope === "master" && (
          <button
            className={`rail-item ${activeProject === null ? "active" : ""}`}
            onClick={() => onSelect(null)}
            title="Toutes les caisses"
          >
            <FolderIcon size={16} />
            Toutes les caisses
            <span className="count">{projects.reduce((n, p) => n + p.shop_count, 0)}</span>
          </button>
        )}
        {projects.map((p) => (
          <div key={p.id} className={`rail-item ${activeProject === p.id ? "active" : ""}`}>
            <button className="rail-main" onClick={() => onSelect(p.id)} title={p.name}>
              <FolderIcon size={16} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
              <span className="count">{p.shop_count}</span>
            </button>
            {scope === "master" && (
              <button
                className="edit"
                onClick={() => onEditPw(p)}
                title="Changer le mot de passe"
                aria-label={`Changer le mot de passe de ${p.name}`}
              >
                <LockIcon size={14} />
              </button>
            )}
          </div>
        ))}
        {scope === "master" && (
          <div className="rail-create">
            {!showCreate ? (
              <button className="rail-item" onClick={() => setShowCreate(true)}>
                <PlusIcon size={16} />
                Nouveau projet
              </button>
            ) : (
              <form onSubmit={submit}>
                <input value={id} onChange={(e) => setId(e.target.value)} placeholder="id (ex. resto-yaounde)" autoFocus />
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom" />
                <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Mot de passe" />
                <div className="row">
                  <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !id.trim() || !name.trim() || !password.trim()}>
                    Créer
                  </button>
                  <button className="btn btn-sm" type="button" onClick={() => setShowCreate(false)}>
                    Annuler
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </nav>

      <div className="rail-footer">
        <span className="chip">
          {scope === "master" ? "Administrateur" : projectName}
        </span>
        <button className="btn btn-ghost btn-icon" onClick={onLogout} title="Déconnexion" aria-label="Déconnexion">
          <LogOutIcon size={16} />
        </button>
      </div>
    </aside>
  );
}

// ── Modales (dialogues) ───────────────────────────────────────────────────────────
type DialogState =
  | { type: "extend"; shop: Shop }
  | { type: "message"; shop: Shop }
  | { type: "pw"; project: Project };

function App() {
  const [token, setToken] = useState(() => localStorage.getItem("orch_admin_token"));
  const scope = getScope();
  const projectName = getProjectName();
  const [config, setConfig] = useState<Config | null>(null);
  const [shops, setShops] = useState<Shop[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [filter, setFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [extendDays, setExtendDays] = useState(30);
  const [messageText, setMessageText] = useState("");
  const [pwInput, setPwInput] = useState("");
  const [notice, setNotice] = useState("");
  const [online, setOnline] = useState<Record<string, number>>({});
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [cfg, shopsRes] = await Promise.all([
        fetchConfig(),
        fetchShops(scope === "master" && projectFilter ? projectFilter : undefined),
      ]);
      setConfig(cfg);
      setShops(shopsRes.shops);
      if (scope === "master") {
        const { projects: proj } = await fetchProjects();
        setProjects(proj);
      }
      setError("");
      setReady(true);
    } catch (err) {
      if (err instanceof AuthError) {
        clearToken();
        setToken(null);
      } else {
        setError("Impossible de contacter le backend.");
      }
    }
  }, [scope, projectFilter]);

  useEffect(() => {
    if (!token) return;
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [token, refresh]);

  // SSE temps réel : chaque handshake d'une caisse met à jour sa présence sans recharger.
  useEffect(() => {
    if (!token) return;
    return subscribeStatus((evt) => {
      setOnline((prev) => ({ ...prev, [evt.device_id]: evt.last_seen }));
    });
  }, [token]);

  if (!token) return <Login onLogin={() => setToken(localStorage.getItem("orch_admin_token"))} />;

  const lastSeenOf = (s: Shop): number | null => Math.max(online[s.device_id] ?? 0, s.last_sync_at ?? 0) || null;
  const presentOf = (s: Shop): boolean => {
    const t = lastSeenOf(s);
    return t != null && Date.now() - t < ONLINE_WINDOW_MS;
  };

  const expiredCount = shops.filter((s) => s.expired_commands > 0).length;
  const onlineCount = shops.filter(presentOf).length;
  const activeCount = shops.filter((s) => s.status === "active").length;
  const activeProject = scope === "project" ? projectName : projectFilter;
  const title = scope === "project" ? projectName : activeProject || "Toutes les caisses";

  const filtered = shops.filter((s) =>
    [s.store_name, s.owner_name, s.device_id, s.phone ?? "", s.app_origin ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    setNotice("");
    try {
      await fn();
      setNotice(msg);
      await refresh();
      setDialog(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur.");
    } finally {
      setBusy(false);
    }
  };

  const submitDialog = () => {
    if (!dialog) return;
    if (dialog.type === "extend") {
      run(() => sendCommand(dialog.shop.device_id, { action_type: "renew", days: extendDays }), "Prolongation envoyée.");
    } else if (dialog.type === "message") {
      run(
        () => sendCommand(dialog.shop.device_id, { action_type: "broadcast_message", message: messageText }),
        "Message envoyé.",
      );
    } else {
      run(() => setProjectPassword(dialog.project.id, pwInput.trim()), "Mot de passe modifié.");
    }
  };

  const suspend = (shop: Shop) =>
    run(() => sendCommand(shop.device_id, { action_type: "suspend" }), "Suspension envoyée.");

  const logout = () => {
    clearToken();
    setToken(null);
  };

  const createProjectFn = async (id: string, name: string, password: string): Promise<boolean> => {
    try {
      await createProject(id, name, password);
      setNotice(`Projet « ${name} » créé.`);
      await refresh();
      setError("");
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur.");
      return false;
    }
  };

  const dialogSub = dialog?.type === "pw" ? dialog.project : null;
  return (
    <div className="shell">
      <Rail
        scope={scope}
        projectName={projectName}
        projects={projects}
        activeProject={scope === "project" ? projectName : projectFilter || null}
        onSelect={(id) => setProjectFilter(id ?? "")}
        onCreate={createProjectFn}
        onEditPw={(p) => {
          setPwInput("");
          setDialog({ type: "pw", project: p });
        }}
        onLogout={logout}
      />

      <div className="main">
        <header className="topbar">
          <div className="grow">
            <h1>{title}</h1>
            <div className="sub">
              {config
                ? `${config.price_per_month_fcfa.toLocaleString("fr-FR")} FCFA / mois · ${config.trial_days} j d'essai · ${shops.length} caisse${shops.length > 1 ? "s" : ""}`
                : "…"}
            </div>
          </div>
          <div className="search">
            <SearchIcon size={15} />
            <input
              type="search"
              placeholder="Rechercher…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Rechercher une caisse"
            />
          </div>
          <span className="live" title="Temps réel via SSE">
            <span className="dot" style={{ background: onlineCount > 0 ? undefined : "var(--muted)" }} />
            {onlineCount > 0 ? `${onlineCount} en ligne` : "Aucun en ligne"}
          </span>
          <button className="btn" onClick={refresh} disabled={busy} aria-label="Actualiser">
            <RefreshIcon size={15} />
            Actualiser
          </button>
        </header>

        <main className="content">
          {error && (
            <div className="alert-banner">
              <AlertIcon size={15} />
              {error}
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
          {expiredCount > 0 && (
            <div className="alert-banner">
              <AlertIcon size={15} />
              {expiredCount} client{expiredCount > 1 ? "s" : ""} n'ont pas récupéré une commande qui a expiré (nouvelle connexion nécessaire).
            </div>
          )}

          <div className="stats" aria-label="Vue d'ensemble">
            <div className="stat">
              <div className="k">Caisses</div>
              <div className="v">{shops.length}</div>
            </div>
            <div className="stat">
              <div className="k">En ligne</div>
              <div className="v ok">{onlineCount}</div>
            </div>
            <div className="stat">
              <div className="k">Actives</div>
              <div className="v">{activeCount}</div>
            </div>
            <div className="stat">
              <div className="k">En attente</div>
              <div className="v warn">{expiredCount}</div>
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th></th>
                  <th>Boutique</th>
                  <th>Device</th>
                  <th>Statut</th>
                  <th>Expire le</th>
                  <th>Dernière synchro</th>
                  <th>En ligne</th>
                  <th>Version</th>
                  <th>Dernière commande</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {!ready &&
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr className="skeleton-row" key={i}>
                      {Array.from({ length: 10 }).map((_, j) => (
                        <td key={j}>
                          <div className="skeleton" />
                        </td>
                      ))}
                    </tr>
                  ))}
                {ready &&
                  filtered.map((shop) => {
                    const lastSeen = lastSeenOf(shop);
                    return (
                      <ShopRow
                        key={shop.id}
                        shop={shop}
                        lastSeen={lastSeen}
                        present={presentOf(shop)}
                        onExtend={(s) => {
                          setExtendDays(30);
                          setDialog({ type: "extend", shop: s });
                        }}
                        onSuspend={(s) => suspend(s)}
                        onMessage={(s) => {
                          setMessageText("");
                          setDialog({ type: "message", shop: s });
                        }}
                      />
                    );
                  })}
                {ready && filtered.length === 0 && (
                  <tr>
                    <td colSpan={10}>
                      <div className="empty">
                        <InboxIcon size={28} />
                        <strong>Aucune caisse</strong>
                        Une caisse apparaît dès son premier handshake — ouvrez l'application sur un poste.
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </main>
      </div>

      {dialog && (
        <div className="modal-backdrop" onClick={() => !busy && setDialog(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            {dialog.type === "extend" && (
              <>
                <h2>{dialog.shop.status === "suspended" || dialog.shop.status === "expired" ? "Relancer" : "Prolonger"}</h2>
                <div className="sub">
                  {dialog.shop.store_name} · expire le {fmtDate(dialog.shop.expiry_date)}
                </div>
                <label htmlFor="extend-days">Nombre de jours à ajouter</label>
                <input
                  id="extend-days"
                  type="number"
                  min={1}
                  value={extendDays}
                  onChange={(e) => setExtendDays(Number(e.target.value))}
                />
                <div className="buttons">
                  <button className="btn" onClick={() => setDialog(null)} disabled={busy}>
                    Annuler
                  </button>
                  <button className="btn btn-primary" onClick={submitDialog} disabled={busy || !extendDays}>
                    Envoyer
                  </button>
                </div>
              </>
            )}
            {dialog.type === "message" && (
              <>
                <h2>Envoyer un message</h2>
                <div className="sub">{dialog.shop.store_name}</div>
                <label htmlFor="msg-text">Message (s'affiche dans la caisse après récupération)</label>
                <textarea
                  id="msg-text"
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                  maxLength={500}
                />
                <div className="buttons">
                  <button className="btn" onClick={() => setDialog(null)} disabled={busy}>
                    Annuler
                  </button>
                  <button className="btn btn-primary" onClick={submitDialog} disabled={busy || !messageText.trim()}>
                    <SendIcon size={14} />
                    Envoyer
                  </button>
                </div>
              </>
            )}
            {dialog.type === "pw" && dialogSub && (
              <>
                <h2>Mot de passe du projet</h2>
                <div className="sub">« {dialogSub.name} » — les sessions en cours seront conservées.</div>
                <label htmlFor="pw-input">Nouveau mot de passe</label>
                <input
                  id="pw-input"
                  type="text"
                  value={pwInput}
                  onChange={(e) => setPwInput(e.target.value)}
                  autoFocus
                />
                <div className="buttons">
                  <button className="btn" onClick={() => setDialog(null)} disabled={busy}>
                    Annuler
                  </button>
                  <button className="btn btn-primary" onClick={submitDialog} disabled={busy || !pwInput.trim()}>
                    <LockIcon size={14} />
                    Modifier
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
