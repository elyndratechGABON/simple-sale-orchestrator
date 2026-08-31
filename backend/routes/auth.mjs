// Connexion du dashboard + SSE temps réel + sessions (scopées par projet).
import { Router } from "express";
import { randomUUID } from "node:crypto";
import { SESSION_MS, ADMIN_PASSWORD, projectById, projectConfig } from "../config.mjs";
import { str, byDeviceId, accountById, accountOriginOk } from "../lib.mjs";
import { logActivity } from "./audit.mjs";

const router = Router();

// ── Sessions admin (en mémoire, scopées par projet) ───────────────────────────────
export const sessions = new Map(); // token → { scope: "master" } | { scope: "project", project, name }
export function sessionOf(req) {
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const session = sessions.get(token);
  if (!session || session.expires <= Date.now()) return null;
  return session;
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
router.post("/api/login", (req, res) => {
  const project = str(req.body?.project);
  const password = str(req.body?.password);
  let session;
  if (project) {
    const proj = projectById(project);
    if (!proj || password !== proj.password)
      return res.status(401).json({ error: "Projet ou mot de passe incorrect." });
    session = {
      scope: "project",
      project: proj.id,
      name: proj.name,
      expires: Date.now() + SESSION_MS,
    };
  } else {
    if (password !== ADMIN_PASSWORD)
      return res.status(401).json({ error: "Mot de passe incorrect." });
    session = { scope: "master", expires: Date.now() + SESSION_MS };
  }
  for (const [t, e] of sessions) if (e.expires <= Date.now()) sessions.delete(t);
  const token = randomUUID();
  sessions.set(token, session);
  console.log(
    `[${new Date().toISOString()}] LOGIN ${session.scope === "master" ? "master" : `projet "${session.name}"`} ip=${req.socket.remoteAddress} -> OK`,
  );
  res.json({ token, scope: session.scope, project: session.project ?? null, name: session.name ?? null });
});

router.get("/api/config", (req, res) => {
  // ?project=<id> → tarif/essai du projet (celui du manifest ou réglé par le master),
  // sinon les valeurs globales. Le dashboard s'en sert pour l'aperçu « montant → jours ».
  const project = str(req.query.project);
  const cfg = projectConfig(project || null);
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

export function broadcastStatus(device_id, last_seen) {
  const shop = byDeviceId(device_id);
  if (shop) {
    logActivity("info", "sync", "Caisse synchronisée", `${shop.store_name} (${device_id})`, { device_id, last_seen }, shop.id, shop.account_id);
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
export function broadcastRequest(request) {
  const account = accountById(request.account_id);
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
    if (c.scope === "project" && !accountOriginOk(account, c.project)) continue;
    try {
      c.res.write(`data: ${payload}\n\n`);
    } catch {
      sseClients.delete(c);
    }
  }
}

export default router;
