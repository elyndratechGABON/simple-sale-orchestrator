// ── App Express — partagée entre le serveur local (index.mjs) et Vercel (api/index.mjs) ──
// Construit l'application complète : middlewares, routeurs, dashboard statique, route de
// drain déclenchée par cron. Ne LANÇA aucun serveur ici : écouter est le travail de
// l'entrée qui l'appelle (serverless = pas de listen).
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import crypto from "node:crypto";

import { initialize } from "./config.mjs";
import { migrateShopsToAccounts, mergeAccountsByName } from "./lib.mjs";
import { drainRelayFromOps } from "./drainer.mjs";
import authRouter, { sessionOf } from "./routes/auth.mjs";
import entryRouter from "./routes/entry.mjs";
import adminRouter from "./routes/admin.mjs";
import ccRouter from "./routes/cc.mjs";
import restoreRouter from "./routes/restore.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Schéma Postgres (idempotent) + semence du projet 'pos', puis migration des fiches
// préexistantes vers le modèle par compte et convergence des enseignes dupliquées.
// Idempotent : les cold starts de functions serverless peuvent le rejouer sans risque.
await initialize();
await migrateShopsToAccounts();
await mergeAccountsByName();

const app = express();
// 2 Mo : le corps le plus volumineux legitimate est un `data_payload` d'agrégats ou
// quelques lignes de vente. Au-delà, c'est une tentative de saturer la fonction
// serverless — dont la mémoire ET le temps d'invocation sont facturés.
app.use(express.json({ limit: "2mb" }));

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
app.use(restoreRouter); // POST/GET /api/v1/restore — restauration depuis l'archive chiffrée

// ── Drainer SANS attente (cron Vercel) ──────────────────────────────────────────
// /api/v1/drain est appelé par le cron de vercel.json : il déclenche un cycle de copie
// du relais vers l'archive Neon et répond immédiatement (le travail continue en arrière-
// plan). Sur le serveur local, le drain tourne déjà par minuteur — la route est inoffensive.
// AUTHENTIFIÉ, par DEUX voies distinctes. Le drain purge le relais : `/api/v1/ops/purge`
// exige déjà un secret admin, laisser cette route ouverte permettait à n'importe qui de
// déclencher la purge — donc de faire disparaître des ventes pas encore archivées — en
// skippant ce secret.
//
//  1. `CRON_SECRET` — Vercel l'envoie en `Authorization: Bearer $CRON_SECRET` à chaque
//     tir programmé, et c'est le SEUL moyen de faire tourner le cron. Sans cette voie,
//     l'archivage quotidien s'arrête.
//  2. Une session master du Control Center — pour le tir manuel, qui doit rester
//     possible depuis le dashboard.
//
// `requireMaster` seul casserait le cron ; le secret seul casserait le tir manuel. Les
// deux sont exigés, et la comparaison est à temps constant.
const CRON_SECRET = process.env.CRON_SECRET ?? "";
const cronAuthed = (req) => {
  if (!CRON_SECRET) return false; // pas de secret configuré → cette voie est fermée
  const got = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got);
  const b = Buffer.from(CRON_SECRET);
  // Compare Length + contenu : un secret plus court ne doit pas « matcher » un préfixe.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// Tir manuel du drainer. Sur Vercel c'est le CRON QUOTIDIEN (cf. backend/vercel.json,
// crons -> /api/v1/drain) : c'est le SEUL chemin d'archivage en serverless, puisque
// index.mjs n'y est pas exécuté.
//
// ⚠️ Ne PAS conditionner cette route à OPS_DRAIN_ENABLED : le flag protège le
// démarrage automatique d'index.mjs (poste de dev), pas ce déclencheur. Le gatiller
// arrêterait l'archivage quotidien en production. Elle reste protégée par
// CRON_SECRET ou une session admin — donc un poste de dev ne peut la déclencher que
// par une action volontaire et authentifiée.
app.get("/api/v1/drain", (req, res) => {
  if (!cronAuthed(req) && !sessionOf(req)) {
    return res.status(401).json({ error: "Authentification requise." });
  }
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