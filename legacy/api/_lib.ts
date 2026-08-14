// Orchestrateur multi-projets — logique partagée par les fonctions serverless Vercel.
//
// L'identifiant d'un projet est son DOMAINE : chaque app embarque un snippet
// (src/lib/sync.ts) qui s'annonce avec son origin (`window.location.origin`). L'orchestrateur
// rattache chaque inscription au projet dont le domaine correspond — c'est l'opérateur qui
// enregistre le domaine d'une app dans la console avant de déployer.
//
// Stockage : Redis via Upstash (KV_REST_API_URL / KV_REST_API_TOKEN fournis par Vercel KV).
// Clés :
//   projects                 → ensemble des slugs de projets
//   project:{slug}           → JSON du projet
//   shops                    → ensemble des device_id
//   shops:{slug}             → ensemble des device_id du projet
//   shop:{device_id}         → JSON de la boutique
//   payments:{device_id}     → liste de paiements (JSON)
import { Redis } from "@upstash/redis";
import { createHmac, timingSafeEqual } from "node:crypto";

export const kv = Redis.fromEnv();

export const DAY_MS = 86_400_000;

export interface Project {
  slug: string;
  name: string;
  domain: string;
  price_per_month_fcfa: number;
  trial_days: number;
  created_at: number;
}

export interface Shop {
  device_id: string;
  project_slug: string;
  project_domain: string;
  owner_name: string;
  store_name: string;
  phone?: string;
  location?: string;
  registration_date: number;
  expiry_date: number;
  created_at: number;
  last_sync_at: number;
  /** Nombre de prolongations (lecture directe, sans `llen` à chaque liste). */
  payments_count: number;
  /** Somme des montants reçus, pour les indicateurs de la console. */
  payments_total_fcfa: number;
}

export interface Payment {
  amount: number;
  days_added: number;
  created_at: number;
}

export type ShopRow = Shop & { payments: number };

// ── Temps réel ──────────────────────────────────────────────────────────────────
// La console ne poll plus : les écritures publient un signal sur ce canal (1 op KV par
// écriture, négligeable) et `api/stream.ts` le relaie en SSE au navigateur. Le signal ne
// porte AUCUNE donnée sensible — il dit juste « quelque chose a changé, recharge ».

export const CHANGES_CHANNEL = "orch:changes";

export async function publish(event: string, payload: Record<string, unknown> = {}): Promise<void> {
  try {
    await kv.publish(CHANGES_CHANNEL, { event, at: Date.now(), ...payload });
  } catch {
    // Le signal est un confort : une écriture réussie ne doit jamais être perdue
    // parce que la notification n'est pas partie.
  }
}

/** Signatures des handlers Vercel : req augmente la requête Node standard. */
export interface ApiRequest {
  method?: string;
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
  headers?: Record<string, string | string[] | undefined>;
}
export interface ApiResponse {
  status(code: number): ApiResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): ApiResponse;
}

export function jsonError(res: ApiResponse, code: number, message: string): void {
  res.status(code).json({ error: message });
}

// ── Projets ──────────────────────────────────────────────────────────────────────

/** Normalise un domaine : minuscules, sans barre finale. */
export function normalizeDomain(domain: string): string {
  return String(domain).trim().toLowerCase().replace(/\/+$/, "");
}

export async function listProjects(): Promise<Project[]> {
  const slugs = await kv.smembers("projects");
  if (slugs.length === 0) return [];
  const rows = await kv.mget<Project[]>(...slugs.map((s) => `project:${s}`));
  return rows.filter((p): p is Project => Boolean(p));
}

export async function getProject(slug: string): Promise<Project | null> {
  return kv.get<Project>(`project:${slug}`);
}

export async function getProjectByDomain(domain: string): Promise<Project | null> {
  const target = normalizeDomain(domain);
  const projects = await listProjects();
  return projects.find((p) => normalizeDomain(p.domain) === target) ?? null;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "projet"
  );
}

export interface CreateProjectInput {
  name: string;
  domain: string;
  price_per_month_fcfa: number;
  trial_days: number;
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const domain = normalizeDomain(input.domain);
  const base = slugify(input.name || domain);
  let slug = base;
  for (let i = 2; await getProject(slug); i++) slug = `${base}-${i}`;
  const project: Project = {
    slug,
    name: input.name.trim() || domain,
    domain,
    price_per_month_fcfa: input.price_per_month_fcfa,
    trial_days: input.trial_days,
    created_at: Date.now(),
  };
  await kv.sadd("projects", slug);
  await kv.set(`project:${slug}`, project);
  void publish("project.created", { slug, name: project.name, domain: project.domain });
  return project;
}

// ── Boutiques ────────────────────────────────────────────────────────────────────

export interface UpsertShopInput {
  device_id: string;
  owner_name: string;
  store_name: string;
  phone?: string;
  location?: string;
  registered_at: number;
}

export async function upsertShop(input: UpsertShopInput, project: Project): Promise<Shop> {
  const existing = await kv.get<Shop>(`shop:${input.device_id}`);
  const now = Date.now();
  if (!existing) {
    const shop: Shop = {
      device_id: input.device_id,
      project_slug: project.slug,
      project_domain: project.domain,
      owner_name: input.owner_name,
      store_name: input.store_name,
      phone: input.phone,
      location: input.location,
      registration_date: input.registered_at,
      expiry_date: input.registered_at + project.trial_days * DAY_MS,
      created_at: now,
      last_sync_at: now,
      payments_count: 0,
      payments_total_fcfa: 0,
    };
    await kv.set(`shop:${shop.device_id}`, shop);
    await kv.sadd("shops", shop.device_id);
    await kv.sadd(`shops:${project.slug}`, shop.device_id);
    void publish("shop.registered", {
      device_id: shop.device_id,
      store_name: shop.store_name,
      project_slug: project.slug,
    });
    return shop;
  }
  const shop: Shop = {
    ...existing,
    owner_name: input.owner_name,
    store_name: input.store_name,
    phone: input.phone,
    location: input.location,
    last_sync_at: now,
  };
  await kv.set(`shop:${shop.device_id}`, shop);
  void publish("shop.updated", { device_id: shop.device_id, project_slug: project.slug });
  return shop;
}

export async function listShops(projectSlug?: string): Promise<ShopRow[]> {
  const ids = projectSlug ? await kv.smembers(`shops:${projectSlug}`) : await kv.smembers("shops");
  if (ids.length === 0) return [];
  const shops = (await kv.mget<Shop[]>(...ids.map((id) => `shop:${id}`))).filter((s): s is Shop =>
    Boolean(s),
  );
  return shops.map((s) => ({ ...s, payments: s.payments_count ?? 0 }));
}

export async function extendShop(
  deviceId: string,
  amount: number,
  project: Project,
): Promise<Shop | null> {
  const shop = await kv.get<Shop>(`shop:${deviceId}`);
  if (!shop) return null;
  const days = Math.max(1, Math.round((amount / project.price_per_month_fcfa) * 30));
  const now = Date.now();
  const base = Math.max(now, shop.expiry_date);
  shop.expiry_date = base + days * DAY_MS;
  shop.payments_count = (shop.payments_count ?? 0) + 1;
  shop.payments_total_fcfa = (shop.payments_total_fcfa ?? 0) + amount;
  await kv.set(`shop:${deviceId}`, shop);
  await kv.rpush(`payments:${deviceId}`, {
    amount,
    days_added: days,
    created_at: now,
  } satisfies Payment);
  void publish("shop.extended", { device_id: deviceId, amount });
  return shop;
}

// ── Authentification admin ───────────────────────────────────────────────────────
// Token sans état : une signature HMAC de l'échéance. Aucun stockage de session.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;

export function signToken(expiry: number): string {
  const sig = createHmac("sha256", ADMIN_PASSWORD).update(String(expiry)).digest("hex");
  return `${expiry}.${sig}`;
}

export function verifyToken(token?: string): boolean {
  if (!token || !ADMIN_PASSWORD) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const expiry = Number(token.slice(0, dot));
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false;
  const actual = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(signToken(expiry).slice(dot + 1));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function bearerToken(req: ApiRequest): string | undefined {
  const header = req.headers?.authorization;
  if (typeof header !== "string") return undefined;
  return header.replace(/^Bearer\s+/i, "");
}

/** Renvoie true si le bearer est valide et a déjà répondu sinon. */
export function requireAdmin(req: ApiRequest, res: ApiResponse): boolean {
  if (verifyToken(bearerToken(req))) return true;
  jsonError(res, 401, "Authentification requise.");
  return false;
}
