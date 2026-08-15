// Orchestrateur v2 — boîte aux lettres + gatekeeper.
//
//   npm run dev          (dans /backend)   → http://localhost:8787
//
// Remplaçant de server.mjs (devenu legacy) : il reprend le MÊME fichier SQLite
// (orchestrator/data/orchestrator.db, données existantes conservées) et le même port.
//
// Protocole v2 — « Principe du tourniquet » : le serveur ne pousse JAMAIS rien. Le
// client sonne (handshake), repart avec les ordres non livrés (suspend / renew /
// broadcast_message), les applique, puis — seulement si son statut est « active » —
// pousse ses données via /sync-data. L'accusé de réception est implicite : au handshake
// suivant, le serveur marque livrées toutes les commandes antérieures au dernier id
// appliqué par le client.
//
// Node ≥ 22.5 requis (module natif node:sqlite). Express est la seule dépendance.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";

const require = createRequire(import.meta.url);
const express = require("express");

const __dirname = dirname(fileURLToPath(import.meta.url));

// Chargement d'un `.env` local (jamais versionné) : permet de fixer ADMIN_PASSWORD sans
// toucher au code ni à la console. Les variables déjà présentes dans l'environnement
// restent prioritaires (utile en déploiement, où le secret vit hors du dépôt).
const envFile = join(__dirname, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#") || m[1] in process.env) continue;
    process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
}

const PORT = Number(process.env.PORT ?? 8787);
const PRICE_PER_MONTH_FCFA = Number(process.env.PRICE_PER_MONTH_FCFA ?? 10_000);
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS ?? 30);
const DAY_MS = 86_400_000;
// Durée de validité d'un ordre avant qu'il ne soit déclaré « non délivré (expiré) ».
const COMMAND_TTL_MS = 30 * DAY_MS;
const SESSION_MS = 7 * 24 * 3600 * 1000;

const EXPLICIT =
  typeof process.env.ADMIN_PASSWORD === "string" && process.env.ADMIN_PASSWORD.length > 0;
const ADMIN_PASSWORD = EXPLICIT ? process.env.ADMIN_PASSWORD : randomBytes(8).toString("hex");

// ── Projets ────────────────────────────────────────────────────────────────────────
// Chaque projet a son propre dashboard dédié (mot de passe indépendant). La caisse
// appartient à un projet via `shops.app_origin` (défaut 'pos'). La connexion sans nom
// de projet est l'administrateur (scope "master"), qui voit et gère TOUT. Le projet de
// référence 'pos' est semé après l'ouverture de la base (cf. plus bas).
//
// Un projet peut être adossé à un MANIFEST (dossier `backend/manifests/*.json`) : le
// fichier décrit le type d'app, son tarif et ses KPI. Généré par `tools/project-scanner`
// pour chaque app du réseau. Quand un handshake arrive avec un `app_origin` inconnu,
// le manifest correspondant (s'il existe) sert à provisionner le projet correctement.
const projectById = (id) => db.prepare("SELECT * FROM projects WHERE id = ?").get(id);

// ── Registre des manifests (types de projet connus) ────────────────────────────────
const MANIFESTS_DIR = join(__dirname, "manifests");
const manifests = new Map();
if (existsSync(MANIFESTS_DIR)) {
  for (const file of readdirSync(MANIFESTS_DIR).filter((f) => f.endsWith(".json"))) {
    try {
      const m = JSON.parse(readFileSync(join(MANIFESTS_DIR, file), "utf8"));
      if (m && typeof m.id === "string" && m.id) manifests.set(m.id, m);
      else console.warn(`[manifest] ignoré (${file}) : id manquant.`);
    } catch (e) {
      console.warn(`[manifest] ignoré (${file}) : ${e.message}`);
    }
  }
}
console.log(
  `[manifest] ${manifests.size} type(s) de projet chargé(s) : ${[...manifests.keys()].join(", ") || "—"}`,
);

// ── Base SQLite (même fichier que l'ancien server.mjs) ────────────────────────────
// ORCHESTRATOR_DB permet de pointer ailleurs (tests, déploiement) ; défaut : la base
// historique de l'orchestrateur.
const DATA_DIR = join(__dirname, "..", "orchestrator", "data");
mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = process.env.ORCHESTRATOR_DB
  ? resolve(process.env.ORCHESTRATOR_DB)
  : join(DATA_DIR, "orchestrator.db");
const db = new DatabaseSync(DB_FILE);

db.exec("PRAGMA journal_mode = WAL;");
db.exec(readFileSync(join(__dirname, "migrations.sql"), "utf8"));

// Colonnes ajoutées aux tables préexistantes (SQLite n'a pas `ADD COLUMN IF NOT EXISTS`).
function columnNames(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}
const shopsColumns = columnNames("shops");
const addShopColumn = (name, ddl) => {
  if (!shopsColumns.includes(name)) db.exec(`ALTER TABLE shops ADD COLUMN ${ddl}`);
};
addShopColumn("suspended_at", "suspended_at INTEGER");
addShopColumn("app_version_used", "app_version_used TEXT");
addShopColumn("last_sync_at", "last_sync_at INTEGER");
addShopColumn("app_origin", "app_origin TEXT NOT NULL DEFAULT 'pos'");

// Colonnes projets ajoutées (tarif, essai, type) — pilotées par manifest, ou réglées à
// la main par le master. SQLite n'a pas `ADD COLUMN IF NOT EXISTS`.
const projectColumns = columnNames("projects");
const addProjectColumn = (name, ddl) => {
  if (!projectColumns.includes(name)) db.exec(`ALTER TABLE projects ADD COLUMN ${ddl}`);
};
addProjectColumn("type", "type TEXT");
addProjectColumn("price_per_month_fcfa", "price_per_month_fcfa INTEGER");
addProjectColumn("trial_days", "trial_days INTEGER");

// ── Tarif & essai effectifs d'un projet ─────────────────────────────────────────────
// Priorité : valeur enregistrée sur le projet > manifest du même id > valeurs globales.
function projectConfig(origin) {
  const proj = origin ? projectById(origin) : null;
  if (proj?.price_per_month_fcfa != null || proj?.trial_days != null) {
    return {
      price_per_month_fcfa: proj.price_per_month_fcfa ?? PRICE_PER_MONTH_FCFA,
      trial_days: proj.trial_days ?? TRIAL_DAYS,
    };
  }
  const m = origin ? manifests.get(origin) : null;
  return {
    price_per_month_fcfa: m?.pricing?.price_per_month_fcfa ?? PRICE_PER_MONTH_FCFA,
    trial_days: m?.pricing?.trial_days ?? TRIAL_DAYS,
  };
}

// Projet de référence : 'pos' prend le mot de passe admin par défaut, pour que la
// connexion historique (sans nom de projet) retrouve son dashboard. Tarif/essai/type
// initialisés depuis son manifest s'il existe.
{
  const seedCfg = projectConfig("pos");
  db.prepare(
    `INSERT OR IGNORE INTO projects
       (id, name, password, created_at, type, price_per_month_fcfa, trial_days)
     VALUES ('pos', 'Caisse', ?, ?, ?, ?, ?)`,
  ).run(ADMIN_PASSWORD, Date.now(), seedCfg.type ?? null, seedCfg.price_per_month_fcfa, seedCfg.trial_days);
}

// ── Requêtes ───────────────────────────────────────────────────────────────────────
const byId = (id) => db.prepare("SELECT * FROM shops WHERE id = ?").get(id);
const byDeviceId = (deviceId) =>
  db.prepare("SELECT * FROM shops WHERE device_id = ?").get(deviceId);

const listShops = (origin) =>
  db
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM payments p WHERE p.shop_id = s.id) AS payments
       FROM shops s ${origin ? "WHERE s.app_origin = ?" : ""} ORDER BY s.expiry_date ASC`,
    )
    .all(...(origin ? [origin] : []));

function computeStatus(shop) {
  if (!shop) return "unknown";
  if (shop.suspended_at) return "suspended";
  if (shop.expiry_date <= Date.now()) return "expired";
  return "active";
}

function publicShop(shop) {
  return {
    device_id: shop.device_id,
    owner_name: shop.owner_name,
    store_name: shop.store_name,
    phone: shop.phone ?? null,
    location: shop.location ?? null,
    registration_date: shop.registration_date,
    // L'échéance fait foi côté client (l'app s'y aligne).
    subscription_end_date: shop.expiry_date,
    expiry_date: shop.expiry_date,
    suspended_at: shop.suspended_at ?? null,
    app_version_used: shop.app_version_used ?? null,
    app_origin: shop.app_origin ?? "pos",
  };
}

const str = (v) => (typeof v === "string" ? v.trim() : "");
const optStr = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Upsert d'une boutique — partagé par l'inscription legacy et le handshake. */
function upsertShop(body) {
  const device_id = str(body.device_id);
  const store_name = str(body.store_name);
  if (!device_id || !store_name)
    return { error: "device_id et store_name sont requis.", status: 400 };
  const owner_name = str(body.owner_name);
  const phone = optStr(body.phone);
  const location = optStr(body.location);
  const app_version_used = optStr(body.app_version_used);
  const registered_at =
    typeof body.registered_at === "number" && Number.isFinite(body.registered_at)
      ? body.registered_at
      : Date.now();
  const now = Date.now();
  const existing = byDeviceId(device_id);
  if (existing) {
    db.prepare(
      `UPDATE shops
       SET owner_name = ?, store_name = ?, phone = ?, location = ?,
           app_version_used = COALESCE(?, app_version_used), updated_at = ?
       WHERE id = ?`,
    ).run(owner_name, store_name, phone, location, app_version_used, now, existing.id);
    return { shop: byId(existing.id), status: 200 };
  }
  db.prepare(
    `INSERT INTO shops
       (device_id, owner_name, store_name, phone, location, registration_date,
        expiry_date, created_at, updated_at, app_version_used)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    device_id,
    owner_name,
    store_name,
    phone,
    location,
    registered_at,
    registered_at + TRIAL_DAYS * DAY_MS,
    now,
    now,
    app_version_used,
  );
  return { shop: byDeviceId(device_id), status: 200 };
}

// ── Sessions admin (en mémoire, scopées par projet) ───────────────────────────────
const sessions = new Map(); // token → { scope: "master" } | { scope: "project", project, name }
function sessionOf(req) {
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const session = sessions.get(token);
  if (!session || session.expires <= Date.now()) return null;
  return session;
}
function requireAdmin(req, res, next) {
  if (!sessionOf(req)) return res.status(401).json({ error: "Authentification requise." });
  next();
}
function requireMaster(req, res, next) {
  const session = sessionOf(req);
  if (!session) return res.status(401).json({ error: "Authentification requise." });
  if (session.scope !== "master")
    return res.status(403).json({ error: "Réservé à l'administrateur." });
  next();
}

// ── Serveur ───────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Logging info : chaque requête reçue (méthode, chemin, statut, durée, origine).
// Aide à diagnostiquer « la page ne bouge pas » côté dashboard ou caisse — si une
// requête n'apparaît pas ici, elle n'arrive jamais au backend.
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

// ── Connexion du dashboard ────────────────────────────────────────────────────────
// Sans nom de projet → administrateur (scope master) ; avec un nom de projet → ce
// dashboard dédié au projet (scope project, limité à ses caisses).
app.post("/api/login", (req, res) => {
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

app.get("/api/config", (req, res) => {
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

app.get("/api/events", (req, res) => {
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

function broadcastStatus(device_id, last_seen) {
  const shop = byDeviceId(device_id);
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

// ── Protocole v2 : handshake ──────────────────────────────────────────────────────
app.post("/api/v1/handshake", (req, res) => {
  const body = req.body ?? {};
  const device_id = str(body.device_id);
  if (!device_id) return res.status(400).json({ error: "device_id requis." });
  const now = Date.now();

  // Accusé de réception implicite : le client a appliqué jusqu'à ce commande — tout ce
  // qui a été émis avant elle est considéré livré. Idempotent : les ids déjà livrés ne
  // ressortent jamais des requêtes suivantes.
  const lastId = str(body.last_applied_command_id);
  if (lastId) {
    const last = db
      .prepare("SELECT created_at FROM admin_commands WHERE device_id = ? AND id = ?")
      .get(device_id, lastId);
    if (last) {
      db.prepare(
        `UPDATE admin_commands SET delivered_at = ?
         WHERE device_id = ? AND delivered_at IS NULL AND created_at <= ?`,
      ).run(now, device_id, last.created_at);
    }
  }

  // La caisse sonne avec son identité seule : mise à jour douce des champs fournis,
  // création avec le nom d'espace de travail si inconnue (jamais d'erreur bloquante).
  const app_version_used = optStr(body.app_version);
  const app_origin = str(body.app_origin) || "pos";

  // Le projet cible est créé s'il n'existe pas : une caisse qui arrive avec un
  // app_origin inconnu est rattachée à un projet auto-créé (mot de passe aléatoire),
  // que l'administrateur reprend ensuite dans son dashboard master. Si un manifest
  // existe pour cet app_origin, il fixe d'emblée nom, type et tarif du projet.
  if (!projectById(app_origin)) {
    const m = manifests.get(app_origin);
    db.prepare(
      `INSERT INTO projects (id, name, password, created_at, type, price_per_month_fcfa, trial_days)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      app_origin,
      m?.name ?? app_origin,
      randomBytes(8).toString("hex"),
      now,
      m?.type ?? null,
      m?.pricing?.price_per_month_fcfa ?? null,
      m?.pricing?.trial_days ?? null,
    );
    console.log(
      `[${new Date().toISOString()}] PROJET auto-créé "${app_origin}"${m ? ` (manifest « ${m.name} »)` : ""} (mot de passe aléatoire) — à sécuriser depuis le dashboard master`,
    );
  }

  const projectCfg = projectConfig(app_origin);

  let shop = byDeviceId(device_id);
  if (shop) {
    db.prepare(
      `UPDATE shops SET
         owner_name     = COALESCE(?, owner_name),
         store_name     = COALESCE(?, store_name),
         phone          = COALESCE(?, phone),
         location       = COALESCE(?, location),
         app_version_used = COALESCE(?, app_version_used),
         app_origin     = ?,
         updated_at     = ?
       WHERE id = ?`,
    ).run(
      optStr(body.owner_name),
      optStr(body.store_name),
      optStr(body.phone),
      optStr(body.location),
      app_version_used,
      app_origin,
      now,
      shop.id,
    );
    shop = byId(shop.id);
  } else {
    db.prepare(
      `INSERT INTO shops
         (device_id, owner_name, store_name, phone, location, registration_date,
          expiry_date, created_at, updated_at, app_version_used, app_origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      device_id,
      optStr(body.owner_name) ?? "",
      optStr(body.store_name) ?? "Boutique",
      optStr(body.phone),
      optStr(body.location),
      now,
      now + projectCfg.trial_days * DAY_MS,
      now,
      now,
      app_version_used,
      app_origin,
    );
    shop = byDeviceId(device_id);
  }

  // Temps réel : chaque tableau de bord connecté (SSE) voit ce client arriver,
  // dans son projet si sa session y est limitée.
  broadcastStatus(device_id, now);

  const commands = db
    .prepare(
      `SELECT id, action_type, payload, expires_at, created_at
       FROM admin_commands
       WHERE device_id = ? AND delivered_at IS NULL AND superseded_at IS NULL
         AND expires_at > ?
       ORDER BY created_at ASC`,
    )
    .all(device_id, now)
    .map((c) => ({ ...c, payload: JSON.parse(c.payload) }));

  const st = computeStatus(shop);
  res.json({
    status: st,
    sync_allowed: st === "active",
    commands,
    shop: publicShop(shop),
  });
});

// ── Protocole v2 : sync-data (stockage brut, gated sur le statut) ─────────────────
app.post("/api/v1/sync-data", (req, res) => {
  const body = req.body ?? {};
  const device_id = str(body.device_id);
  if (!device_id || body.data_payload === undefined)
    return res.status(400).json({ error: "device_id et data_payload requis." });

  const shop = byDeviceId(device_id);
  if (!shop || computeStatus(shop) !== "active") {
    // 403 SANS rien écrire : une caisse suspendue ne dépose aucune donnée.
    return res.status(403).json({ error: "Compte suspendu ou expiré.", status: "blocked" });
  }

  const origin = typeof body.app_origin === "string" && body.app_origin.trim() ? body.app_origin.trim() : "pos";
  const now = Date.now();
  db.prepare(
    "INSERT INTO sync_payloads (device_id, app_origin, payload, received_at) VALUES (?, ?, ?, ?)",
  ).run(device_id, origin, JSON.stringify(body.data_payload), now);
  db.prepare("UPDATE shops SET last_sync_at = ?, updated_at = ? WHERE id = ?").run(now, now, shop.id);
  res.json({ ok: true, received_at: now, status: "active" });
});

// ── Protocole v2 : commandes admin (boîte aux lettres) ────────────────────────────
app.post("/api/v1/admin/commands", requireAdmin, (req, res) => {
  const body = req.body ?? {};
  const device_id = str(body.device_id);
  const action_type = str(body.action_type);
  const shop = byDeviceId(device_id);
  if (!shop) return res.status(404).json({ error: "Boutique introuvable." });
  const session = sessionOf(req);
  if (session.scope === "project" && shop.app_origin !== session.project)
    return res.status(403).json({ error: "Boutique hors de ce projet." });
  if (!["suspend", "renew", "broadcast_message"].includes(action_type))
    return res.status(400).json({ error: "action_type inconnu." });

  const now = Date.now();
  // Idempotence : un ordre de même action encore en attente est remplacé — « Prolonger »
  // cliqué trois fois ne produit qu'UNE prolongation, la dernière.
  db.prepare(
    `UPDATE admin_commands SET superseded_at = ?
     WHERE device_id = ? AND action_type = ? AND delivered_at IS NULL AND superseded_at IS NULL`,
  ).run(now, device_id, action_type);

  let payload;
  let applyStatus = null;
  if (action_type === "suspend") {
    payload = {};
    // L'état compte dès la commande : une caisse hors ligne doit rester suspendue au
    // prochain handshake même si elle n'a jamais reçu l'ordre.
    applyStatus = () =>
      db.prepare("UPDATE shops SET suspended_at = ?, updated_at = ? WHERE id = ?").run(now, now, shop.id);
  } else if (action_type === "renew") {
    // Deux saisies possibles : un nombre de jours explicite, ou un montant encaissé
    // (en FCFA) converti en jours selon le tarif du projet. Le montant prime.
    const daysInput = Math.round(Number(body.days));
    const amount = Math.round(Number(body.amount_fcfa));
    let days;
    if (Number.isFinite(amount) && amount > 0) {
      const price = projectConfig(shop.app_origin).price_per_month_fcfa;
      days = Math.max(1, Math.round((amount / price) * 30));
    } else if (Number.isFinite(daysInput) && daysInput > 0) {
      days = daysInput;
    } else {
      return res.status(400).json({ error: "days ou amount_fcfa requis." });
    }
    const new_end_date = Math.max(now, shop.expiry_date) + days * DAY_MS;
    payload = { new_end_date, days, ...(amount > 0 ? { amount_fcfa: amount } : {}) };
    // Prolonger relance aussi l'abonnement : la suspension est levée. Un montant
    // encaissé est tracé dans `payments` (historique de facturation par caisse).
    applyStatus = () => {
      db.prepare("UPDATE shops SET suspended_at = NULL, expiry_date = ?, updated_at = ? WHERE id = ?").run(
        new_end_date,
        now,
        shop.id,
      );
      if (amount > 0) {
        db.prepare(
          "INSERT INTO payments (shop_id, amount, days_added, created_at) VALUES (?, ?, ?, ?)",
        ).run(shop.id, amount, days, now);
      }
    };
  } else {
    const message = str(body.message);
    if (!message) return res.status(400).json({ error: "message vide." });
    payload = { message_text: message };
  }

  const id = randomUUID();
  const expires_at = now + COMMAND_TTL_MS;
  applyStatus();
  db.prepare(
    "INSERT INTO admin_commands (id, device_id, action_type, payload, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, device_id, action_type, JSON.stringify(payload), expires_at, now);

  res.status(201).json({
    command: { id, device_id, action_type, payload, expires_at, created_at: now, delivered_at: null },
    shop: publicShop(byId(shop.id)),
  });
});

// ── Protocole v2 : listes admin ───────────────────────────────────────────────────
app.get("/api/v1/admin/shops", requireAdmin, (req, res) => {
  const now = Date.now();
  const session = sessionOf(req);
  // Scope projet → ses caisses uniquement. Master → tout, ou `?project=` pour filtrer.
  const scopeOrigin =
    session.scope === "project" ? session.project : str(req.query.project) || null;
  const shops = listShops(scopeOrigin).map((s) => {
    const lastCommand = db
      .prepare(
        `SELECT id, action_type, payload, expires_at, created_at, delivered_at, superseded_at
         FROM admin_commands WHERE device_id = ? AND superseded_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(s.device_id);
    const expired = db
      .prepare(
        `SELECT COUNT(*) AS c FROM admin_commands
         WHERE device_id = ? AND delivered_at IS NULL AND superseded_at IS NULL AND expires_at <= ?`,
      )
      .get(s.device_id, now).c;
    return {
      ...publicShop(s),
      id: s.id,
      last_sync_at: s.last_sync_at ?? null,
      payments: s.payments,
      status: computeStatus(s),
      last_command: lastCommand
        ? {
            id: lastCommand.id,
            action_type: lastCommand.action_type,
            payload: JSON.parse(lastCommand.payload),
            expires_at: lastCommand.expires_at,
            created_at: lastCommand.created_at,
            delivered_at: lastCommand.delivered_at ?? null,
          }
        : null,
      expired_commands: expired,
    };
  });
  res.json({ shops });
});

app.get("/api/v1/admin/shops/:device_id/commands", requireAdmin, (req, res) => {
  const device_id = str(req.params.device_id);
  const session = sessionOf(req);
  const shop = byDeviceId(device_id);
  if (!shop) return res.status(404).json({ error: "Boutique introuvable." });
  if (session.scope === "project" && shop.app_origin !== session.project)
    return res.status(403).json({ error: "Boutique hors de ce projet." });
  const rows = db
    .prepare(
      `SELECT id, action_type, payload, expires_at, created_at, delivered_at, superseded_at
       FROM admin_commands WHERE device_id = ?
       ORDER BY created_at DESC`,
    )
    .all(device_id);
  res.json({
    commands: rows.map((c) => ({ ...c, payload: JSON.parse(c.payload) })),
  });
});

// ── Historique des paiements d'une caisse (facturation des prolongations) ─────────
app.get("/api/v1/admin/shops/:device_id/payments", requireAdmin, (req, res) => {
  const device_id = str(req.params.device_id);
  const session = sessionOf(req);
  const shop = byDeviceId(device_id);
  if (!shop) return res.status(404).json({ error: "Boutique introuvable." });
  if (session.scope === "project" && shop.app_origin !== session.project)
    return res.status(403).json({ error: "Boutique hors de ce projet." });
  res.json({
    payments: db
      .prepare("SELECT * FROM payments WHERE shop_id = ? ORDER BY created_at DESC")
      .all(shop.id),
  });
});

// ── Liste publique des projets (id + nom seulement) : sert au sélecteur du login. ──
// Aucune donnée sensible : pas de mot de passe, pas de compteurs.
app.get("/api/v1/public/projects", (_req, res) => {
  res.json({
    projects: db.prepare("SELECT id, name FROM projects ORDER BY name ASC").all(),
  });
});

// ── Protocole v2 : stats réelles par projet (agrégées depuis sync_payloads) ───────
// Le dashboard affiche les données que les caisses déposent réellement. Chaque caisse
// envoie une fenêtre glissante de 7 j déjà cumulée : on ne retient donc que le DERNIER
// payload par caisse, puis on somme les totaux du projet. Top produits agrégés par nom.
// Jamais le brut : uniquement des totaux et des top produits.
function aggregateStats(shops) {
  const zero = { revenue: 0, profit: 0, sales: 0, items: 0, customers: 0 };
  if (shops.length === 0)
    return { generated_at: null, totals: zero, top_products: [], by_day: [], shops: [] };

  const ids = shops.map((s) => s.device_id);
  const rows = db
    .prepare(
      `SELECT sp.device_id, sp.payload, sp.received_at
       FROM sync_payloads sp
       JOIN (SELECT device_id, MAX(received_at) AS m FROM sync_payloads GROUP BY device_id) t
         ON sp.device_id = t.device_id AND sp.received_at = t.m
       WHERE sp.device_id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids);

  const byDevice = new Map();
  for (const row of rows) {
    let p;
    try {
      p = JSON.parse(row.payload);
    } catch {
      continue;
    }
    const t = p.totals ?? {};
    byDevice.set(row.device_id, {
      last_sync_at: row.received_at,
      totals: {
        revenue: Number(t.revenue) || 0,
        profit: Number(t.profit) || 0,
        sales: Number(t.sales) || 0,
        items: Number(t.items) || 0,
        customers: Number(t.customers) || 0,
      },
      top_products: Array.isArray(p.top_products) ? p.top_products : [],
      by_day: Array.isArray(p.by_day) ? p.by_day : [],
    });
  }

  const totals = { ...zero };
  const top = new Map();
  const dayAgg = new Map();
  let generated_at = null;
  for (const st of byDevice.values()) {
    for (const k of Object.keys(totals)) totals[k] += st.totals[k];
    generated_at = Math.max(generated_at ?? 0, st.last_sync_at);
    for (const prod of st.top_products) {
      const name = String(prod.name ?? "—");
      const cur = top.get(name) ?? { name, quantity: 0, revenue: 0 };
      cur.quantity += Number(prod.quantity) || 0;
      cur.revenue += Number(prod.revenue) || 0;
      top.set(name, cur);
    }
    // Série chronologique du projet : les fenêtres glissantes de 7 j de chaque caisse
    // sont sommées jour par jour (même jour = même cumul).
    for (const d of st.by_day) {
      const day = Number(d?.day) || 0;
      if (!day) continue;
      const cur = dayAgg.get(day) ?? { day, revenue: 0, profit: 0, sales: 0 };
      cur.revenue += Number(d.revenue) || 0;
      cur.profit += Number(d.profit) || 0;
      cur.sales += Number(d.sales) || 0;
      dayAgg.set(day, cur);
    }
  }

  return {
    generated_at,
    totals,
    top_products: [...top.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 5),
    by_day: [...dayAgg.values()].sort((a, b) => a.day - b.day),
    shops: shops
      .filter((s) => byDevice.has(s.device_id))
      .map((s) => ({ device_id: s.device_id, store_name: s.store_name, ...byDevice.get(s.device_id) })),
  };
}

// ── Vue Abonnements (comptes + MRR) — agrégée côté serveur pour rester cohérente. ──
// MRR estimé = somme des tarifs mensuels des comptes ACTIFS du scope. Un compte actif
// est « expirant » quand son échéance est sous 7 ou 30 jours. L'échéance fait foi.
function computeSubscriptions(shops) {
  const now = Date.now();
  const s = {
    total: shops.length,
    active: 0,
    suspended: 0,
    expired: 0,
    online: 0,
    expiring_7d: 0,
    expiring_30d: 0,
    mrr_fcfa: 0,
  };
  for (const shop of shops) {
    const st = computeStatus(shop);
    if (st === "active") s.active++;
    else if (st === "suspended") s.suspended++;
    else if (st === "expired") s.expired++;
    if (shop.last_sync_at && now - shop.last_sync_at < ONLINE_WINDOW_MS) s.online++;
    if (st === "active") {
      const left = shop.expiry_date - now;
      if (left <= 7 * DAY_MS) s.expiring_7d++;
      if (left <= 30 * DAY_MS) s.expiring_30d++;
      s.mrr_fcfa += projectConfig(shop.app_origin).price_per_month_fcfa;
    }
  }
  return s;
}

// Une caisse est « en ligne » si on a eu de ses nouvelles il y a moins de 2 minutes.
const ONLINE_WINDOW_MS = 120_000;

app.get("/api/v1/admin/stats", requireAdmin, (req, res) => {
  const session = sessionOf(req);
  // Scope projet → ses caisses uniquement. Master → tout, ou `?project=` pour filtrer.
  const origin =
    session.scope === "project" ? session.project : str(req.query.project) || null;
  const shops = listShops(origin);
  res.json({
    project: origin,
    subscriptions: computeSubscriptions(shops),
    ...aggregateStats(shops),
  });
});

// ── Protocole v2 : gestion des projets (master uniquement) ────────────────────────
app.get("/api/v1/admin/projects", requireMaster, (_req, res) => {
  const projects = db
    .prepare(
      `SELECT p.id, p.name, p.created_at, p.type, p.price_per_month_fcfa, p.trial_days,
              (SELECT COUNT(*) FROM shops s WHERE s.app_origin = p.id) AS shop_count
       FROM projects p ORDER BY p.created_at ASC`,
    )
    .all()
    .map((p) => ({ ...p, from_manifest: manifests.has(p.id) }));
  res.json({ projects });
});

app.post("/api/v1/admin/projects", requireMaster, (req, res) => {
  const id = str(req.body?.id);
  const name = str(req.body?.name);
  const password = str(req.body?.password);
  const type = str(req.body?.type) || null;
  const price = Math.round(Number(req.body?.price_per_month_fcfa));
  const trial = Math.round(Number(req.body?.trial_days));
  if (!id || !name || !password)
    return res.status(400).json({ error: "id, name et password requis." });
  if (!/^[a-z0-9_-]+$/.test(id))
    return res.status(400).json({ error: "id invalide (minuscules, chiffres, _ ou -)." });
  if (projectById(id))
    return res.status(409).json({ error: "Ce projet existe déjà." });
  db.prepare(
    `INSERT INTO projects (id, name, password, created_at, type, price_per_month_fcfa, trial_days)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    password,
    Date.now(),
    type,
    Number.isFinite(price) && price > 0 ? price : null,
    Number.isFinite(trial) && trial > 0 ? trial : null,
  );
  res.status(201).json({ project: projectById(id) });
});

app.post("/api/v1/admin/projects/:id/password", requireMaster, (req, res) => {
  const password = str(req.body?.password);
  const proj = projectById(str(req.params.id));
  if (!proj) return res.status(404).json({ error: "Projet introuvable." });
  if (!password) return res.status(400).json({ error: "password requis." });
  db.prepare("UPDATE projects SET password = ? WHERE id = ?").run(password, proj.id);
  res.json({ ok: true });
});

// Tarif / essai / type d'un projet — pilote la facturation (montant → jours) et la
// durée d'essai appliquée aux nouvelles caisses. Vide un champ pour repasser au défaut.
app.post("/api/v1/admin/projects/:id/config", requireMaster, (req, res) => {
  const proj = projectById(str(req.params.id));
  if (!proj) return res.status(404).json({ error: "Projet introuvable." });
  const type = str(req.body?.type) || null;
  const price = Math.round(Number(req.body?.price_per_month_fcfa));
  const trial = Math.round(Number(req.body?.trial_days));
  db.prepare(
    `UPDATE projects SET type = ?, price_per_month_fcfa = ?, trial_days = ? WHERE id = ?`,
  ).run(
    type,
    Number.isFinite(price) && price > 0 ? price : null,
    Number.isFinite(trial) && trial > 0 ? trial : null,
    proj.id,
  );
  res.json({ ok: true, project: projectById(proj.id) });
});

// ── Rétrocompat : routes de l'ancien server.mjs (builds déjà installées) ──────────
app.post("/api/shops", (req, res) => {
  const result = upsertShop({ ...req.body, app_version_used: undefined });
  if (result.status !== 200) return res.status(400).json(result.shop);
  // L'échéance renvoyée fait foi : l'app s'y aligne (cf. sync.ts côté app).
  res.json({ shop: result.shop });
});

app.get("/api/shops", requireAdmin, (_req, res) => {
  res.json({ shops: listShops() });
});

app.get("/api/shops/:id/payments", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || !byId(id))
    return res.status(404).json({ error: "Boutique introuvable." });
  res.json({
    payments: db
      .prepare("SELECT * FROM payments WHERE shop_id = ? ORDER BY created_at DESC")
      .all(id),
  });
});

app.post("/api/shops/:id/extend", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const shop = byId(id);
  if (!shop) return res.status(404).json({ error: "Boutique introuvable." });
  const amount = Math.round(Number(req.body?.amount_fcfa));
  if (!Number.isFinite(amount) || amount <= 0)
    return res.status(400).json({ error: "Montant invalide." });
  const days = Math.max(1, Math.round((amount / PRICE_PER_MONTH_FCFA) * 30));
  const now = Date.now();
  const next = Math.max(now, shop.expiry_date) + days * DAY_MS;
  db.exec("BEGIN");
  try {
    db.prepare(
      "UPDATE shops SET suspended_at = NULL, expiry_date = ?, updated_at = ? WHERE id = ?",
    ).run(next, now, id);
    db.prepare(
      "INSERT INTO payments (shop_id, amount, days_added, created_at) VALUES (?, ?, ?, ?)",
    ).run(id, amount, days, now);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  res.json({ shop: byId(id) });
});

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
  console.log(`Orchestrateur v2 prêt : http://localhost:${PORT}`);
  console.log(
    `Tarif ${PRICE_PER_MONTH_FCFA.toLocaleString("fr-FR")} FCFA/mois · Essai ${TRIAL_DAYS} jours`,
  );
  if (!EXPLICIT) console.log(`Mot de passe du dashboard (défaut généré) : ${ADMIN_PASSWORD}`);
});
