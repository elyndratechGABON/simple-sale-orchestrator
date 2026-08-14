// Petit serveur local de l'orchestrateur — UN fichier, zéro dépendance.
//
//   node server.mjs
//   → dashboard : http://localhost:8787   (mot de passe affiché au démarrage)
//
// Il reçoit les boutiques (l'app POSTe /api/shops dès qu'elle est en ligne), les liste
// et permet de prolonger les abonnements à la main. Les données vivent dans SQLite
// (orchestrator/data/orchestrator.db) — Node ≥ 22.5 requis (module natif node:sqlite).
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8787);
const PRICE_PER_MONTH_FCFA = Number(process.env.PRICE_PER_MONTH_FCFA ?? 10_000);
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS ?? 30);
const DAY_MS = 86_400_000;

// Mot de passe du dashboard : ADMIN_PASSWORD, sinon généré et affiché au démarrage.
const EXPLICIT =
  typeof process.env.ADMIN_PASSWORD === "string" && process.env.ADMIN_PASSWORD.length > 0;
const ADMIN_PASSWORD = EXPLICIT ? process.env.ADMIN_PASSWORD : randomBytes(8).toString("hex");

// ── Base SQLite ────────────────────────────────────────────────────────────────
const DATA_DIR = join(__dirname, "orchestrator", "data");
mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(join(DATA_DIR, "orchestrator.db"));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS shops (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id         TEXT NOT NULL UNIQUE,
    owner_name        TEXT NOT NULL,
    store_name        TEXT NOT NULL,
    phone             TEXT,
    location          TEXT,
    registration_date INTEGER NOT NULL,
    expiry_date       INTEGER NOT NULL,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS payments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id    INTEGER NOT NULL REFERENCES shops(id),
    amount     INTEGER NOT NULL,
    days_added INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

const getById = (id) => db.prepare("SELECT * FROM shops WHERE id = ?").get(id);
const getByDeviceId = (deviceId) =>
  db.prepare("SELECT * FROM shops WHERE device_id = ?").get(deviceId);

function listShops() {
  return db
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM payments p WHERE p.shop_id = s.id) AS payments
       FROM shops s ORDER BY s.expiry_date ASC`,
    )
    .all();
}

// ── Sessions (en mémoire) ──────────────────────────────────────────────────────
const SESSION_MS = 7 * 24 * 3600 * 1000;
const sessions = new Map();

function isAdmin(req) {
  const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const expiry = sessions.get(token);
  return Boolean(token) && typeof expiry === "number" && expiry > Date.now();
}

// ── HTTP ───────────────────────────────────────────────────────────────────────
function json(res, code, body) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return {};
  }
}

const str = (v) => (typeof v === "string" ? v.trim() : "");
const optStr = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  // CORS : les caisses s'annoncent depuis un autre domaine que celui-ci.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  // Dashboard — HTML embarqué, aucun autre fichier à servir.
  if (method === "GET" && (path === "/" || path === "/admin")) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(DASHBOARD);
    return;
  }

  if (method === "POST") var body = await readBody(req);

  // Connexion du dashboard.
  if (method === "POST" && path === "/api/login") {
    if (str(body.password) !== ADMIN_PASSWORD)
      return json(res, 401, { error: "Mot de passe incorrect." });
    for (const [t, e] of sessions) if (e < Date.now()) sessions.delete(t);
    const token = randomUUID();
    sessions.set(token, Date.now() + SESSION_MS);
    return json(res, 200, { token });
  }

  // Réglages affichés par le dashboard.
  if (method === "GET" && path === "/api/config") {
    return json(res, 200, { price_per_month_fcfa: PRICE_PER_MONTH_FCFA, trial_days: TRIAL_DAYS });
  }

  // Inscription d'une caisse — PUBLIC (une nouvelle boutique s'annonce sans compte).
  if (method === "POST" && path === "/api/shops") {
    const device_id = str(body.device_id);
    const store_name = str(body.store_name);
    if (!device_id || !store_name)
      return json(res, 400, { error: "device_id et store_name sont requis." });
    const owner_name = str(body.owner_name);
    const phone = optStr(body.phone);
    const location = optStr(body.location);
    const registered_at =
      typeof body.registered_at === "number" && Number.isFinite(body.registered_at)
        ? body.registered_at
        : Date.now();
    const now = Date.now();
    const existing = getByDeviceId(device_id);
    if (existing) {
      db.prepare(
        "UPDATE shops SET owner_name=?, store_name=?, phone=?, location=?, updated_at=? WHERE id=?",
      ).run(owner_name, store_name, phone, location, now, existing.id);
    } else {
      db.prepare(
        `INSERT INTO shops (device_id, owner_name, store_name, phone, location, registration_date, expiry_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      );
    }
    // L'échéance renvoyée fait foi : l'app s'y aligne (cf. sync.ts côté app).
    return json(res, 200, { shop: getByDeviceId(device_id) });
  }

  // Liste des boutiques (dashboard).
  if (method === "GET" && path === "/api/shops") {
    if (!isAdmin(req)) return json(res, 401, { error: "Authentification requise." });
    return json(res, 200, { shops: listShops() });
  }

  // /api/shops/:id/payments et /api/shops/:id/extend (dashboard).
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "api" && parts[1] === "shops" && parts[2] && parts[3]) {
    if (!isAdmin(req)) return json(res, 401, { error: "Authentification requise." });
    const id = Number(parts[2]);
    if (parts[3] === "payments" && method === "GET") {
      return json(res, 200, {
        payments: db
          .prepare("SELECT * FROM payments WHERE shop_id = ? ORDER BY created_at DESC")
          .all(id),
      });
    }
    if (parts[3] === "extend" && method === "POST") {
      const shop = getById(id);
      if (!shop) return json(res, 404, { error: "Boutique introuvable." });
      const amount = Math.round(Number(body.amount_fcfa));
      if (!Number.isFinite(amount) || amount <= 0)
        return json(res, 400, { error: "Montant invalide." });
      const days = Math.max(1, Math.round((amount / PRICE_PER_MONTH_FCFA) * 30));
      const now = Date.now();
      const next = Math.max(now, shop.expiry_date) + days * DAY_MS;
      db.exec("BEGIN");
      try {
        db.prepare("UPDATE shops SET expiry_date = ?, updated_at = ? WHERE id = ?").run(
          next,
          now,
          id,
        );
        db.prepare(
          "INSERT INTO payments (shop_id, amount, days_added, created_at) VALUES (?, ?, ?, ?)",
        ).run(id, amount, days, now);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return json(res, 200, { shop: getById(id) });
    }
  }

  json(res, 404, { error: "Introuvable." });
});

server.listen(PORT, () => {
  console.log(`Orchestrateur prêt : http://localhost:${PORT}`);
  console.log(
    `Tarif ${PRICE_PER_MONTH_FCFA.toLocaleString("fr-FR")} FCFA/mois · Essai ${TRIAL_DAYS} jours`,
  );
  if (!EXPLICIT) console.log(`Mot de passe du dashboard (défaut généré) : ${ADMIN_PASSWORD}`);
});

// ── Dashboard embarqué ──────────────────────────────────────────────────────────
const DASHBOARD = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orchestrateur — Boutiques</title>
<style>
  :root{--bg:#f6f7f9;--card:#fff;--border:#e3e6ea;--text:#1b2430;--muted:#667085;--primary:#0f7a4d;--ptext:#fff;--danger:#b42318;--dbg:#fee4e2;--okbg:#dcfce7;--oktx:#14532d;--trialbg:#e0f2fe;--trialtx:#0c4a6e}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  header{background:var(--card);border-bottom:1px solid var(--border);padding:16px 24px}
  header h1{margin:0;font-size:18px}header p{margin:2px 0 0;color:var(--muted);font-size:13px}
  main{max-width:960px;margin:0 auto;padding:24px}.toolbar{display:flex;gap:8px;margin-bottom:16px}
  .toolbar input{flex:1;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px}
  .toolbar button,.actions button{padding:8px 14px;border:1px solid var(--border);background:var(--card);border-radius:8px;cursor:pointer;font-size:13px}
  .toolbar button:hover{border-color:var(--primary);color:var(--primary)}
  .card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin-bottom:12px}
  .row-top{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
  .shop-name{font-size:15px;font-weight:600}.shop-meta{color:var(--muted);font-size:13px;margin-top:2px}
  .badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
  .badge.ok{background:var(--okbg);color:var(--oktx)}.badge.trial{background:var(--trialbg);color:var(--trialtx)}.badge.danger{background:var(--dbg);color:var(--danger)}
  .dates{display:flex;gap:16px;margin-top:10px;color:var(--muted);font-size:13px;flex-wrap:wrap}.dates b{color:var(--text)}
  .actions{display:flex;gap:8px;margin-top:12px}.actions button.primary{background:var(--primary);border-color:var(--primary);color:var(--ptext)}
  summary{cursor:pointer;color:var(--muted);font-size:13px;user-select:none}table{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--border)}th{color:var(--muted);font-weight:500}
  .empty{text-align:center;color:var(--muted);padding:40px 0}.status-line{margin:12px 0;font-size:13px}.status-line.error{color:var(--danger)}.status-line.ok{color:var(--oktx)}
  dialog{border:none;border-radius:12px;padding:20px;width:min(420px,90vw)}dialog::backdrop{background:rgb(0 0 0/.4)}
  dialog h2{margin:0 0 12px;font-size:16px}dialog label{display:block;color:var(--muted);font-size:13px;margin-bottom:4px}
  dialog input{width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px}
  .preview{margin:12px 0;color:var(--muted);font-size:13px}.dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}
  .dialog-actions button{padding:8px 14px;border:1px solid var(--border);background:var(--card);border-radius:8px;cursor:pointer}
  .dialog-actions button.primary{background:var(--primary);border-color:var(--primary);color:var(--ptext)}
  footer{max-width:960px;margin:24px auto;padding:0 24px 40px;color:var(--muted);font-size:12px}
  #login{position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;z-index:10}
  #login[hidden]{display:none}.login-box{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:28px;width:min(360px,90vw)}
  .login-box h2{margin:0 0 4px;font-size:17px}.login-box p{margin:0 0 16px;color:var(--muted);font-size:13px}
  .login-box input{width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px}
  .login-box button{width:100%;margin-top:12px;padding:9px 14px;border:none;border-radius:8px;background:var(--primary);color:var(--ptext);font-size:14px;cursor:pointer}
  .login-error{margin-top:10px;color:var(--danger);font-size:13px;min-height:18px}
  header .logout{float:right;border:1px solid var(--border);background:none;border-radius:8px;padding:5px 10px;cursor:pointer;color:var(--muted);font-size:12px}
</style>
</head>
<body>
<div id="login"><div class="login-box">
  <h2>Accès protégé</h2>
  <p>Ce dashboard montre les boutiques — mot de passe requis.</p>
  <input id="pw" type="password" autocomplete="current-password" placeholder="Mot de passe">
  <button id="login-btn">Se connecter</button>
  <div class="login-error" id="login-err"></div>
</div></div>

<header><h1>Orchestrateur</h1><p>Boutiques qui utilisent la caisse POS — les données arrivent dès qu'elles sont en ligne.</p>
  <button id="logout" class="logout" hidden>Se déconnecter</button></header>

<main>
  <div class="toolbar">
    <input id="filter" placeholder="Filtrer : boutique, propriétaire, téléphone…" autocomplete="off">
    <button id="refresh">Actualiser</button>
  </div>
  <div id="status" class="status-line"></div>
  <div id="list"></div>
</main>

<footer id="config"></footer>

<dialog id="extend">
  <h2>Prolonger — <span id="extend-name"></span></h2>
  <label for="extend-amount">Montant reçu (FCFA)</label>
  <input id="extend-amount" type="number" min="1" inputmode="numeric" autofocus>
  <p class="preview" id="extend-preview"></p>
  <div class="dialog-actions">
    <button id="extend-cancel">Annuler</button>
    <button id="extend-ok" class="primary">Prolonger</button>
  </div>
</dialog>

<script>
"use strict";
const DAY_MS = 86400000;
const $ = (s) => document.querySelector(s);
let token = localStorage.getItem("orch_token") || "";
let shops = [];
let config = { price_per_month_fcfa: 10000, trial_days: 30 };
let active = null;
const state = { filter: "" };

const fmtFCFA = (v) => Number(v).toLocaleString("fr-FR") + " F";
const fmtDate = (ts) => new Date(ts).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, opts) {
  const init = Object.assign({ headers: { "Content-Type": "application/json" } }, opts);
  if (token) init.headers.Authorization = "Bearer " + token;
  const res = await fetch(path, init);
  if (res.status === 401) { showLogin(); throw new Error("auth"); }
  return res.json();
}

let lastJson = "";
async function fetchData() {
  const cfg = await api("/api/config");
  config = cfg;
  shops = (await api("/api/shops")).shops;
  $("#config").textContent = "Un mois = " + fmtFCFA(config.price_per_month_fcfa) +
    " · essai de " + config.trial_days + " jours à l'inscription — les boutiques synchronisent dès que ce PC est allumé.";
  const j = JSON.stringify(shops);
  if (j !== lastJson) { lastJson = j; render(); }
}

async function load() {
  setStatus("Chargement…");
  try { await fetchData(); setStatus(""); }
  catch (e) { if (e.message !== "auth") setStatus("Impossible de joindre le serveur.", "error"); }
}

setInterval(async () => { try { await fetchData(); } catch { /* réessai plus tard */ } }, 5000);

function showLogin() { $("#login").hidden = false; $("#logout").hidden = true; }
function showDashboard() { $("#login").hidden = true; $("#logout").hidden = false; }
if (!token) showLogin(); else showDashboard();

$("#login-btn").addEventListener("click", async () => {
  const err = $("#login-err");
  err.textContent = "";
  try {
    const res = await fetch("/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: $("#pw").value }),
    });
    const data = await res.json();
    if (!res.ok) { err.textContent = "Mot de passe incorrect."; return; }
    token = data.token;
    localStorage.setItem("orch_token", token);
    $("#pw").value = "";
    showDashboard();
    await load();
  } catch { err.textContent = "Serveur injoignable."; }
});
$("#pw").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#login-btn").click(); });
$("#logout").addEventListener("click", () => { token = ""; localStorage.removeItem("orch_token"); showLogin(); });

function setStatus(text, cls) { const el = $("#status"); el.textContent = text; el.className = "status-line " + (cls || ""); }

function statusOf(shop) {
  const days = Math.ceil((shop.expiry_date - Date.now()) / DAY_MS);
  if (days <= 0) return { label: "Expiré depuis " + (-days) + " j", cls: "danger" };
  if (shop.payments > 0) return { label: "Actif · " + days + " j", cls: "ok" };
  return { label: "Essai · " + days + " j", cls: "trial" };
}

function render() {
  const q = state.filter.toLowerCase();
  const visible = q ? shops.filter((s) =>
    [s.store_name, s.owner_name, s.phone, s.location].filter(Boolean).some((v) => String(v).toLowerCase().includes(q))
  ) : shops;
  const list = $("#list");
  if (visible.length === 0) { list.innerHTML = '<div class="empty">Aucune boutique.</div>'; return; }
  list.innerHTML = "";
  for (const shop of visible) {
    const st = statusOf(shop);
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML =
      '<div class="row-top"><div><div class="shop-name">' + esc(shop.store_name) + "</div>" +
      '<div class="shop-meta">' + esc(shop.owner_name) +
      (shop.phone ? " · " + esc(shop.phone) : "") +
      (shop.location ? " · " + esc(shop.location) : "") +
      '</div></div><span class="badge ' + st.cls + '">' + st.label + "</span></div>" +
      '<div class="dates"><span>Inscrit le <b>' + fmtDate(shop.registration_date) + "</b></span>" +
      "<span>Expire le <b>" + fmtDate(shop.expiry_date) + "</b></span></div>" +
      '<div class="actions"><button class="primary" data-extend="' + shop.id + '">Prolonger</button>' +
      "<details><summary>Paiements (" + shop.payments + ")</summary><div data-payments=\"" + shop.id + "\">Chargement…</div></details></div>";
    list.appendChild(card);
  }
  list.querySelectorAll("[data-extend]").forEach((b) => b.addEventListener("click", () => openExtend(Number(b.dataset.extend))));
  list.querySelectorAll("details").forEach((d) => d.addEventListener("toggle", () => {
    const holder = d.querySelector("[data-payments]");
    if (d.open && holder.dataset.loaded !== "1") loadPayments(holder);
  }));
}

async function loadPayments(holder) {
  try {
    const data = await api("/api/shops/" + holder.dataset.payments + "/payments");
    holder.dataset.loaded = "1";
    if (data.payments.length === 0) { holder.textContent = "Aucun paiement enregistré."; return; }
    let html = "<table><tr><th>Date</th><th>Montant</th><th>Jours</th></tr>";
    for (const p of data.payments) html += "<tr><td>" + fmtDate(p.created_at) + "</td><td><b>" + fmtFCFA(p.amount) + "</b></td><td>" + p.days_added + " j</td></tr>";
    holder.innerHTML = html + "</table>";
  } catch { holder.textContent = "Erreur de chargement."; }
}

function openExtend(id) {
  const shop = shops.find((s) => s.id === id);
  if (!shop) return;
  active = id;
  $("#extend-name").textContent = shop.store_name;
  $("#extend-amount").value = "";
  updatePreview();
  $("#extend").showModal();
}

function updatePreview() {
  const amount = Math.round(Number($("#extend-amount").value));
  const shop = shops.find((s) => s.id === active);
  const p = $("#extend-preview");
  if (!shop || !Number.isFinite(amount) || amount <= 0) { p.textContent = "1 mois = " + fmtFCFA(config.price_per_month_fcfa) + "."; return; }
  const days = Math.max(1, Math.round((amount / config.price_per_month_fcfa) * 30));
  const next = new Date(Math.max(Date.now(), shop.expiry_date) + days * DAY_MS);
  p.textContent = fmtFCFA(amount) + " → +" + days + " j, nouvelle échéance le " + fmtDate(next.getTime()) + ".";
}

$("#extend-amount").addEventListener("input", updatePreview);
$("#extend-cancel").addEventListener("click", () => $("#extend").close());

$("#extend-ok").addEventListener("click", async () => {
  const amount = Math.round(Number($("#extend-amount").value));
  if (!Number.isFinite(amount) || amount <= 0) return;
  const btn = $("#extend-ok");
  btn.disabled = true;
  try {
    await api("/api/shops/" + active + "/extend", { method: "POST", body: JSON.stringify({ amount_fcfa: amount }) });
    $("#extend").close();
    await load();
    setStatus("Prolongation enregistrée. L'app recevra la nouvelle échéance à sa prochaine connexion.", "ok");
  } catch { setStatus("Erreur : le serveur ne répond pas.", "error"); }
  btn.disabled = false;
});

$("#refresh").addEventListener("click", load);
$("#filter").addEventListener("input", (e) => { state.filter = e.target.value.trim(); render(); });

load();
</script>
</body>
</html>`;
