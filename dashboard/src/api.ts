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
    max_devices?: number;
    message_text?: string;
  };
  expires_at: number;
  created_at: number;
  delivered_at: number | null;
  superseded_at?: number | null;
}

export interface AccountDevice {
  device_id: string;
  store_name: string;
  owner_name: string;
  registration_date: number;
  last_sync_at: number | null;
  over_limit: boolean;
  status: "active" | "suspended" | "expired" | "over_limit";
}

export interface Account {
  id: number;
  name: string;
  owner_name: string;
  phone: string | null;
  max_devices: number;
  expiry_date: number;
  suspended_at: number | null;
  status: "active" | "suspended" | "expired" | "grace";
  monthly_price_fcfa: number;
  online: boolean;
  payments: number;
  devices: AccountDevice[];
}

export interface SubscriptionRequest {
  id: number;
  account_id: number;
  account_name: string | null;
  account_phone: string | null;
  account_status: "active" | "suspended" | "expired" | "unknown";
  device_id: string;
  store_name: string;
  owner_name: string;
  plan_name: string;
  plan_price: number;
  plan_devices: number;
  reference: string;
  note: string;
  status: "pending" | "approved" | "rejected" | "superseded";
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
}

/** Demande de suppression d'une caisse, soumise par l'employé depuis son écran.
 *  Le propriétaire l'approuve (« Supprimer ») ou la refuse dans la page Boutiques. */
export interface DeleteRequest {
  id: number;
  device_id: string;
  store_name: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "superseded";
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
  owner_name: string | null;
  origin: string | null;
  shop_account_id: number | null;
}

export interface RevenueSummary {
  today: number;
  week: number;
  month: number;
  year: number;
  recurring_mrr: number;
  pending: number;
  confirmed: number;
}

export interface SmsPayment {
  id: number;
  phone: string;
  name: string;
  amount_fcfa: number;
  tid: string;
  status: "pending" | "matched" | "unmatched" | "duplicate" | "processed" | "rejected";
  /** Le SMS BRUT envoyé par le client (montant illisible ? on le lit avant de valider). */
  raw_sms: string | null;
  error: string | null;
  received_at: number;
  processed_at: number | null;
  matched_account_id: number | null;
  matched_tier_price: number | null;
  matched_account_name: string | null;
}

/** Un ÉCRAN d'un commerce. Ce n'est pas une boutique : c'est un poste (celui du
 *  patron, celui d'un employé). */
export interface StorefrontDevice {
  device_id: string;
  store_name: string;
  owner_name: string;
  online: boolean;
  status: string;
  last_sync_at: number | null;
  app_version_used: string | null;
}

/** Une LIGNE = un commerce (compte marchand), avec ses écrans. */
export interface StorefrontShop {
  /** Premier écran du commerce — clé stable du drill-down, pas l'identité de la ligne. */
  device_id: string;
  store_name: string;
  owner_name: string;
  phone: string | null;
  last_sync_at: number | null;
  online: boolean;
  status: string;
  account_id: number | null;
  account_name: string | null;
  /** Le lieu du commerce (quartier du compte, ou localisation de l'écran). */
  location: string | null;
  plan_name: string | null;
  plan_price_fcfa: number | null;
  /** écrans du commerce, comparés aux places payées. */
  device_count: number;
  max_devices: number;
  over_limit: boolean;
  ca_today_fcfa: number;
  ca_month_fcfa: number;
  ca_30d_fcfa: number;
  elyndra_month_fcfa: number;
  devices: StorefrontDevice[];
}

export interface Storefront {
  generated_at: number;
  project: string | null;
  kpi: {
    boutique_total: number;
    boutique_active: number;
    en_ligne: number;
    hors_ligne: number;
    en_grace: number;
    suspendues: number;
    expirees: number;
    employees: number;
    /** Écrans tous comptes faits : l'unité des employés, pas des boutiques. */
    devices_total?: number;
  };
  elyndra: {
    mois_encaisse: number;
    ca_boutiques_mois: number;
    mrr_fcfa: number;
    arr_fcfa: number;
  };
  /** Répartition des commerces par lieu (le plus grand d'abord). */
  par_lieu: { lieu: string; count: number }[];
  shops: StorefrontShop[];
}

export interface ShopDevice {
  device_id: string;
  store_name: string;
  owner_name: string;
  status: string;
  online: boolean;
  last_sync_at: number | null;
  app_version_used: string | null;
}

/** Une LIGNE = un commerce (compte marchand). `devices` liste ses écrans — le patron et
 *  ses employés : autant de postes, UNE seule boutique. */
export interface ShopDetail {
  id: number;
  /** Premier écran du commerce — clé du drill-down. */
  device_id: string;
  store_name: string;
  owner_name: string;
  phone: string | null;
  location: string | null;
  registration_date: number;
  expiry_date: number;
  suspended_at: number | null;
  app_version_used: string | null;
  app_origin: string;
  last_sync_at: number | null;
  account_id: number | null;
  account_name: string | null;
  plan_name: string | null;
  plan_price_fcfa: number | null;
  account_device_count: number;
  account_max_devices: number | null;
  status: string;
  payments: number;
  online: boolean;
  devices?: ShopDevice[];
}

export interface ShopFull {
  shop: any;
  account: any;
  payments: any[];
  commands: any[];
  stats: any;
}

export interface SyncStatus {
  device_id: string;
  store_name: string;
  app_origin: string;
  status: string;
  last_sync_at: number | null;
  operations_count: number;
  pending: number;
  errors: number;
}

export interface AuditAction {
  id: number;
  admin_id: string;
  target_type: string;
  target_id: string;
  action: string;
  reason: string | null;
  created_at: number;
}

export interface PaymentEvent {
  id: number;
  account_id: number;
  shop_id: number | null;
  device_id: string | null;
  amount: number;
  currency: string;
  provider: string;
  reference: string;
  status: string;
  source: string;
  received_at: number;
  confirmed_at: number | null;
  note: string | null;
  created_at: number;
}

export interface StatusEvent {
  type: "status_update";
  device_id: string;
  last_seen: number;
  status: string;
  origin: string;
}

export interface RequestCreatedEvent {
  type: "request_created";
  request_id: number;
  store_name: string;
  account_name: string;
  plan_price: number;
  plan_devices: number;
  created_at: number;
}

export type LiveEvent = StatusEvent | RequestCreatedEvent;

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new Event("orch:session-expired"));
    throw new AuthError("Authentification requise.");
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Erreur serveur.");
  return data as T;
}

export function login(
  password: string,
  project?: string,
): Promise<{ token: string; scope: "master" | "project"; project: string | null; name: string | null }> {
  return request<{ token: string; scope: "master" | "project"; project: string | null; name: string | null }>("/api/login", {
    method: "POST",
    body: JSON.stringify({ password, ...(project ? { project } : {}) }),
  }).then((r) => {
    storeSession(r);
    return r;
  });
}

export function fetchPublicProjects(): Promise<{ projects: { id: string; name: string }[] }> {
  return request("/api/v1/public/projects");
}

export function fetchAccounts(project?: string): Promise<{ accounts: Account[] }> {
  return request(`/api/v1/admin/accounts${project ? `?project=${encodeURIComponent(project)}` : ""}`);
}

export function setAccountPassword(accountId: number, password: string): Promise<{ ok: boolean }> {
  return request(`/api/v1/admin/accounts/${accountId}/password`, {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

/**
 * L'état du mode maintenance (interrupteur global, administrateur principal).
 * Quand il est actif, les caisses cessent de synchroniser — elles encassent toujours.
 */
export function fetchMaintenance(): Promise<{
  maintenance: { enabled: boolean; message: string };
}> {
  return request("/api/v1/admin/maintenance");
}

export function setMaintenance(body: {
  enabled: boolean;
  message?: string;
}): Promise<{ ok: boolean; maintenance: { enabled: boolean; message: string } }> {
  return request("/api/v1/admin/maintenance", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Changer l'ABONNEMENT d'un commerce : le montant palier (10 000 F = 3 écrans,
 * 25 000 F = 5, 50 000 F = 9) fixe le nombre de places. `days` prolonge d'autant.
 */
export function setAccountPlan(
  accountId: number,
  body: { amount_fcfa?: number; days?: number; reason?: string },
): Promise<{ ok: boolean; account: Account }> {
  return request(`/api/v1/admin/clients/${accountId}/plan`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Réactiver un commerce suspendu (lève le verrou, garde les données). */
export function activateAccount(accountId: number): Promise<{ ok: boolean; account: Account }> {
  return request(`/api/v1/admin/clients/${accountId}/activate`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export function sendAccountCommand(
  accountId: number,
  body:
    | { action_type: "suspend" }
    | { action_type: "renew"; days?: number; amount_fcfa?: number }
    | { action_type: "broadcast_message"; message: string },
): Promise<{ command: AdminCommand; account: Account }> {
  return request("/api/v1/admin/commands", {
    method: "POST",
    body: JSON.stringify({ account_id: accountId, ...body }),
  });
}

export function fetchRequests(
  opts?: { status?: string; project?: string },
): Promise<{ requests: SubscriptionRequest[] }> {
  const qs = new URLSearchParams();
  if (opts?.status) qs.set("status", opts.status);
  if (opts?.project) qs.set("project", opts.project);
  return request(`/api/v1/admin/requests${qs.size ? `?${qs}` : ""}`);
}

export function approveRequest(id: number): Promise<{ ok: boolean; request: SubscriptionRequest }> {
  return request(`/api/v1/admin/requests/${id}/approve`, { method: "POST" });
}

export function rejectRequest(id: number): Promise<{ ok: boolean; request: SubscriptionRequest }> {
  return request(`/api/v1/admin/requests/${id}/reject`, { method: "POST" });
}

export function fetchDeleteRequests(
  opts?: { status?: string; project?: string },
): Promise<{ requests: DeleteRequest[] }> {
  const qs = new URLSearchParams();
  if (opts?.status) qs.set("status", opts.status);
  if (opts?.project) qs.set("project", opts.project);
  return request(`/api/v1/admin/delete-requests${qs.size ? `?${qs}` : ""}`);
}

export function approveDeleteRequest(id: number): Promise<{ ok: boolean; device_id: string }> {
  return request(`/api/v1/admin/delete-requests/${id}/approve`, { method: "POST" });
}

export function rejectDeleteRequest(id: number): Promise<{ ok: boolean; device_id: string }> {
  return request(`/api/v1/admin/delete-requests/${id}/reject`, { method: "POST" });
}

export function deleteShop(deviceId: string): Promise<{ ok: boolean; device_id: string }> {
  return request(`/api/v1/admin/shops/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
}

export function deleteAccount(accountId: number): Promise<{ ok: boolean; account_id: number }> {
  return request(`/api/v1/admin/accounts/${accountId}`, { method: "DELETE" });
}

export function subscribeStatus(onEvent: (evt: LiveEvent) => void): () => void {
  const es = new EventSource(`/api/events?token=${encodeURIComponent(getToken())}`);
  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data as string) as LiveEvent;
      if (data.type === "status_update" || data.type === "request_created") onEvent(data);
    } catch {
    }
  };
  es.onerror = () => {
    if (!getToken()) es.close();
  };
  return () => es.close();
}

export function processSmsPayment(id: number, accountId: number): Promise<{ ok: boolean }> {
  return request(`/api/v1/admin/sms-payments/${id}/process`, {
    method: "POST",
    body: JSON.stringify({ account_id: accountId }),
  });
}

/** Rejeter un SMS de paiement : il sort de la file d'attente, AUCUN abonnement n'est
 *  touché (un SMS n'est jamais un renouvellement automatique). */
export function rejectSmsPayment(id: number, reason?: string): Promise<{ ok: boolean }> {
  return request(`/api/v1/admin/sms-payments/${id}/reject`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export function fetchStorefront(project?: string): Promise<Storefront> {
  return request(`/api/v1/admin/storefront${project ? `?project=${encodeURIComponent(project)}` : ""}`);
}

export function fetchShopsDetail(project?: string): Promise<{ shops: ShopDetail[] }> {
  return request(`/api/v1/admin/shops-detail${project ? `?project=${encodeURIComponent(project)}` : ""}`);
}

export function fetchShopDetail(deviceId: string): Promise<ShopFull> {
  return request(`/api/v1/admin/shops-detail/${encodeURIComponent(deviceId)}`);
}

export interface Device {
  device_id: string;
  store_name: string;
  owner_name: string;
  phone: string | null;
  shop_id: number;
  account_id: number | null;
  app_origin: string;
  role: string;
  status: string;
  last_sync_at: number | null;
  app_version_used: string | null;
  registration_date: number;
  expiry_date: number;
  suspended_at: number | null;
  sync_pending: number;
}

export interface DevicesSummary {
  total: number;
  online: number;
  offline: number;
  sync_pending: number;
  versions: Record<string, number>;
}

export function fetchDevices(project?: string): Promise<{ devices: Device[]; summary: DevicesSummary }> {
  return request(`/api/v1/admin/devices${project ? `?project=${encodeURIComponent(project)}` : ""}`);
}

export function fetchSync(project?: string): Promise<{ connected: number; total: number; status: SyncStatus[]; recent_syncs: any[]; pending_commands: number }> {
  return request(`/api/v1/admin/sync${project ? `?project=${encodeURIComponent(project)}` : ""}`);
}

export function fetchAudit(opts?: { limit?: number; target_type?: string }): Promise<{ actions: AuditAction[] }> {
  const qs = new URLSearchParams();
  if (opts?.limit) qs.set("limit", String(opts.limit));
  if (opts?.target_type) qs.set("target_type", opts.target_type);
  return request(`/api/v1/admin/audit${qs.size ? `?${qs}` : ""}`);
}

export function fetchPaymentsView(project?: string): Promise<{ payments: any[]; payment_events: PaymentEvent[]; sms_payments: SmsPayment[]; summary: { today: number; month: number; pending: number; confirmed: number; total: number } }> {
  return request(`/api/v1/admin/payments-view${project ? `?project=${encodeURIComponent(project)}` : ""}`);
}

export function fetchRevenueSummary(): Promise<RevenueSummary> {
  return request("/api/v1/admin/revenue-summary");
}

/**
 * Rattacher un écran à un commerce (décision de l'administrateur). C'est le recours
 * quand un écran n'a pas pu rejoindre de lui-même — empreinte déjà prise, code
 * expiré, place manquante.
 */
export function attachDeviceToAccount(
  accountId: number,
  deviceId: string,
  reason?: string,
): Promise<{ ok: boolean; device_id: string; account_id: number }> {
  return request(`/api/v1/admin/accounts/${accountId}/attach-device`, {
    method: "POST",
    body: JSON.stringify({ device_id: deviceId, reason }),
  });
}

export function revokeDevice(deviceId: string, reason?: string): Promise<any> {
  return request(`/api/v1/admin/devices/${encodeURIComponent(deviceId)}/revoke`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

/** OPTION SUR-MESURE : au-delà des paliers (Essentiel/Confort/Affluence), pour les
 *  clients généreux — +N appareils au quota ACTUEL (pas un palier), un prix LIBRE,
 *  une durée en jours. Tout est optionnel mais au moins une des trois valeurs. */
export function setAccountCustom(
  accountId: number,
  body: { extra_devices?: number; price_fcfa?: number; days?: number; reason?: string },
): Promise<{ ok: boolean; account: Account }> {
  return request(`/api/v1/admin/accounts/${accountId}/custom`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
