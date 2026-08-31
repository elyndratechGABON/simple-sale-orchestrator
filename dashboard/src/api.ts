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
  account_id: number | null;
  amount: number;
  days_added: number;
  created_at: number;
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
  grace: number;
  suspended: number;
  expired: number;
  online: number;
  expiring_7d: number;
  expiring_30d: number;
  grace_ending_2d: number;
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

export interface TierRevenueMonth {
  month: string;
  tier_10k: number;
  tier_25k: number;
  tier_50k: number;
  other: number;
  total: number;
}

export interface RetentionMonth {
  month: string;
  active: number;
  new: number;
  churned: number;
  retention_pct: number;
}

export interface ForecastMonth {
  month: string;
  mrr_fcfa: number;
  churn_fcfa: number;
  renewal_rate: number;
}

export interface SmsPayment {
  id: number;
  phone: string;
  name: string;
  amount_fcfa: number;
  tid: string;
  status: "pending" | "matched" | "unmatched" | "duplicate" | "processed";
  error: string | null;
  received_at: number;
  processed_at: number | null;
  matched_account_id: number | null;
  matched_tier_price: number | null;
  matched_account_name: string | null;
}

export interface Overview {
  generated_at: number;
  kpi: {
    revenue_today: number;
    revenue_week: number;
    revenue_month: number;
    revenue_year: number;
    clients: number;
    clients_new_today: number;
    shops: number;
    shops_active: number;
    subscriptions_active: number;
    subscriptions_expired: number;
    devices_connected: number;
    devices_total: number;
    payments_month: number;
    payments_confirmed: number;
    payments_pending: number;
    mrr: number;
    arr: number;
  };
  business: {
    elyndra_revenue: { today: number; week: number; month: number; year: number; mrr: number; arr: number };
    shop_revenue: { today: number; week: number; month: number; year: number; total_revenue: number; total_sales: number; total_profit: number };
  };
  subscriptions: Subscriptions;
  shop_stats: Stats;
}

export interface Client {
  id: number;
  name: string;
  owner_name: string;
  phone: string | null;
  email: string | null;
  max_devices: number;
  expiry_date: number;
  suspended_at: number | null;
  status: string;
  monthly_price_fcfa: number;
  online: boolean;
  device_count: number;
  shop_count: number;
  last_activity: number | null;
  next_payment: number;
  created_at: number;
  devices: { device_id: string; store_name: string; app_version_used: string | null; last_sync_at: number | null; status: string }[];
}

export interface ClientDetail {
  client: any;
  subscription: any;
  shops: any[];
  payments: any;
  payment_events: any[];
  commands: any[];
  activity: any[];
}

export interface ShopDetail {
  id: number;
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
  status: string;
  payments: number;
  online: boolean;
}

export interface ShopFull {
  shop: any;
  account: any;
  payments: any[];
  commands: any[];
  stats: any;
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

export interface ActivityEvent {
  id: number;
  level: string;
  category: string;
  title: string;
  detail: string | null;
  data: any;
  shop_id: number | null;
  account_id: number | null;
  project_id: string | null;
  created_at: number;
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

export interface RevenueTimeseries {
  period: string;
  days: number;
  by_day: { day: string; revenue: number }[];
  by_account: { name: string; total: number }[];
  by_shop: { store_name: string; total: number }[];
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

export function fetchConfig(project?: string): Promise<Config> {
  return request(`/api/config${project ? `?project=${encodeURIComponent(project)}` : ""}`);
}

export function fetchPublicProjects(): Promise<{ projects: { id: string; name: string }[] }> {
  return request("/api/v1/public/projects");
}

export function fetchShops(project?: string): Promise<{ shops: Shop[] }> {
  return request(`/api/v1/admin/shops${project ? `?project=${encodeURIComponent(project)}` : ""}`);
}

export function fetchStats(project?: string): Promise<Stats> {
  return request(`/api/v1/admin/stats${project ? `?project=${encodeURIComponent(project)}` : ""}`);
}

export function fetchCommandHistory(deviceId: string): Promise<{ commands: AdminCommand[] }> {
  return request(`/api/v1/admin/shops/${encodeURIComponent(deviceId)}/commands`);
}

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

export function fetchAccounts(project?: string): Promise<{ accounts: Account[] }> {
  return request(`/api/v1/admin/accounts${project ? `?project=${encodeURIComponent(project)}` : ""}`);
}

export function fetchAccountPayments(accountId: number): Promise<{ payments: Payment[] }> {
  return request(`/api/v1/admin/accounts/${accountId}/payments`);
}

export function fetchAccountCommands(accountId: number): Promise<{ commands: AdminCommand[] }> {
  return request(`/api/v1/admin/accounts/${accountId}/commands`);
}

export function setAccountPassword(accountId: number, password: string): Promise<{ ok: boolean }> {
  return request(`/api/v1/admin/accounts/${accountId}/password`, {
    method: "POST",
    body: JSON.stringify({ password }),
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

export function deleteShop(deviceId: string): Promise<{ ok: boolean; device_id: string }> {
  return request(`/api/v1/admin/shops/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
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

export function setProjectConfig(
  id: string,
  cfg: { type?: string; price_per_month_fcfa?: number; trial_days?: number },
): Promise<{ ok: boolean; project: Project }> {
  return request(`/api/v1/admin/projects/${encodeURIComponent(id)}/config`, {
    method: "POST",
    body: JSON.stringify(cfg),
  });
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

export function fetchRevenueByTier(): Promise<{ months: TierRevenueMonth[] }> {
  return request("/api/v1/admin/revenue-by-tier");
}

export function fetchRetention(): Promise<{ months: RetentionMonth[] }> {
  return request("/api/v1/admin/retention");
}

export function fetchForecast(renewalRate?: number): Promise<{ current_mrr_fcfa: number; forecast: ForecastMonth[] }> {
  const qs = renewalRate != null ? `?renewal_rate=${renewalRate}` : "";
  return request(`/api/v1/admin/forecast${qs}`);
}

export function fetchSmsPayments(status?: string): Promise<{ payments: SmsPayment[] }> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : "";
  return request(`/api/v1/admin/sms-payments${qs}`);
}

export function processSmsPayment(id: number, accountId: number): Promise<{ ok: boolean }> {
  return request(`/api/v1/admin/sms-payments/${id}/process`, {
    method: "POST",
    body: JSON.stringify({ account_id: accountId }),
  });
}

export function fetchOverview(project?: string): Promise<Overview> {
  return request(`/api/v1/admin/overview${project ? `?project=${encodeURIComponent(project)}` : ""}`);
}

export function fetchClients(project?: string): Promise<{ clients: Client[] }> {
  return request(`/api/v1/admin/clients${project ? `?project=${encodeURIComponent(project)}` : ""}`);
}

export function fetchClient(id: number): Promise<ClientDetail> {
  return request(`/api/v1/admin/clients/${id}`);
}

export function fetchShopsDetail(project?: string): Promise<{ shops: ShopDetail[] }> {
  return request(`/api/v1/admin/shops-detail${project ? `?project=${encodeURIComponent(project)}` : ""}`);
}

export function fetchShopDetail(deviceId: string): Promise<ShopFull> {
  return request(`/api/v1/admin/shops-detail/${encodeURIComponent(deviceId)}`);
}

export function fetchDevices(project?: string): Promise<{ devices: Device[]; summary: DevicesSummary }> {
  return request(`/api/v1/admin/devices${project ? `?project=${encodeURIComponent(project)}` : ""}`);
}

export function fetchSync(project?: string): Promise<{ connected: number; total: number; status: SyncStatus[]; recent_syncs: any[]; pending_commands: number }> {
  return request(`/api/v1/admin/sync${project ? `?project=${encodeURIComponent(project)}` : ""}`);
}

export function fetchActivity(opts?: { limit?: number; category?: string; level?: string }): Promise<{ events: ActivityEvent[] }> {
  const qs = new URLSearchParams();
  if (opts?.limit) qs.set("limit", String(opts.limit));
  if (opts?.category) qs.set("category", opts.category);
  if (opts?.level) qs.set("level", opts.level);
  return request(`/api/v1/admin/activity${qs.size ? `?${qs}` : ""}`);
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

export function fetchRevenueTimeseries(period?: string): Promise<RevenueTimeseries> {
  return request(`/api/v1/admin/revenue-timeseries${period ? `?period=${encodeURIComponent(period)}` : ""}`);
}

export function fetchRevenueSummary(): Promise<RevenueSummary> {
  return request("/api/v1/admin/revenue-summary");
}

export function suspendClient(id: number, reason?: string): Promise<any> {
  return request(`/api/v1/admin/clients/${id}/suspend`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export function activateClient(id: number, reason?: string): Promise<any> {
  return request(`/api/v1/admin/clients/${id}/activate`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export function changeClientPlan(id: number, opts: { days?: number; amount_fcfa?: number }): Promise<any> {
  return request(`/api/v1/admin/clients/${id}/plan`, {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

export function extendClient(id: number, amount_fcfa: number): Promise<any> {
  return request(`/api/v1/admin/clients/${id}/extend`, {
    method: "POST",
    body: JSON.stringify({ amount_fcfa }),
  });
}

export function revokeDevice(deviceId: string, reason?: string): Promise<any> {
  return request(`/api/v1/admin/devices/${encodeURIComponent(deviceId)}/revoke`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export function forceSync(deviceId: string, message?: string): Promise<any> {
  return request(`/api/v1/admin/devices/${encodeURIComponent(deviceId)}/force-sync`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

export function deactivateShop(deviceId: string, reason?: string): Promise<any> {
  return request(`/api/v1/admin/shops/${encodeURIComponent(deviceId)}/deactivate`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export function reactivateShop(deviceId: string, reason?: string): Promise<any> {
  return request(`/api/v1/admin/shops/${encodeURIComponent(deviceId)}/reactivate`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}
