// Logique partagée du relais ops — réutilisée par le serveur standalone (index.mjs)
// et l'adaptateur Vercel (api/ops.js). Postgres via `pg` (Neon), boîte aux lettres muette.
//
// Le relais ne SUPPRIME jamais une op avant que les appareils du magasin n'aient tiré la
// donnée. Règle de fraîcheur appliquée à la purge (drain orchestrateur) ET au balai auto :
//    une op est supprimable ssi
//      (1) au moins un appareil l'a déjà TIRÉE (pull passé son created_at) — sans cela,
//          sur un magasin neuf dont personne n'a encore tiré, rien ne doit s'effacer ;
//      (2) AUCUN appareil PRÉSENT (dernier pull < ABSENT_MS) n'est en retard dessus.
// Les appareils absents depuis plus de ABSENT_MS ne bloquent pas : ils sont repartis, et
// le prochain retour re-converge par handshake/sync, pas par ce journal.
let Pool = null;
try {
  ({ Pool } = await import("pg"));
} catch {
  Pool = null;
}

let pool;
const MAX_PULL = Number(process.env.MAX_PULL ?? 5000);
const DATABASE_URL = process.env.DATABASE_URL ?? "";
// Durée au-delà de laquelle un appareil qui n'a pas re-tiré est considéré absent.
const ABSENT_MS = Number(process.env.ABSENT_MS ?? 86_400_000);
// Fréquence minimale du balai auto — DÉSACTIVÉ en production (SWEEP_ENABLED=false) :
// seul l'orchestrateur draine et purge, pour qu'aucune op ne disparaisse sans être
// archivée même si un téléphone est réinitialisé entre-temps. Local/dev, le balai
// (30 s) reste un filet de sécurité pratique.
const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS ?? 30_000);
const SWEEP_ENABLED = process.env.SWEEP_ENABLED !== "false";
// Si un DASHBOARD_TOKEN est défini, /api/v1/overview exige le header x-dashboard-token.
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN ?? "";
// Secret partagé des endpoints ops (push/pull/purge/shops). Requis quand OPS_TOKEN est
// défini (production) ; absent en dev → relais ouvert pour les tests locaux. La caisse
// l'envoie via VITE_OPS_TOKEN, le drainer via OPS_TOKEN (même valeur).
const OPS_TOKEN = process.env.OPS_TOKEN ?? "";
let lastSweepAt = 0;

function ensurePool() {
  if (!Pool || !DATABASE_URL) {
    throw Object.assign(new Error("DATABASE_URL manquant"), { status: 500 });
  }
  pool ??= new Pool({ connectionString: DATABASE_URL, max: 10, idleTimeoutMillis: 30_000 });
  return pool;
}

/** Dépôt idempotent par `id` (ON CONFLICT DO NOTHING) : un re-push après un échec
 *  d'acquittement local ne crée jamais de doublon. */
async function storeOps(p, shopId, ops) {
  if (!Array.isArray(ops) || ops.length === 0 || typeof shopId !== "string" || !shopId) {
    return { stored: 0 };
  }
  const valid = ops.filter((o) => o && typeof o.id === "string");
  if (valid.length === 0) return { stored: 0 };
  const now = Date.now();

  const client = await p.connect();
  let stored = 0;
  try {
    // INSERT multi-lignes en UN SEUL statement (round-trip unique) : un push de 30 ops
    // coûte 1 aller-retour Neon au lieu de 30. Découpé par paquets pour rester sous la
    // limite Postgres de 65 535 paramètres. Idempotence : ON CONFLICT DO NOTHING →
    // RETURNING id ne renvoie que les lignes réellement insérées (comptage exact).
    const CHUNK = 500;
    for (let i = 0; i < valid.length; i += CHUNK) {
      const chunk = valid.slice(i, i + CHUNK);
      const params = [];
      const rows = chunk.map((op) => {
        const base = params.length;
        params.push(
          op.id.slice(0, 200),
          shopId,
          String(op.device_id ?? ""),
          Number(op.seq ?? 0) || 0,
          String(op.type ?? "unknown"),
          String(op.entity_id ?? "").slice(0, 200),
          JSON.stringify(op.payload ?? null),
          Number(op.created_at ?? now) || now,
          now,
        );
        return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},'synced',$${base + 9})`;
      });
      const r = await client.query(
        `INSERT INTO sync_ops (id, shop_id, device_id, seq, type, entity_id, payload, created_at, status, received_at)
         VALUES ${rows.join(",")}
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        params,
      );
      stored += r.rowCount;
    }
    return { stored };
  } finally {
    client.release();
  }
}

/** Pull : toutes les ops du groupe, borné par MAX_PULL. Le relais ne filtre ni ne
 *  trie pour l'application — l'appareil applique l'ordre déterministe + la dédup. */
export async function fetchOps(p, shopId) {
  if (typeof shopId !== "string" || !shopId) return [];
  const client = await p.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, shop_id, device_id, seq, type, entity_id, payload, created_at, status
       FROM sync_ops WHERE shop_id = $1 ORDER BY created_at, id LIMIT $2`,
      [shopId, MAX_PULL],
    );
    return rows.map((r) => ({
      ...r,
      seq: Number(r.seq),
      created_at: Number(r.created_at),
      payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
    }));
  } finally {
    client.release();
  }
}

/** Enregistre un pull d'appareil. `last_created_at` ne recule jamais (GREATEST). Un pull
 *  vide rafraîchit `last_pulled_at` (l'appareil est vivant) sans régresser la donnée. */
async function recordPull(p, shopId, deviceId, ops) {
  if (!deviceId || !shopId) return;
  let maxCreated = 0;
  for (const o of ops) maxCreated = Math.max(maxCreated, Number(o.created_at) || 0);
  const client = await p.connect();
  try {
    await client.query(
      `INSERT INTO device_pull (shop_id, device_id, last_created_at, last_pulled_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (shop_id, device_id) DO UPDATE SET
         last_created_at = GREATEST(device_pull.last_created_at, EXCLUDED.last_created_at),
         last_pulled_at  = EXCLUDED.last_pulled_at`,
      [shopId, deviceId, maxCreated, Date.now()],
    );
  } finally {
    client.release();
  }
}

/** Purge SÛRE : ne supprime que les ops couvertes par la règle de fraîcheur. C'est le
 *  point vérifié « tant que le propriétaire n'est pas à jour sur son stock, rien ne se
 *  supprime » — un op en retard pour n'importe quel appareil présent est conservé. */
async function purgeOps(p, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return { purged: 0, kept: 0 };
  const abs = Date.now() - ABSENT_MS;
  const client = await p.connect();
  try {
    const { rowCount } = await client.query(
      `DELETE FROM sync_ops o
       WHERE o.id = ANY($1::text[])
         AND EXISTS (
           SELECT 1 FROM device_pull d
           WHERE d.shop_id = o.shop_id AND d.last_created_at >= o.created_at
         )
         AND NOT EXISTS (
           SELECT 1 FROM device_pull d
           WHERE d.shop_id = o.shop_id
             AND d.last_pulled_at >= $2
             AND d.last_created_at < o.created_at
         )`,
      [ids, abs],
    );
    return { purged: rowCount, kept: ids.length - rowCount };
  } finally {
    client.release();
  }
}

/** Balai auto : applique la même règle de fraîcheur à TOUTES les ops, à basse fréquence,
 *  pour que la place se libère même si l'orchestrateur reste longtemps éteint. */
async function sweepExpired(p) {
  if (!SWEEP_ENABLED) return;
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  const abs = now - ABSENT_MS;
  const client = await p.connect();
  try {
    await client.query(
      `DELETE FROM sync_ops o
       WHERE EXISTS (
           SELECT 1 FROM device_pull d
           WHERE d.shop_id = o.shop_id AND d.last_created_at >= o.created_at
         )
         AND NOT EXISTS (
           SELECT 1 FROM device_pull d
           WHERE d.shop_id = o.shop_id
             AND d.last_pulled_at >= $1
             AND d.last_created_at < o.created_at
         )`,
      [abs],
    );
  } finally {
    client.release();
  }
}

/** Boutiques du relais (ids opaques + volume en attente) — pour le drainer orchestrateur. */
async function listShops(p) {
  const client = await p.connect();
  try {
    const { rows } = await client.query(
      `SELECT shop_id, COUNT(*) AS pending FROM sync_ops GROUP BY shop_id ORDER BY shop_id`,
    );
    return rows.map((r) => ({ shop_id: r.shop_id, pending: Number(r.pending) }));
  } finally {
    client.release();
  }
}

/** Vue d'ensemble du site relais : global + par boutique (en attente, appareils présents,
 *  appareils en retard → caught_up). Avec `shop_id`, ajoute le détail (appareils + 50
 *  dernières ops, sans payload). */
async function overview(p, shopId) {
  const abs = Date.now() - ABSENT_MS;
  const client = await p.connect();
  try {
    if (shopId) {
      const [devices, recent] = await Promise.all([
        client.query(
          `SELECT device_id, last_created_at, last_pulled_at FROM device_pull WHERE shop_id = $1 ORDER BY last_pulled_at DESC`,
          [shopId],
        ),
        client.query(
          `SELECT id, seq, type, entity_id, device_id, created_at, status
           FROM sync_ops WHERE shop_id = $1 ORDER BY created_at DESC, id DESC LIMIT 50`,
          [shopId],
        ),
      ]);
      return {
        shop_id: shopId,
        devices: devices.rows.map((d) => ({
          ...d,
          last_created_at: Number(d.last_created_at),
          last_pulled_at: Number(d.last_pulled_at),
          present: Number(d.last_pulled_at) >= abs,
        })),
        recent_ops: recent.rows.map((r) => ({
          ...r,
          seq: Number(r.seq),
          created_at: Number(r.created_at),
        })),
      };
    }

    const [total, shopsRows] = await Promise.all([
      client.query(`SELECT COUNT(*) AS c FROM sync_ops`),
      client.query(
        `SELECT o.shop_id,
                COUNT(*)                                        AS pending,
                MAX(o.created_at)                               AS last_activity,
                (SELECT COUNT(*) FROM device_pull d
                   WHERE d.shop_id = o.shop_id AND d.last_pulled_at >= $1) AS devices_present,
                (SELECT COUNT(*) FROM device_pull d
                   WHERE d.shop_id = o.shop_id AND d.last_pulled_at >= $1
                     AND d.last_created_at < MAX(o.created_at)) AS behind
         FROM sync_ops o
         GROUP BY o.shop_id
         ORDER BY last_activity DESC`,
        [abs],
      ),
    ]);
    return {
      generated_at: Date.now(),
      global: { totalOps: Number(total.rows[0].c), shops: shopsRows.rows.length },
      shops: shopsRows.rows.map((r) => ({
        shop_id: r.shop_id,
        pending: Number(r.pending),
        last_activity: Number(r.last_activity),
        devices_present: Number(r.devices_present),
        behind: Number(r.behind),
        caught_up: Number(r.behind) === 0,
      })),
    };
  } finally {
    client.release();
  }
}

/** Traite une requête HTTP et répond sur `res`. Conforme au contrat de la caisse
 *  (syncengine/transport.ts). Ne lève jamais : répond toujours un code HTTP. */
export async function handleRequest(req, res) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, { ok: true });
  }

  CORS(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  // Le site du relais : page de vue d'ensemble, servie telle quelle (les données,
  // elles, sont protégées par DASHBOARD_TOKEN via /api/v1/overview).
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(dashboardHtml());
  }

  try {
    const p = ensurePool();
    await sweepExpired(p);

    switch (url.pathname) {
      case "/api/v1/dashboard": {
        if (req.method !== "GET") return json(res, 405, { error: "méthode non autorisée" });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(dashboardHtml());
      }

      case "/api/v1/ops": {
        if (!requireOpsToken(req, res)) return;
        if (req.method === "POST") {
          let body;
          try {
            body = JSON.parse(await readBody(req));
          } catch {
            return json(res, 400, { error: "json invalide" });
          }
          const stored = await storeOps(p, body?.shop_id, body?.ops);
          return json(res, 200, { stored: stored.stored });
        }
        if (req.method === "GET") {
          const shopId = url.searchParams.get("shop_id") ?? "";
          const ops = await fetchOps(p, shopId);
          await recordPull(p, shopId, url.searchParams.get("device_id") ?? "", ops);
          return json(res, 200, { ops });
        }
        return json(res, 405, { error: "méthode non autorisée" });
      }

      case "/api/v1/ops/purge": {
        if (req.method !== "POST") return json(res, 405, { error: "méthode non autorisée" });
        if (!requireOpsToken(req, res)) return;
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return json(res, 400, { error: "json invalide" });
        }
        const ids = Array.isArray(body?.ids) ? body.ids.filter((x) => typeof x === "string") : [];
        return json(res, 200, await purgeOps(p, ids));
      }

      case "/api/v1/ops/shops": {
        if (req.method !== "GET") return json(res, 405, { error: "méthode non autorisée" });
        if (!requireOpsToken(req, res)) return;
        return json(res, 200, { shops: await listShops(p) });
      }

      case "/api/v1/overview": {
        if (req.method !== "GET") return json(res, 405, { error: "méthode non autorisée" });
        if (DASHBOARD_TOKEN && req.headers["x-dashboard-token"] !== DASHBOARD_TOKEN) {
          return json(res, 401, { error: "non autorisé" });
        }
        return json(res, 200, await overview(p, url.searchParams.get("shop_id") ?? ""));
      }

      default:
        return json(res, 404, { error: "introuvable" });
    }
  } catch (err) {
    json(res, err.status ?? 500, { error: (err.status ?? 500) >= 500 ? "erreur relais" : err.message });
  }
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,x-dashboard-token,x-ops-token",
};
/** Contrôle OPS_TOKEN sur les endpoints ops. Renvoie false (et a répondu 401) si
 *  un token est configuré mais absent/incorrect — silencieux quand rien n'est configuré. */
function requireOpsToken(req, res) {
  if (!OPS_TOKEN) return true;
  if (req.headers["x-ops-token"] === OPS_TOKEN) return true;
  json(res, 401, { error: "non autorisé" });
  return false;
}
function CORS(res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
}
function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** Page du site du relais — vue d'ensemble rapide de la boîte aux lettres. Self-contained
 *  (aucun CDN, aucune dépendance) : elle interroge /api/v1/overview avec le
 *  DASHBOARD_TOKEN saisi une fois (localStorage) et se rafraîchit seule toutes les 10 s. */
function dashboardHtml() {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relais ops · ecaïsse</title>
<style>
  :root { color-scheme: light dark; --bg:#0f1420; --card:#1a2133; --line:#2a3550;
          --txt:#e6ebf5; --mut:#8b96ad; --acc:#4ea1ff; --ok:#39c97f; --warn:#ffb454; --bad:#ff6b6b; }
  * { box-sizing: border-box; }
  body { margin:0; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
         background:var(--bg); color:var(--txt); }
  header { display:flex; align-items:center; gap:12px; padding:14px 20px;
           border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); }
  header h1 { font-size:16px; margin:0; font-weight:600; }
  header .url { color:var(--mut); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  header .spacer { flex:1; }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--ok); display:inline-block; }
  .dot.off { background:var(--bad); }
  button { background:var(--acc); color:#06121f; border:0; border-radius:7px; padding:7px 12px;
           font-size:13px; font-weight:600; cursor:pointer; }
  button.ghost { background:transparent; color:var(--acc); border:1px solid var(--line); }
  main { max-width:1080px; margin:0 auto; padding:20px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px,1fr)); gap:12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .card .k { color:var(--mut); font-size:12px; text-transform:uppercase; letter-spacing:.05em; }
  .card .v { font-size:26px; font-weight:700; margin-top:4px; }
  table { width:100%; border-collapse:collapse; margin-top:16px; background:var(--card);
          border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  th,td { text-align:left; padding:9px 14px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { color:var(--mut); font-size:11px; text-transform:uppercase; letter-spacing:.05em; background:#161d2f; }
  tr:last-child td { border-bottom:0; }
  tbody tr { cursor:pointer; }
  tbody tr:hover { background:#1e2740; }
  .num { text-align:right; font-variant-numeric:tabular-nums; }
  .badge { display:inline-block; padding:2px 8px; border-radius:99px; font-size:11px; font-weight:600; }
  .badge.ok { background:rgba(57,201,127,.15); color:var(--ok); }
  .badge.warn { background:rgba(255,180,84,.15); color:var(--warn); }
  .badge.bad { background:rgba(255,107,107,.15); color:var(--bad); }
  .mono { font-family:ui-monospace, "Cascadia Code", monospace; font-size:12px; }
  .muted { color:var(--mut); font-size:12px; }
  .banner { padding:10px 16px; border-radius:10px; margin:12px 0; font-size:13px; }
  .banner.err { background:rgba(255,107,107,.12); border:1px solid var(--bad); color:var(--bad); }
  .banner.info { background:rgba(78,161,255,.1); border:1px solid var(--acc); color:var(--acc); }
  dialog { background:var(--card); color:var(--txt); border:1px solid var(--line); border-radius:12px;
           padding:22px; max-width:380px; width:90%; }
  dialog h2 { font-size:15px; margin:0 0 8px; }
  dialog p { color:var(--mut); font-size:12.5px; margin:0 0 14px; }
  dialog input { width:100%; padding:9px 11px; border-radius:8px; border:1px solid var(--line);
                 background:#0e1424; color:var(--txt); font-size:14px; }
  dialog form { display:flex; gap:8px; margin-top:12px; }
  #detail { border:1px solid var(--line); border-radius:12px; background:var(--card); margin-top:16px; }
  #detail .hd { display:flex; align-items:center; gap:10px; padding:12px 16px; border-bottom:1px solid var(--line); }
  #detail .hd h2 { font-size:14px; margin:0; flex:1; }
</style>
</head>
<body>
<header>
  <span class="dot" id="dot"></span>
  <h1>Relais ops</h1>
  <span class="url" id="url"></span>
  <span class="spacer"></span>
  <span class="muted" id="ago"></span>
  <button class="ghost" id="tokenBtn">Jeton</button>
  <button id="refresh">Actualiser</button>
</header>
<main>
  <div id="banner"></div>
  <div class="cards">
    <div class="card"><div class="k">Ops en attente</div><div class="v" id="cTotal">—</div></div>
    <div class="card"><div class="k">Boutiques</div><div class="v" id="cShops">—</div></div>
    <div class="card"><div class="k">Boutiques en retard</div><div class="v" id="cBehind">—</div></div>
    <div class="card"><div class="k">Tout à jour</div><div class="v" id="cUp">—</div></div>
  </div>
  <table>
    <thead><tr><th>Boutique</th><th class="num">En attente</th><th class="num">Appareils présents</th>
      <th class="num">En retard</th><th>Statut</th><th>Dernière activité</th></tr></thead>
    <tbody id="rows"><tr><td colspan="6" class="muted">Chargement…</td></tr></tbody>
  </table>
  <div id="detail" hidden>
    <div class="hd"><span class="badge info" id="dBack">← retour</span><h2 id="dTitle"></h2><span class="muted" id="dSub"></span></div>
    <div id="dBody"></div>
  </div>
</main>
<dialog id="tok">
  <h2>Jeton du tableau de bord</h2>
  <p>Le DASHBOARD_TOKEN du relais. Conservé uniquement dans ce navigateur (localStorage).</p>
  <form method="dialog">
    <input id="tokin" type="password" autocomplete="off" placeholder="DASHBOARD_TOKEN">
    <button value="ok">Valider</button>
  </form>
</dialog>
<script>
const $ = (id) => document.getElementById(id);
const api = "/api/v1/overview";
let token = localStorage.getItem("relay_dash_token") || "";
$("url").textContent = location.origin + location.pathname;
$("tokenBtn").onclick = () => { $("tok").showModal(); };
$("tokin").value = token;
$("tok").addEventListener("close", () => {
  const v = $("tokin").value.trim();
  if (v) { token = v; localStorage.setItem("relay_dash_token", v); window.load(); }
});
$("refresh").onclick = window.load;
function ago(ms) {
  if (!ms) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return s + " s";
  if (s < 3600) return Math.floor(s/60) + " min";
  if (s < 86400) return Math.floor(s/3600) + " h";
  return Math.floor(s/86400) + " j";
}
function banner(kind, msg) {
  const b = $("banner");
  b.className = "banner " + kind;
  b.textContent = msg;
}
async function load() {
  $("dot").classList.remove("off");
  let data;
  try {
    const res = await fetch(api, { headers: token ? { "x-dashboard-token": token } : {} });
    if (res.status === 401) { banner("err", "Token invalide — cliquez « Jeton »."); $("dot").classList.add("off"); return; }
    if (!res.ok) throw new Error("HTTP " + res.status);
    data = await res.json();
    banner("info", "");
  } catch (e) {
    banner("err", "Relais injoignable : " + e.message);
    $("dot").classList.add("off");
    return;
  }
  banner("info", "");
  $("cTotal").textContent = data.global.totalOps;
  $("cShops").textContent = data.global.shops;
  $("cBehind").textContent = data.shops.filter((s) => s.behind > 0).length;
  $("cUp").textContent = data.shops.filter((s) => s.caught_up).length;
  $("ago").textContent = "actualisé il y a " + ago(Date.now() - 1000) + " · " + new Date(data.generated_at).toLocaleTimeString();
  $("rows").innerHTML = "";
  if (data.shops.length === 0) {
    $("rows").innerHTML = '<tr><td colspan="6" class="muted">Aucune op en attente — la boîte aux lettres est vide.</td></tr>';
  }
  for (const s of data.shops) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      '<td class="mono">' + s.shop_id + '</td>' +
      '<td class="num">' + s.pending + '</td>' +
      '<td class="num">' + s.devices_present + '</td>' +
      '<td class="num">' + s.behind + '</td>' +
      '<td>' + (s.caught_up ? '<span class="badge ok">à jour</span>' : '<span class="badge warn">en retard</span>') + '</td>' +
      '<td class="muted">' + ago(s.last_activity) + '</td>';
    tr.onclick = () => openShop(s.shop_id);
    $("rows").appendChild(tr);
  }
}
async function openShop(id) {
  try {
    const res = await fetch(api + "?shop_id=" + encodeURIComponent(id), { headers: token ? { "x-dashboard-token": token } : {} });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const d = await res.json();
    $("dTitle").textContent = id;
    const pres = d.devices.filter((x) => x.present).length;
    $("dSub").textContent = pres + " appareil(s) présent(s) · " + d.recent_ops.length + " dernières ops";
    $("dBody").innerHTML = "";
    if (d.devices.length) {
      const t = document.createElement("table");
      t.innerHTML = "<thead><tr><th>Appareil</th><th class='num'>Dernier pull</th><th>État</th></tr></thead>";
      for (const dev of d.devices) {
        const r = t.insertRow(-1);
        r.innerHTML = '<td class="mono">' + dev.device_id + '</td>' +
          '<td class="num">' + ago(dev.last_pulled_at) + '</td>' +
          '<td>' + (dev.present ? '<span class="badge ok">présent</span>' : '<span class="badge bad">absent</span>') + '</td>';
      }
      $("dBody").appendChild(t);
    }
    if (d.recent_ops.length) {
      const t = document.createElement("table");
      t.innerHTML = "<thead><tr><th>Op</th><th>Type</th><th>Entité</th><th>Appareil</th><th class='num'>Créée</th></tr></thead>";
      for (const o of d.recent_ops) {
        const r = t.insertRow(-1);
        r.innerHTML = '<td class="mono">' + o.id + '</td><td>' + o.type + '</td>' +
          '<td class="mono">' + o.entity_id + '</td>' +
          '<td class="mono">' + o.device_id + '</td>' +
          '<td class="num muted">' + ago(o.created_at) + '</td>';
      }
      $("dBody").appendChild(t);
    }
  } catch (e) {
    banner("err", "Détail indisponible : " + e.message);
  }
  $("dBack").onclick = () => { $("detail").hidden = true; window.load(); };
  $("detail").hidden = false;
  document.querySelector("main > table").style.display = "none";
  $("detail").scrollIntoView();
}
window.load = load;
load();
setInterval(load, 10000);
</script>
</body>
</html>`;
}
function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("Corps trop volumineux."), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}