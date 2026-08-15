import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import {
  AuthError,
  clearToken,
  createProject,
  fetchCommandHistory,
  fetchConfig,
  fetchPayments,
  fetchProjects,
  fetchPublicProjects,
  fetchShops,
  fetchStats,
  getProjectId,
  getProjectName,
  getScope,
  login as apiLogin,
  sendCommand,
  setProjectConfig,
  setProjectPassword,
  subscribeStatus,
  type AdminCommand,
  type Config,
  type Payment,
  type Project,
  type Shop,
  type ShopStats,
  type Stats,
} from "./api";
import {
  AlertIcon,
  BanknoteIcon,
  CalendarIcon,
  ChartIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  InboxIcon,
  LockIcon,
  LogOutIcon,
  MoonIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  SendIcon,
  StoreIcon,
  SunIcon,
  TrendingUpIcon,
  WalletIcon,
  XIcon,
} from "./icons";

const fmtDate = (ms: number | null | undefined): string =>
  ms ? new Date(ms).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

const fmtDateShort = (ms: number): string =>
  new Date(ms).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });

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

const fmtFcfa = (n: number | null | undefined): string =>
  n == null ? "—" : `${Math.round(n).toLocaleString("fr-FR")} FCFA`;

const DAY_MS = 86_400_000;
const daysLeftOf = (shop: Shop, now: number): number => Math.ceil((shop.expiry_date - now) / DAY_MS);

// Une caisse est « en ligne » si on a eu de ses nouvelles il y a moins de 2 minutes.
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
  const [known, setKnown] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState("");

  // Liste publique des projets : l'utilisateur choisit ou tape l'id d'un projet non encore créé.
  useEffect(() => {
    fetchPublicProjects()
      .then((r) => setKnown(r.projects))
      .catch(() => {});
  }, []);

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
        <p className="lead">Console d'administration des abonnements et des caisses.</p>
        <label htmlFor="login-project">Projet (vide = administrateur)</label>
        <input
          id="login-project"
          list="known-projects"
          value={project}
          onChange={(e) => setProject(e.target.value)}
          placeholder="Caisse, resto-yaounde…"
          autoFocus
          autoComplete="off"
        />
        <datalist id="known-projects">
          {known.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </datalist>
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

// ── Échéance d'abonnement : barre de progression + compte à rebours ────────────────
function ExpiryBar({ shop, now }: { shop: Shop; now: number }) {
  const span = shop.expiry_date - shop.registration_date;
  const pct = span > 0 ? Math.max(0, Math.min(100, ((shop.expiry_date - now) / span) * 100)) : 100;
  const d = daysLeftOf(shop, now);
  const cls =
    shop.status === "expired"
      ? "expired"
      : shop.status === "suspended"
        ? "suspended"
        : d <= 7
          ? "expiring"
          : d <= 30
            ? "warning"
            : "ok";
  const label =
    shop.status === "expired"
      ? "expiré"
      : shop.status === "suspended"
        ? "suspendu"
        : d <= 1
          ? "J-1"
          : `J-${d}`;
  return (
    <div className="expiry">
      <div className="expiry-head">
        <span className={`expiry-label ${cls}`}>{label}</span>
      </div>
      <div className="expiry-bar">
        <div className={`expiry-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ── Graphique CA / bénéfice des 7 derniers jours (SVG, zéro dépendance) ────────────
function RevenueChart({ points }: { points: { day: number; revenue: number; profit: number; sales: number }[] }) {
  if (points.length === 0)
    return (
      <div className="chart-empty">
        <ChartIcon size={22} />
        Aucune donnée sur 7 jours — la caisse doit synchroniser.
      </div>
    );
  const W = 640;
  const H = 200;
  const PAD = 8;
  const max = Math.max(1, ...points.map((p) => Math.max(p.revenue, p.profit)));
  const step = points.length > 1 ? (W - PAD * 2) / (points.length - 1) : 0;
  const x = (i: number) => PAD + i * step;
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
  const line = (key: "revenue" | "profit") =>
    points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  const area = `M${x(0)},${H - PAD} ${line("revenue").slice(1)} L${x(points.length - 1)},${H - PAD} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Chiffre d'affaires et bénéfice des 7 derniers jours">
      <defs>
        <linearGradient id="rev-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {points.map((_, i) => (
        <g key={i}>
          <line x1={x(i)} y1={PAD} x2={x(i)} y2={H - PAD} stroke="var(--border)" strokeDasharray="2 4" />
          <text x={x(i)} y={H - 0} fontSize="10" fill="var(--muted)" textAnchor="middle" transform={`translate(0,10)`}>
            {fmtDateShort(points[i].day)}
          </text>
        </g>
      ))}
      <path d={area} fill="url(#rev-fill)" />
      <path d={line("revenue")} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" />
      <path d={line("profit")} fill="none" stroke="var(--ok)" strokeWidth="1.75" strokeLinejoin="round" strokeDasharray="4 3" />
      {points.map((p, i) => (
        <g key={`dot-${i}`}>
          <circle cx={x(i)} cy={y(p.revenue)} r="2.6" fill="var(--accent)" />
          <circle cx={x(i)} cy={y(p.profit)} r="2.4" fill="var(--ok)" />
        </g>
      ))}
    </svg>
  );
}

// ── Top produits en barres horizontales ────────────────────────────────────────────
function TopProductsBars({ products }: { products: { name: string; quantity: number; revenue: number }[] }) {
  if (products.length === 0)
    return (
      <div className="chart-empty">
        <InboxIcon size={22} />
        Aucun produit — la caisse doit synchroniser.
      </div>
    );
  const max = Math.max(1, ...products.map((p) => p.revenue));
  return (
    <div className="bars">
      {products.map((p) => (
        <div className="bar-row" key={p.name} title={`${p.name} — ×${p.quantity}`}>
          <span className="bar-name">{p.name}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(p.revenue / max) * 100}%` }} />
          </div>
          <span className="bar-value mono">{fmtFcfa(p.revenue)}</span>
        </div>
      ))}
    </div>
  );
}

// ── Ligne client ──────────────────────────────────────────────────────────────────
function ShopRow({
  shop,
  stats,
  lastSeen,
  present,
  price,
  now,
  onExtend,
  onSuspend,
  onMessage,
}: {
  shop: Shop;
  stats?: ShopStats;
  lastSeen: number | null;
  present: boolean;
  price: number;
  now: number;
  onExtend: (shop: Shop) => void;
  onSuspend: (shop: Shop) => void;
  onMessage: (shop: Shop) => void;
}) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<AdminCommand[] | null>(null);
  const [payments, setPayments] = useState<Payment[] | null>(null);

  const toggle = async () => {
    setOpen((v) => {
      if (v) return false;
      fetchCommandHistory(shop.device_id)
        .then((r) => setHistory(r.commands))
        .catch(() => setHistory([]));
      fetchPayments(shop.device_id)
        .then((r) => setPayments(r.payments))
        .catch(() => setPayments([]));
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
        <td className="cell-expiry">
          <span className="mono">{fmtDate(shop.expiry_date)}</span>
          <ExpiryBar shop={shop} now={now} />
        </td>
        <td className="mono">{fmtDateTime(lastSeen)}</td>
        <td>
          <span className={`presence ${present ? "on" : ""}`}>
            <span className={`dot ${present ? "on" : "off"}`} />
            {present ? "En ligne" : "Hors ligne"}
          </span>
        </td>
        <td className="mono">{stats ? fmtFcfa(stats.totals.revenue) : "—"}</td>
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
          <td colSpan={11}>
            {stats && (
              <div className="history">
                <h3>Activité 7 jours (données réelles)</h3>
                <div className="history-item">
                  <strong>{stats.store_name}</strong>
                  <span className="muted mono">
                    CA {fmtFcfa(stats.totals.revenue)} · bénéfice {fmtFcfa(stats.totals.profit)} ·{" "}
                    {stats.totals.sales} vente{stats.totals.sales > 1 ? "s" : ""} · {stats.totals.items} article
                    {stats.totals.items > 1 ? "s" : ""}
                  </span>
                </div>
                {stats.top_products.length > 0 && (
                  <div className="history">
                    <h3>Top produits</h3>
                    {stats.top_products.map((p) => (
                      <div className="history-item" key={p.name}>
                        <span>{p.name}</span>
                        <span className="muted mono">
                          × {p.quantity} · {fmtFcfa(p.revenue)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="history">
              <h3>Paiements ({payments == null ? "…" : payments.length})</h3>
              {!payments ? (
                <div className="muted">Chargement…</div>
              ) : payments.length === 0 ? (
                <div className="muted">Aucun paiement enregistré.</div>
              ) : (
                payments.map((p) => (
                  <div className="history-item" key={p.id}>
                    <BanknoteIcon size={14} />
                    <span className="mono">{fmtFcfa(p.amount)}</span>
                    <span className="muted">+{p.days_added} j</span>
                    <span className="muted">le {fmtDate(p.created_at)}</span>
                  </div>
                ))
              )}
            </div>
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
                    {c.payload.amount_fcfa != null && <span className="muted mono">{fmtFcfa(c.payload.amount_fcfa)}</span>}
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
  onEditCfg,
  onLogout,
}: {
  scope: "master" | "project";
  projectName: string;
  projects: Project[];
  activeProject: string | null;
  onSelect: (id: string | null) => void;
  onCreate: (id: string, name: string, password: string, type?: string, price?: number, trial?: number) => Promise<boolean>;
  onEditPw: (project: Project) => void;
  onEditCfg: (project: Project) => void;
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
              <>
                <button
                  className="edit"
                  onClick={() => onEditCfg(p)}
                  title={`Tarif ${p.price_per_month_fcfa != null ? fmtFcfa(p.price_per_month_fcfa) + "/mois" : "—"}`}
                  aria-label={`Tarif et essai de ${p.name}`}
                >
                  <WalletIcon size={14} />
                </button>
                <button
                  className="edit"
                  onClick={() => onEditPw(p)}
                  title="Changer le mot de passe"
                  aria-label={`Changer le mot de passe de ${p.name}`}
                >
                  <LockIcon size={14} />
                </button>
              </>
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
  | { type: "pw"; project: Project }
  | { type: "cfg"; project: Project };

function App() {
  const [token, setToken] = useState(() => localStorage.getItem("orch_admin_token"));
  const scope = getScope();
  const projectName = getProjectName();
  const [config, setConfig] = useState<Config | null>(null);
  const [shops, setShops] = useState<Shop[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [filter, setFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [extendMode, setExtendMode] = useState<"days" | "amount">("days");
  const [extendDays, setExtendDays] = useState(30);
  const [extendAmount, setExtendAmount] = useState(10000);
  const [messageText, setMessageText] = useState("");
  const [pwInput, setPwInput] = useState("");
  const [cfgType, setCfgType] = useState("");
  const [cfgPrice, setCfgPrice] = useState(10000);
  const [cfgTrial, setCfgTrial] = useState(30);
  const [notice, setNotice] = useState("");
  const [online, setOnline] = useState<Record<string, number>>({});
  const [ready, setReady] = useState(false);
  const [newShops, setNewShops] = useState<Shop[]>([]);
  const [expiryDismissed, setExpiryDismissed] = useState(false);
  const [dark, setDark] = useState(() => localStorage.getItem("orch_dark") === "1");
  const knownShops = useRef<Set<string>>(new Set());
  const loadedOnce = useRef(false);
  const notifiedExpiring = useRef<Set<string>>(new Set());

  // Mode sombre : l'attribut sur <html> prime sur prefers-color-scheme.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "auto");
    localStorage.setItem("orch_dark", dark ? "1" : "0");
  }, [dark]);

  // Notification navigateur : prévenir à chaque nouvelle boutique enregistrée.
  const notifyNewShop = (s: Shop) => {
    if (!("Notification" in window)) return;
    const body = `${s.store_name} — ${s.owner_name}${s.phone ? ` · ${s.phone}` : ""}`;
    if (Notification.permission === "granted") {
      new Notification("Nouvelle boutique enregistrée", { body, tag: s.device_id });
    }
  };

  const activeProjectId = scope === "project" ? getProjectId() || null : projectFilter || null;

  const refresh = useCallback(async () => {
    try {
      const [cfg, shopsRes, statsRes] = await Promise.all([
        fetchConfig(activeProjectId ?? undefined),
        fetchShops(activeProjectId ?? undefined),
        fetchStats(activeProjectId ?? undefined),
      ]);
      setConfig(cfg);
      setShops(shopsRes.shops);
      setStats(statsRes);
      if (scope === "master") {
        const { projects: proj } = await fetchProjects();
        setProjects(proj);
      }
      setError("");
      setReady(true);
      const seen = new Set(shopsRes.shops.map((s) => s.device_id));
      if (loadedOnce.current) {
        const fresh = shopsRes.shops.filter((s) => !knownShops.current.has(s.device_id));
        if (fresh.length > 0) {
          setNewShops((prev) => [...fresh, ...prev]);
          for (const s of fresh) notifyNewShop(s);
        }
      }
      loadedOnce.current = true;
      knownShops.current = seen;

      // Alertes d'échéance : notifier une fois par caisse active qui expire sous 7 jours.
      const now = Date.now();
      const activeIds = new Set(shopsRes.shops.filter((s) => s.status === "active").map((s) => s.device_id));
      for (const k of [...notifiedExpiring.current]) if (!activeIds.has(k)) notifiedExpiring.current.delete(k);
      const expiring = shopsRes.shops.filter(
        (s) => s.status === "active" && daysLeftOf(s, now) <= 7 && !notifiedExpiring.current.has(s.device_id),
      );
      if (expiring.length > 0) {
        for (const s of expiring) notifiedExpiring.current.add(s.device_id);
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification("Abonnement qui expire", {
            body: expiring.map((s) => `${s.store_name} (${fmtDate(s.expiry_date)})`).join(" · "),
          });
        }
      }
    } catch (err) {
      if (err instanceof AuthError) {
        clearToken();
        setToken(null);
      } else {
        setError("Impossible de contacter le backend.");
      }
    }
  }, [scope, activeProjectId]);

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

  // Demande l'autorisation de notifications une fois connecté.
  useEffect(() => {
    if (!token) return;
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, [token]);

  // La bannière « nouvelle boutique » disparaît seule.
  useEffect(() => {
    if (newShops.length === 0) return;
    const t = setTimeout(() => setNewShops([]), 15_000);
    return () => clearTimeout(t);
  }, [newShops]);

  // La bannière « expirent sous 7 jours » revient si la liste des caisses concernées change.
  const now = Date.now();
  const expiringSoon = shops.filter((s) => s.status === "active" && daysLeftOf(s, now) <= 7);
  const expiringKey = expiringSoon.map((s) => s.device_id).sort().join(",");
  useEffect(() => setExpiryDismissed(false), [expiringKey]);

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
  const sub = shops.length === 0 && !ready ? "…" : `${shops.length} caisse${shops.length > 1 ? "s" : ""}`;
  const price = config?.price_per_month_fcfa ?? 10_000;
  const subs = stats?.subscriptions ?? {
    total: shops.length,
    active: activeCount,
    suspended: shops.length - activeCount - shops.filter((s) => s.status === "expired").length,
    expired: shops.filter((s) => s.status === "expired").length,
    online: onlineCount,
    expiring_7d: expiringSoon.length,
    expiring_30d: shops.filter((s) => s.status === "active" && daysLeftOf(s, now) <= 30).length,
    mrr_fcfa: activeCount * price,
  };

  const filtered = shops.filter((s) =>
    [s.store_name, s.owner_name, s.device_id, s.phone ?? "", s.app_origin ?? ""]
      .join(" ")
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );

  const shopStatsOf = new Map((stats?.shops ?? []).map((s) => [s.device_id, s]));

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
      const renewBody =
        extendMode === "amount"
          ? { action_type: "renew" as const, amount_fcfa: extendAmount }
          : { action_type: "renew" as const, days: extendDays };
      run(() => sendCommand(dialog.shop.device_id, renewBody), "Prolongation envoyée.");
    } else if (dialog.type === "message") {
      run(
        () => sendCommand(dialog.shop.device_id, { action_type: "broadcast_message", message: messageText }),
        "Message envoyé.",
      );
    } else if (dialog.type === "pw") {
      run(() => setProjectPassword(dialog.project.id, pwInput.trim()), "Mot de passe modifié.");
    } else {
      run(
        () =>
          setProjectConfig(dialog.project.id, {
            type: cfgType.trim() || undefined,
            price_per_month_fcfa: cfgPrice > 0 ? cfgPrice : undefined,
            trial_days: cfgTrial > 0 ? cfgTrial : undefined,
          }),
        "Tarif du projet mis à jour.",
      );
    }
  };

  const suspend = (shop: Shop) =>
    run(() => sendCommand(shop.device_id, { action_type: "suspend" }), "Suspension envoyée.");

  const logout = () => {
    clearToken();
    setToken(null);
  };

  const createProjectFn = async (
    id: string,
    name: string,
    password: string,
    type?: string,
    cprice?: number,
    ctrial?: number,
  ): Promise<boolean> => {
    try {
      await createProject(id, name, password, type, cprice, ctrial);
      setNotice(`Projet « ${name} » créé.`);
      await refresh();
      setError("");
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur.");
      return false;
    }
  };

  const daysFromAmount = (amount: number): number =>
    price > 0 ? Math.max(1, Math.round((amount / price) * 30)) : 0;

  const dialogSub = dialog?.type === "pw" || dialog?.type === "cfg" ? dialog.project : null;
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
        onEditCfg={(p) => {
          setCfgType(p.type ?? "");
          setCfgPrice(p.price_per_month_fcfa ?? price);
          setCfgTrial(p.trial_days ?? 30);
          setDialog({ type: "cfg", project: p });
        }}
        onLogout={logout}
      />

      <div className="main">
        <header className="topbar">
          <div className="grow">
            <h1>{title}</h1>
            <div className="sub">
              {config
                ? `${fmtFcfa(price)} / mois · ${config.trial_days} j d'essai · ${sub}`
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
          <button
            className="btn btn-icon"
            onClick={() => setDark((d) => !d)}
            title={dark ? "Mode clair" : "Mode sombre"}
            aria-label={dark ? "Passer en mode clair" : "Passer en mode sombre"}
          >
            {dark ? <SunIcon size={15} /> : <MoonIcon size={15} />}
          </button>
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
          {newShops.length > 0 && (
            <div className="alert-banner new-shop">
              <StoreIcon size={15} />
              <span>
                {newShops.length} nouvelle{newShops.length > 1 ? "s" : ""} boutique{newShops.length > 1 ? "s" : ""}{" "}
                enregistrée{newShops.length > 1 ? "s" : ""} : {newShops.map((s) => `${s.store_name} (${s.owner_name})`).join(", ")}
              </span>
              <button className="btn btn-ghost btn-sm" onClick={() => setNewShops([])} style={{ marginLeft: "auto" }}>
                <XIcon size={13} />
              </button>
            </div>
          )}
          {expiringSoon.length > 0 && !expiryDismissed && (
            <div className="alert-banner warn">
              <CalendarIcon size={15} />
              <span>
                {expiringSoon.length} abonnement{expiringSoon.length > 1 ? "s" : ""} expire{expiringSoon.length > 1 ? "nt" : ""} sous 7
                jours : {expiringSoon.map((s) => `${s.store_name} (J-${daysLeftOf(s, now)})`).join(", ")}
              </span>
              <button className="btn btn-ghost btn-sm" onClick={() => setExpiryDismissed(true)} style={{ marginLeft: "auto" }}>
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

          <div className="stats" aria-label="Abonnements">
            <div className="stat">
              <div className="k">Caisses</div>
              <div className="v">{subs.total}</div>
            </div>
            <div className="stat">
              <div className="k">Actives</div>
              <div className="v ok">{subs.active}</div>
            </div>
            <div className="stat">
              <div className="k">En ligne</div>
              <div className="v">{subs.online}</div>
            </div>
            <div className="stat">
              <div className="k">Suspendues</div>
              <div className="v warn">{subs.suspended}</div>
            </div>
            <div className="stat">
              <div className="k">Expirées</div>
              <div className="v danger">{subs.expired}</div>
            </div>
            <div className="stat">
              <div className="k">Expirent ≤ 30 j</div>
              <div className="v">{subs.expiring_30d}</div>
            </div>
            <div className="stat">
              <div className="k">MRR estimé</div>
              <div className="v accent">{fmtFcfa(subs.mrr_fcfa)}</div>
            </div>
          </div>

          <div className="panels">
            <section className="panel" aria-label="Chiffre d'affaires et bénéfice des 7 derniers jours">
              <div className="panel-head">
                <div className="panel-title">
                  <TrendingUpIcon size={15} />
                  <span>CA &amp; bénéfice — 7 jours</span>
                </div>
                <span className="panel-legend">
                  <span className="legend-dot accent" /> CA
                  <span className="legend-dot ok" /> Bénéfice
                </span>
              </div>
              <RevenueChart points={stats?.by_day ?? []} />
            </section>
            <section className="panel" aria-label="Top produits">
              <div className="panel-head">
                <div className="panel-title">
                  <ChartIcon size={15} />
                  <span>Top produits — 7 jours</span>
                </div>
              </div>
              <TopProductsBars products={stats?.top_products ?? []} />
            </section>
          </div>

          <div className="stats business" aria-label="Vue d'ensemble">
            <div className="stat">
              <div className="k">CA 7 j (réel)</div>
              <div className="v">{fmtFcfa(stats?.totals.revenue)}</div>
            </div>
            <div className="stat">
              <div className="k">Bénéfice 7 j</div>
              <div className="v ok">{fmtFcfa(stats?.totals.profit)}</div>
            </div>
            <div className="stat">
              <div className="k">Ventes 7 j</div>
              <div className="v">{stats?.totals.sales ?? "—"}</div>
            </div>
            <div className="stat">
              <div className="k">Articles 7 j</div>
              <div className="v">{stats?.totals.items ?? "—"}</div>
            </div>
            <div className="stat">
              <div className="k">Clients 7 j</div>
              <div className="v">{stats?.totals.customers ?? "—"}</div>
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
                  <th>Échéance</th>
                  <th>Dernière synchro</th>
                  <th>En ligne</th>
                  <th>CA 7 j</th>
                  <th>Version</th>
                  <th>Dernière commande</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {!ready &&
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr className="skeleton-row" key={i}>
                      {Array.from({ length: 11 }).map((_, j) => (
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
                        stats={shopStatsOf.get(shop.device_id)}
                        lastSeen={lastSeen}
                        present={presentOf(shop)}
                        price={price}
                        now={now}
                        onExtend={(s) => {
                          setExtendMode("days");
                          setExtendDays(30);
                          setExtendAmount(price);
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
                    <td colSpan={11}>
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
                <div className="segmented">
                  <button
                    className={`segment ${extendMode === "days" ? "active" : ""}`}
                    onClick={() => setExtendMode("days")}
                    type="button"
                  >
                    Par jours
                  </button>
                  <button
                    className={`segment ${extendMode === "amount" ? "active" : ""}`}
                    onClick={() => setExtendMode("amount")}
                    type="button"
                  >
                    Par montant
                  </button>
                </div>
                {extendMode === "days" ? (
                  <>
                    <label htmlFor="extend-days">Nombre de jours à ajouter</label>
                    <input
                      id="extend-days"
                      type="number"
                      min={1}
                      value={extendDays}
                      onChange={(e) => setExtendDays(Number(e.target.value))}
                    />
                  </>
                ) : (
                  <>
                    <label htmlFor="extend-amount">Montant encaissé (FCFA)</label>
                    <input
                      id="extend-amount"
                      type="number"
                      min={500}
                      step={500}
                      value={extendAmount}
                      onChange={(e) => setExtendAmount(Number(e.target.value))}
                    />
                    <div className="amount-chips">
                      {[5000, 10000, 25000, 50000].map((v) => (
                        <button
                          key={v}
                          className={`chip-btn ${extendAmount === v ? "active" : ""}`}
                          onClick={() => setExtendAmount(v)}
                          type="button"
                        >
                          {fmtFcfa(v)}
                        </button>
                      ))}
                    </div>
                    {extendAmount > 0 && (
                      <div className="amount-preview">
                        ≈ <strong className="mono">{daysFromAmount(extendAmount)} jours</strong> ajoutés (
                        {fmtFcfa(price)}/mois)
                      </div>
                    )}
                  </>
                )}
                <div className="buttons">
                  <button className="btn" onClick={() => setDialog(null)} disabled={busy}>
                    Annuler
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={submitDialog}
                    disabled={
                      busy ||
                      (extendMode === "days" ? !extendDays : !extendAmount || extendAmount < 500)
                    }
                  >
                    {extendMode === "amount" && <BanknoteIcon size={14} />}
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
            {dialog.type === "cfg" && dialogSub && (
              <>
                <h2>Tarif du projet</h2>
                <div className="sub">
                  « {dialogSub.name} » — sert au calcul montant → jours et à l'essai des nouvelles caisses.
                </div>
                <label htmlFor="cfg-price">Prix mensuel (FCFA)</label>
                <input
                  id="cfg-price"
                  type="number"
                  min={0}
                  step={500}
                  value={cfgPrice}
                  onChange={(e) => setCfgPrice(Number(e.target.value))}
                />
                <label htmlFor="cfg-trial">Durée d'essai (jours)</label>
                <input
                  id="cfg-trial"
                  type="number"
                  min={0}
                  value={cfgTrial}
                  onChange={(e) => setCfgTrial(Number(e.target.value))}
                />
                <label htmlFor="cfg-type">Type d'app</label>
                <input
                  id="cfg-type"
                  type="text"
                  value={cfgType}
                  onChange={(e) => setCfgType(e.target.value)}
                  placeholder="pos, resto, booking…"
                />
                <div className="buttons">
                  <button className="btn" onClick={() => setDialog(null)} disabled={busy}>
                    Annuler
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={submitDialog}
                    disabled={busy || (cfgPrice <= 0 && cfgTrial <= 0 && !cfgType.trim())}
                  >
                    <WalletIcon size={14} />
                    Enregistrer
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
