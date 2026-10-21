// Connexion du dashboard + SSE temps réel + sessions (scopées par projet).
import { Router } from "express";
import { SESSION_MS, ADMIN_PASSWORD, projectById, projectConfig, db } from "../config.mjs";
import { str, byDeviceId, accountById, accountOriginOk, hashPassword, verifyPassword } from "../lib.mjs";

/** La valeur stockée est-elle déjà un condensat ? (cf. `hashPassword`) */
const isHashed = (stored) =>
  typeof stored === "string" && (stored.startsWith("sha256$") || stored.includes("argon2"));
import { logActivity } from "./audit.mjs";

const router = Router();

// ── Sessions admin (SANS ÉTAT : un token signé) ───────────────────────────────────
//
// ⚠️ Pourquoi ce changement : les sessions tenaient dans une Map EN MÉMOIRE. En
// serverless, chaque requête peut atterrir sur une instance différente — la session
// créée sur l'instance A n'existait pas sur l'instance B : le dashboard se
// déconnectait tout seul, au hasard, selon la répartition du trafic. C'était
// invisible en local (une seule instance) et permanent en production.
//
// Le jeton est donc AUTO-PORTEUR : il porte la portée, l'échéance, et sa SIGNATURE
// (HMAC-SHA256). Aucune mémoire, aucune instance partagée : la vérification se fait
// n'importe où, et l'expiration est dans le jeton.
import { createHmac, timingSafeEqual } from "node:crypto";

const SESSION_SECRET = String(
  process.env.SESSION_SECRET ?? process.env.BACKUP_KEY ?? ADMIN_PASSWORD,
);

/**
 * Une session admin : la portée, l'échéance.
 * @typedef {{ scope: "master" | "project", project?: string | null, name?: string | null, expires: number }} AdminSession
 */

/** Signe une session : le corps est lisible, la signature empêche d'en forger une. */
export function signSession(session) {
  const payload = {
    scope: session.scope,
    project: session.project ?? null,
    name: session.name ?? null,
    exp: session.expires ?? Date.now() + SESSION_MS,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/** Vérifie un jeton : signature d'abord, expiration ensuite. `null` si invalide. */
export function verifySessionToken(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const attendu = createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(attendu);
  // Comparaison à temps constant, et de même longueur : sinon la comparaison
  // renvoie un écart exploitable octet par octet.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload?.exp || payload.exp <= Date.now()) return null;
    if (payload.scope !== "master" && payload.scope !== "project") return null;
    return {
      scope: payload.scope,
      project: payload.project ?? null,
      name: payload.name ?? null,
      expires: payload.exp,
    };
  } catch {
    return null;
  }
}

export function sessionOf(req) {
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  return verifySessionToken(token);
}
export function requireAdmin(req, res, next) {
  if (!sessionOf(req)) return res.status(401).json({ error: "Authentification requise." });
  next();
}
export function requireMaster(req, res, next) {
  const session = sessionOf(req);
  if (!session) return res.status(401).json({ error: "Authentification requise." });
  if (session.scope !== "master")
    return res.status(403).json({ error: "Réservé à l'administrateur." });
  next();
}

// ── Connexion du dashboard ────────────────────────────────────────────────────────
// Sans nom de projet → administrateur (scope master) ; avec un nom de projet → ce
// dashboard dédié au projet (scope project, limité à ses caisses).
// ── Limitation de débit ────────────────────────────────────────────────────────────
// Sans elle, `POST /api/login` est une oracle de mots de passe : ADMIN_PASSWORD n'a pas
// de limite de longueur ni de tentatives, et le projet se teste en boucle. Verrouiller
// l'IP après N échecs rend l'énumération coûteuse sans jamais bloquer l'administrateur
// légitime (dont la session, une fois ouverte, tient SESSION_MS sans repasser par ici).
const LOGIN_MAX_FAILS = Number(process.env.LOGIN_MAX_FAILS ?? 8);
const LOGIN_LOCK_MS = Number(process.env.LOGIN_LOCK_MS ?? 15 * 60_000);
const loginFails = new Map(); // ip → { count, until }

function loginLocked(ip) {
  const e = loginFails.get(ip);
  if (!e) return 0;
  if (e.until && e.until > Date.now()) return e.until - Date.now();
  if (e.until && e.until <= Date.now()) loginFails.delete(ip);
  return 0;
}
function noteLoginFail(ip) {
  const e = loginFails.get(ip) ?? { count: 0, until: 0 };
  e.count += 1;
  if (e.count >= LOGIN_MAX_FAILS) e.until = Date.now() + LOGIN_LOCK_MS;
  loginFails.set(ip, e);
}
function clearLoginFail(ip) {
  loginFails.delete(ip);
}
// Purge périodique : la Map ne doit pas grossir avec des IP éphémères (proxies, mobile).
const loginSweep = setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of loginFails) if (e.until && e.until <= now) loginFails.delete(ip);
}, 60_000);
loginSweep.unref?.();

router.post("/api/login", async (req, res) => {
  const ip = req.socket.remoteAddress ?? "inconnu";
  const remaining = loginLocked(ip);
  if (remaining > 0) {
    return res
      .status(429)
      .json({ error: `Trop de tentatives. Réessayez dans ${Math.ceil(remaining / 60_000)} min.` });
  }

  const project = str(req.body?.project);
  const password = str(req.body?.password);
  let session;
  if (project) {
    const proj = await projectById(project);
    // `verifyPassword` accepte aussi le format haché ET l'ancien format clair — les
    // fiches projet créées avant le hachage restent utilisables, et se hachent au
    // premier login réussi.
    if (!proj || !verifyPassword(password, proj.password)) {
      noteLoginFail(ip);
      return res.status(401).json({ error: "Projet ou mot de passe incorrect." });
    }
    if (!isHashed(proj.password)) {
      await db.run("UPDATE projects SET password = $1 WHERE id = $2", await hashPassword(password), proj.id);
    }
    session = {
      scope: "project",
      project: proj.id,
      name: proj.name,
      expires: Date.now() + SESSION_MS,
    };
  } else {
    if (password !== ADMIN_PASSWORD) {
      noteLoginFail(ip);
      return res.status(401).json({ error: "Mot de passe incorrect." });
    }
    session = { scope: "master", expires: Date.now() + SESSION_MS };
  }
  clearLoginFail(ip);
  const token = signSession(session);
  console.log(
    `[${new Date().toISOString()}] LOGIN ${session.scope === "master" ? "master" : `projet "${session.name}"`} ip=${req.socket.remoteAddress} -> OK`,
  );
  res.json({ token, scope: session.scope, project: session.project ?? null, name: session.name ?? null });
});

router.get("/api/config", async (req, res) => {
  // ?project=<id> → tarif/essai du projet (celui du manifest ou réglé par le master),
  // sinon les valeurs globales. Le dashboard s'en sert pour l'aperçu « montant → jours ».
  const project = str(req.query.project);
  const cfg = await projectConfig(project || null);
  res.json({ price_per_month_fcfa: cfg.price_per_month_fcfa, trial_days: cfg.trial_days, project: project || null });
});

// ── SSE temps réel : le dashboard voit un client arriver sans rafraîchir ───────────
// Chaque tableau de bord connecté reçoit les handshakes des caisses. Une connexion
// "project" ne reçoit que les événements de SON projet ; le master reçoit tout.
// EventSource ne sachant pas envoyer d'en-tête Authorization, le token passe en query.
const sseClients = new Set(); // { res, scope, project }
const ssePing = setInterval(() => {
  for (const c of sseClients) {
    try {
      c.res.write(": ping\n\n");
    } catch {
      sseClients.delete(c);
    }
  }
}, 25_000);
ssePing.unref?.();

router.get("/api/events", (req, res) => {
  const session = sessionOf({ headers: { authorization: `Bearer ${str(req.query.token)}` } });
  if (!session) return res.status(401).json({ error: "Authentification requise." });
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  res.write(": connecté\n\n");
  const client = { res, scope: session.scope, project: session.project ?? null };
  sseClients.add(client);
  req.on("close", () => sseClients.delete(client));
});

export async function broadcastStatus(device_id, last_seen) {
  const shop = await byDeviceId(device_id);
  if (shop) {
    await logActivity("info", "sync", "Caisse synchronisée", `${shop.store_name} (${device_id})`, { device_id, last_seen }, shop.id, shop.account_id);
  }
  const payload = JSON.stringify({
    type: "status_update",
    device_id,
    last_seen,
    status: "online",
    origin: shop?.app_origin ?? "pos",
  });
  for (const c of sseClients) {
    if (c.scope === "project" && shop && shop.app_origin !== c.project) continue;
    try {
      c.res.write(`data: ${payload}\n\n`);
    } catch {
      sseClients.delete(c);
    }
  }
}

/**
 * Temps réel pour les DEMANDES d'abonnement : le tableau de bord voit la demande
 * arriver sans rafraîchir. Même découpage par projet que broadcastStatus.
 */
export async function broadcastRequest(request) {
  const account = await accountById(request.account_id);
  if (!account) return;
  const payload = JSON.stringify({
    type: "request_created",
    request_id: request.id,
    store_name: request.store_name,
    account_name: account.name,
    plan_price: request.plan_price,
    plan_devices: request.plan_devices,
    created_at: request.created_at,
  });
  for (const c of sseClients) {
    if (c.scope === "project" && !(await accountOriginOk(account, c.project))) continue;
    try {
      c.res.write(`data: ${payload}\n\n`);
    } catch {
      sseClients.delete(c);
    }
  }
}

export default router;