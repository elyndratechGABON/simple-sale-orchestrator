// Client API du dashboard — uniquement des appels admin. Le dashboard ne lit jamais
// le BRUT des `sync_payloads` : le backend les agrège (GET /api/v1/admin/stats) et ne
// renvoie que des totaux + top produits par projet et par caisse.
export class AuthError extends Error {}

const TOKEN_KEY = "orch_admin_token";
const SCOPE_KEY = "orch_admin_scope";
const PROJECT_KEY = "orch_admin_project";
const PROJECT_NAME_KEY = "orch_admin_project_name";

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}
export function getScope(): "master" | "project" {
  return localStorage.getItem(SCOPE_KEY) === "project" ? "project" : "master";
}
export function getProjectId(): string {
  return localStorage.getItem(PROJECT_KEY) ?? "";
}
export function getProjectName(): string {
  return localStorage.getItem(PROJECT_NAME_KEY) ?? "";
}
function storeSession(session: { token: string; scope: "master" | "project"; project?: string | null; name?: string | null }): void {
  localStorage.setItem(TOKEN_KEY, session.token);
  localStorage.setItem(SCOPE_KEY, session.scope);
  if (session.project) localStorage.setItem(PROJECT_KEY, session.project);
  if (session.name) localStorage.setItem(PROJECT_NAME_KEY, session.name);
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(SCOPE_KEY);
  localStorage.removeItem(PROJECT_KEY);
  localStorage.removeItem(PROJECT_NAME_KEY);
}

export interface AdminCommand {
  id: string;
  action_type: "suspend" | "renew" | "broadcast_message";
  payload: {
    new_end_date?: number;
    days?: number;
    amount_fcfa?: number;
    message_text?: string;
  };
  expires_at: number;
  created_at: number;
  delivered_at: number | null;
  superseded_at?: number | null;
}

export interface Shop {
  id: number;
  device_id: string;
  owner_name: string;
  store_name: string;
  phone: string | null;
  location: string | null;
  registration_date: number;
  expiry_date: number;
  suspended_at: number | null;
  app_version_used: string | null;
  app_origin: string;
  last_sync_at: number | null;
  payments: number;
  status: "active" | "suspended" | "expired";
  last_command: AdminCommand | null;
  expired_commands: number;
}

export interface Config {
  price_per_month_fcfa: number;
  trial_days: number;
  project: string | null;
}

export interface Project {
  id: string;
  name: string;
  created_at: number;
  shop_count: number;
  type: string | null;
  price_per_month_fcfa: number | null;
  trial_days: number | null;
  from_manifest: boolean;
}

export interface Payment {
  id: number;
  shop_id: number;
  amount: number;
  days_added: number;
  created_at: number;
}

export interface BusinessTotals {
  revenue: number;
  profit: number;
  sales: number;
  items: number;
  customers: number;
}

export interface TopProduct {
  name: string;
  quantity: number;
  revenue: number;
}

export interface DayPoint {
  day: number;
  revenue: number;
  profit: number;
  sales: number;
}

export interface Subscriptions {
  total: number;
  active: number;
  suspended: number;
  expired: number;
  online: number;
  expiring_7d: number;
  expiring_30d: number;
  mrr_fcfa: number;
}

export interface ShopStats {
  device_id: string;
  store_name: string;
  last_sync_at: number;
  totals: BusinessTotals;
  top_products: TopProduct[];
  by_day: DayPoint[];
}

export interface Stats {
  project: string | null;
  generated_at: number | null;
  subscriptions: Subscriptions;
  totals: BusinessTotals;
  top_products: TopProduct[];
  by_day: DayPoint[];
  shops: ShopStats[];
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) throw new AuthError("Authentification requise.");
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Erreur serveur.");
  return data as T;
}

/** Connexion : sans `project` → administrateur (master) ; avec → dashboard dédié. */
export function login(
  password: string,
  project?: string,
): Promise<{ token: string; scope: "master" | "project"; project: string | null; name: string | null }> {
  return request<{
    token: string;
    scope: "master" | "project";
    project: string | null;
    name: string | null;
  }>("/api/login", {
    method: "POST",
    body: JSON.stringify({ password, ...(project ? { project } : {}) }),
  }).then((r) => {
    storeSession(r);
    return r;
  });
}

export function fetchConfig(project?: string): Promise<Config> {
  return request(`/api/config${project ? `?project=${encodeURIComponent(project)}` : ""}`);
}

/** Liste publique des projets (id + nom) — alimente le sélecteur de l'écran de connexion. */
export function fetchPublicProjects(): Promise<{ projects: { id: string; name: string }[] }> {
  return request("/api/v1/public/projects");
}

export function fetchShops(project?: string): Promise<{ shops: Shop[] }> {
  return request(`/api/v1/admin/shops${project ? `?project=${encodeURIComponent(project)}` : ""}`);
}

/** Stats réelles (agrégées des sync_payloads) : par projet (`?project=`) ou tout. */
export function fetchStats(project?: string): Promise<Stats> {
  return request(`/api/v1/admin/stats${project ? `?project=${encodeURIComponent(project)}` : ""}`);
}

export function fetchCommandHistory(deviceId: string): Promise<{ commands: AdminCommand[] }> {
  return request(`/api/v1/admin/shops/${encodeURIComponent(deviceId)}/commands`);
}

/** Historique de facturation d'une caisse (montants et jours ajoutés à chaque prolongation). */
export function fetchPayments(deviceId: string): Promise<{ payments: Payment[] }> {
  return request(`/api/v1/admin/shops/${encodeURIComponent(deviceId)}/payments`);
}

export function sendCommand(
  deviceId: string,
  body:
    | { action_type: "suspend" }
    | { action_type: "renew"; days?: number; amount_fcfa?: number }
    | { action_type: "broadcast_message"; message: string },
): Promise<{ command: AdminCommand }> {
  return request("/api/v1/admin/commands", {
    method: "POST",
    body: JSON.stringify({ device_id: deviceId, ...body }),
  });
}

export function fetchProjects(): Promise<{ projects: Project[] }> {
  return request("/api/v1/admin/projects");
}

export function createProject(
  id: string,
  name: string,
  password: string,
  type?: string,
  price?: number,
  trial?: number,
): Promise<{ project: Project }> {
  return request("/api/v1/admin/projects", {
    method: "POST",
    body: JSON.stringify({ id, name, password, type, price_per_month_fcfa: price, trial_days: trial }),
  });
}

export function setProjectPassword(id: string, password: string): Promise<{ ok: boolean }> {
  return request(`/api/v1/admin/projects/${encodeURIComponent(id)}/password`, {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

/** Réglage du tarif / essai / type d'un projet (source de vérité de la facturation). */
export function setProjectConfig(
  id: string,
  cfg: { type?: string; price_per_month_fcfa?: number; trial_days?: number },
): Promise<{ ok: boolean; project: Project }> {
  return request(`/api/v1/admin/projects/${encodeURIComponent(id)}/config`, {
    method: "POST",
    body: JSON.stringify(cfg),
  });
}

// ── SSE temps réel ────────────────────────────────────────────────────────────────
// Le serveur pousse chaque handshake : le dashboard met à jour la ligne concernée sans
// recharger. EventSource ne peut pas envoyer d'en-tête Authorization → le token passe
// en query string. La reconnexion automatique est gérée par le navigateur (~3 s).
export interface StatusEvent {
  type: "status_update";
  device_id: string;
  last_seen: number;
  status: string;
  origin: string;
}

export function subscribeStatus(onEvent: (evt: StatusEvent) => void): () => void {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(getToken())}`);
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data as string) as StatusEvent;
      if (data.type === "status_update") onEvent(data);
    } catch {
      // message ignoré (pings, etc.)
    }
  };
  es.onerror = () => {
    // EventSource retente tout seul ; on ne ferme que si on a perdu la session.
    if (!getToken()) es.close();
  };
  return () => es.close();
}
