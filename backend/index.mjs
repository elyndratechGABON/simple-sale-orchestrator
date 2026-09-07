// ── Orchestrateur v3 — assembleur ─────────────────────────────────────────────────
// Point d'entrée : charge la config (db, constantes, manifests), les helpers partagés
// et les routeurs, puis monte l'application Express.
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import express from "express";

import { db, PORT, PRICE_TIERS, TRIAL_DAYS, EXPLICIT, ADMIN_PASSWORD, OPS_DRAIN_INTERVAL_MS } from "./config.mjs";
import { migrateShopsToAccounts, mergeAccountsByName, byDeviceId } from "./lib.mjs";
import { logActivity } from "./routes/audit.mjs";
import { drainRelayFromOps } from "./drainer.mjs";
import authRouter from "./routes/auth.mjs";
import entryRouter from "./routes/entry.mjs";
import adminRouter from "./routes/admin.mjs";
import ccRouter from "./routes/cc.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Migration des fiches préexistantes vers le modèle par compte (idempotent), puis
// convergence des enseignes dupliquées (idempotent, loggé à chaque fusion).
migrateShopsToAccounts();
mergeAccountsByName();

const app = express();
app.use(express.json());

// Logging info : chaque requête reçue (méthode, chemin, statut, durée, origine).
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    const mark = res.statusCode >= 500 ? "ERR " : res.statusCode >= 400 ? "WARN" : "info";
    console.log(
      `[${new Date().toISOString()}] ${mark} ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms) ip=${req.socket.remoteAddress}`,
    );
  });
  next();
});

// CORS : les caisses s'annoncent depuis un autre domaine que celui-ci.
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── Routeurs ─────────────────────────────────────────────────────────────────────
app.use(authRouter); //  POST /api/login, GET /api/config, GET /api/events
app.use(entryRouter); // protocole caisse : handshake, sync-data, demandes, webhook SMS
app.use(adminRouter); // routes admin legacy + gestion fiches
app.use(ccRouter); // Control Center

// ── Dashboard static (build de /dashboard, si présent) ────────────────────────────
const dashboardDist = join(__dirname, "..", "dashboard", "dist");
if (existsSync(dashboardDist)) {
  app.use(express.static(dashboardDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(dashboardDist, "index.html")));
} else {
  app.get(["/", "/admin"], (_req, res) => {
    res
      .status(200)
      .send(
        "Orchestrateur v2 — dashboard pas encore construit. " +
          "Lancez `npm install && npm run build` dans /dashboard, ou utilisez `npm run dev`.",
      );
  });
}

const server = createServer(app);
server.listen(PORT, () => {
  console.log(`Orchestrateur v3 prêt : http://localhost:${PORT}`);
  console.log(
    `Paliers : ${PRICE_TIERS.map((t) => `${t.price.toLocaleString("fr-FR")} F = ${t.devices} appareils`).join(" · ")} · Essai ${TRIAL_DAYS} jours`,
  );
  if (!EXPLICIT) console.log(`Mot de passe du dashboard (défaut généré) : ${ADMIN_PASSWORD}`);
});

// ── Drainer du relais ops ────────────────────────────────────────────────────────
// Copie à la mise en service, puis toutes les OPS_DRAIN_INTERVAL_MS : les ops posées
// pendant la coupure chez le relais (Neon, toujours allumé) entrent dans l'archive
// SQLite et la place est libérée quand tous les appareils ont tiré (fraîcheur relais).
setImmediate(() => {
  drainRelayFromOps().catch((err) => console.error("[drainer] échec de démarrage :", err));
});
setInterval(() => {
  drainRelayFromOps().catch((err) => console.error("[drainer] échec :", err));
}, OPS_DRAIN_INTERVAL_MS).unref();
