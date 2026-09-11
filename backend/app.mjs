// ── App Express — partagée entre le serveur local (index.mjs) et Vercel (api/index.mjs) ──
// Construit l'application complète : middlewares, routeurs, dashboard statique, route de
// drain déclenchée par cron. Ne LANÇA aucun serveur ici : écouter est le travail de
// l'entrée qui l'appelle (serverless = pas de listen).
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { initialize } from "./config.mjs";
import { migrateShopsToAccounts, mergeAccountsByName } from "./lib.mjs";
import { drainRelayFromOps } from "./drainer.mjs";
import authRouter from "./routes/auth.mjs";
import entryRouter from "./routes/entry.mjs";
import adminRouter from "./routes/admin.mjs";
import ccRouter from "./routes/cc.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Schéma Postgres (idempotent) + semence du projet 'pos', puis migration des fiches
// préexistantes vers le modèle par compte et convergence des enseignes dupliquées.
// Idempotent : les cold starts de functions serverless peuvent le rejouer sans risque.
await initialize();
await migrateShopsToAccounts();
await mergeAccountsByName();

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

// ── Drainer SANS attente (cron Vercel) ──────────────────────────────────────────
// /api/v1/drain est appelé par le cron de vercel.json : il déclenche un cycle de copie
// du relais vers l'archive Neon et répond immédiatement (le travail continue en arrière-
// plan). Sur le serveur local, le drain tourne déjà par minuteur — la route est inoffensive.
app.get("/api/v1/drain", (_req, res) => {
  drainRelayFromOps()
    .then(() => console.log("[drainer] tir cron OK"))
    .catch((err) => console.error(`[drainer] échec cron : ${err.message}`));
  res.status(202).json({ started: true });
});

// ── Dashboard statique (build de /dashboard, si présent) ────────────────────────
const dashboardDist = join(__dirname, "..", "dashboard", "dist");
if (existsSync(dashboardDist)) {
  app.use(express.static(dashboardDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(dashboardDist, "index.html")));
} else {
  app.get(["/", "/admin"], (_req, res) => {
    res
      .status(200)
      .send(
        "Orchestrateur v3 — dashboard pas encore construit. " +
          "Lancez `npm install && npm run build` dans /dashboard, ou utilisez `npm run dev`.",
      );
  });
}

export { app };