// Serveur de l'orchestrateur : reçoit les inscriptions des caisses POS et sert le
// dashboard d'administration. À lancer sur le PC du commerçant (`npm run dev`) et à
// laisser ouvert — c'est lui que les boutiques joignent dès qu'elles ont une connexion.
import express from "express";
import type { NextFunction, Request, Response } from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADMIN_PASSWORD,
  PASSWORD_GENERATED,
  PORT,
  PRICE_PER_MONTH_FCFA,
  TRIAL_DAYS,
} from "./config.js";
import {
  extendShop,
  getShopById,
  listPayments,
  listShops,
  upsertShop,
} from "./db.js";

const app = express();
app.use(cors());
app.use(express.json());

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
app.use(express.static(PUBLIC_DIR));

// ── Sessions du dashboard ───────────────────────────────────────────────────────
// Le serveur est désormais joignable depuis Internet (tunnel Cloudflare ou IP
// publique) : le dashboard — qui montre les téléphones des boutiques — est protégé
// par un mot de passe. L'inscription d'une boutique reste, elle, publique : une
// nouvelle caisse s'annonce sans compte préalable, c'est le principe du système.
const SESSION_COOKIE = "orchestrator_session";
const SESSION_MS = 7 * 24 * 3600 * 1000;
const sessions = new Map<string, number>();

function sessionToken(req: Request): string | null {
  const cookie = req.headers.cookie;
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return null;
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const token = sessionToken(req);
  const expiry = token ? sessions.get(token) : undefined;
  if (!token || !expiry || expiry < Date.now()) {
    res.status(401).json({ error: "Authentification requise." });
    return;
  }
  next();
}

app.post("/api/login", (req, res) => {
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (password !== ADMIN_PASSWORD) {
    res.status(401).json({ error: "Mot de passe incorrect." });
    return;
  }
  const token = randomUUID();
  sessions.set(token, Date.now() + SESSION_MS);
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}`,
  );
  res.json({ ok: true });
});

app.post("/api/logout", requireAdmin, (req, res) => {
  const token = sessionToken(req);
  if (token) sessions.delete(token);
  res.json({ ok: true });
});

// Réglages affichés par le dashboard (prix du mois, durée d'essai).
app.get("/api/config", (_req, res) => {
  res.json({ price_per_month_fcfa: PRICE_PER_MONTH_FCFA, trial_days: TRIAL_DAYS });
});

/**
 * Une caisse s'annonce dès qu'elle a une connexion (démarrage, retour en ligne).
 * L'inscription est volontairement publique : une nouvelle boutique s'enregistre
 * sans compte, le dashboard protège les consultations et prolongations.
 */
app.post("/api/shops", (req, res) => {
  const body = req.body ?? {};
  const device_id = typeof body.device_id === "string" ? body.device_id.trim() : "";
  const owner_name = typeof body.owner_name === "string" ? body.owner_name.trim() : "";
  const store_name = typeof body.store_name === "string" ? body.store_name.trim() : "";
  // `owner_name` est facultatif : l'app crée la fiche dès le premier accès avec le nom de
  // la boutique (l'espace de travail de l'onboarding), le propriétaire se complète ensuite
  // dans les réglages — même appareil, même `device_id`, simple mise à jour ici.
  if (!device_id || !store_name) {
    res.status(400).json({
      error: "device_id et store_name sont requis.",
    });
    return;
  }
  const registered_at =
    typeof body.registered_at === "number" && Number.isFinite(body.registered_at)
      ? body.registered_at
      : Date.now();
  const shop = upsertShop({
    device_id,
    owner_name,
    store_name,
    phone: typeof body.phone === "string" ? body.phone : undefined,
    location: typeof body.location === "string" ? body.location : undefined,
    registration_date: registered_at,
  });
  // L'échéance renvoyée fait foi : l'app s'y aligne (cf. sync.ts côté app).
  res.json({ shop });
});

app.get("/api/shops", requireAdmin, (_req, res) => {
  res.json({ shops: listShops() });
});

app.get("/api/shops/:id", requireAdmin, (req, res) => {
  const shop = getShopById(Number(req.params.id));
  if (!shop) {
    res.status(404).json({ error: "Boutique introuvable." });
    return;
  }
  res.json({ shop });
});

app.get("/api/shops/:id/payments", requireAdmin, (req, res) => {
  res.json({ payments: listPayments(Number(req.params.id)) });
});

/** Prolongation : le dashboard reçoit un montant en FCFA, l'API ajoute les jours. */
app.post("/api/shops/:id/extend", requireAdmin, (req, res) => {
  const shop = getShopById(Number(req.params.id));
  if (!shop) {
    res.status(404).json({ error: "Boutique introuvable." });
    return;
  }
  const amount = Math.round(Number(req.body?.amount_fcfa));
  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: "Montant invalide." });
    return;
  }
  const days = Math.max(1, Math.round((amount / PRICE_PER_MONTH_FCFA) * 30));
  const updated = extendShop(shop.id, amount, days);
  res.json({ shop: updated });
});

app.listen(PORT, () => {
  console.log(`Orchestrateur prêt : http://localhost:${PORT}`);
  console.log(
    `Tarif ${PRICE_PER_MONTH_FCFA.toLocaleString("fr-FR")} FCFA/mois · Essai ${TRIAL_DAYS} jours`,
  );
  if (PASSWORD_GENERATED) {
    console.log(
      `Mot de passe du dashboard (ADMIN_PASSWORD non défini) : ${ADMIN_PASSWORD}`,
    );
  }
});
