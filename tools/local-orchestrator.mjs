// L'ORCHESTRATEUR LOCAL — l'instance que le commerçant allume chez lui.
//
// Rôle : garder une COPIE des données du commerce, pour que la restauration ne
// dépende pas du cloud (et que les données restent chez le commerçant).
//
// Fonctionnement :
//   1. toutes les N minutes, l'instance TIRE le miroir du cloud
//      (GET /api/v1/mirror/ops) avec les identifiants du compte ;
//   2. les opérations sont rangées dans un SQLite local (`node:sqlite`, intégré à
//      Node — aucune dépendance à installer) ;
//   3. la restauration est servie DEPUIS CE LOCAL : les mêmes routes que le cloud
//      (POST /api/v1/restore, GET /api/v1/restore/:job_id) ;
//   4. le reste de l'API est PROXYFIÉ vers le cloud : l'instance locale est
//      alors unorchestrateur de substitution, la caisse n'a pas à le savoir.
//
// ⚠️ Le serveur ne pousse jamais (cf. docs/orchestrateur-flux.md) : c'est l'instance
// qui tire. C'est la seule méthode qui marche derrière un routeur (NAT).
//
// Lancement :
//   CLOUD_URL=https://simple-sale-orchestrator.vercel.app \
//   ACCOUNT_PHONE=07657843 ACCOUNT_PASSWORD=... \
//   node tools/local-orchestrator.mjs
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";

// La configuration est lue À L'APPEL : changer CLOUD_URL (ou les identifiants)
// redemarre l'instance sans qu'il faille recharger le module.
const config = () => ({
  cloud: (process.env.CLOUD_URL ?? "https://simple-sale-orchestrator.vercel.app").replace(/\/+$/, ""),
  phone: process.env.ACCOUNT_PHONE ?? "",
  password: process.env.ACCOUNT_PASSWORD ?? "",
  db: process.env.LOCAL_DB ?? join(process.cwd(), "data", "mirror.sqlite"),
  interval: Number(process.env.MIRROR_INTERVAL_MS ?? 15 * 60_000),
});

const PORT = Number(process.env.PORT ?? 8788);
const MIRROR_INTERVAL_MS = Number(process.env.MIRROR_INTERVAL_MS ?? 15 * 60_000);

if (!config().phone || !config().password) {
  console.error(
    "Il faut ACCOUNT_PHONE et ACCOUNT_PASSWORD (les identifiants du compte marchand) :\n" +
      "  CLOUD_URL=... ACCOUNT_PHONE=... ACCOUNT_PASSWORD=... node tools/local-orchestrator.mjs",
  );
  process.exit(1);
}

// ── Le miroir local (SQLite) ─────────────────────────────────────────────────────
const dbPath = config().db;
mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS mirror_ops (
    id TEXT PRIMARY KEY,
    shop_id TEXT,
    device_id TEXT,
    seq INTEGER,
    type TEXT,
    entity_id TEXT,
    payload TEXT,
    created_at INTEGER,
    sig TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_mirror_created ON mirror_ops (created_at, id);
  CREATE TABLE IF NOT EXISTS mirror_state (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS mirror_jobs (id TEXT PRIMARY KEY, created_at INTEGER);
`);

const state = (key) => db.prepare("SELECT value FROM mirror_state WHERE key = ?").get(key)?.value;
const setState = (key, value) =>
  db
    .prepare("INSERT INTO mirror_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, String(value));

/** Un miroir : on ne prend que ce qui manque. */
export async function miroir() {
  const cfg = config();
  const since = Number(state("since") ?? 0);
  // POST et non GET : les identifiants du compte voyagent dans le corps, jamais dans
  // l'URL (une URL est journalisée par les proxies et les serveurs).
  const res = await fetch(`${cfg.cloud}/api/v1/mirror/ops`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      account_phone: cfg.phone,
      account_password: cfg.password,
      since,
      limit: 1000,
    }),
  });
  if (!res.ok) throw new Error(`Miroir refusé : HTTP ${res.status}`);
  const data = await res.json();
  const ops = Array.isArray(data.ops) ? data.ops : [];
  const ins = db.prepare(
    `INSERT INTO mirror_ops (id, shop_id, device_id, seq, type, entity_id, payload, created_at, sig)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  for (const op of ops) {
    ins.run(
      String(op.id ?? ""),
      op.shop_id ?? null,
      op.device_id ?? null,
      Number(op.seq) || 0,
      op.type ?? "",
      op.entity_id ?? null,
      JSON.stringify(op.payload ?? null),
      Number(op.created_at) || 0,
      op.sig ?? null,
    );
  }
  if (Number(data.since) > since) setState("since", Number(data.since));
  // La borne basse de l'archive du cloud : ce qu'il a encore. Tout ce qui est plus
  // ancien a été purgé — c'est ce que le local lui rendra.
  if (data.oldest_created_at !== undefined && data.oldest_created_at !== null) {
    setState("oldest_created_at", Number(data.oldest_created_at));
  }
  return { recues: ops.length, since: Number(data.since ?? since) };
}

/**
 * La REMONTÉE : l'instance locale rend au cloud ce que la rétention a purgé.
 *
 * Le cloud garde l'archive six mois, puis il oublie. La copie locale, elle, garde
 * tout. Sans cette remontée, la copie locale serait une archive morte : on ne
 * pourrait pas la relire (elle ne sert qu'à la restauration locale) ni la
 * rendre au cloud quand celui-ci a oublié.
 *
 * Le cloud VÉRIFIE la signature de chaque op : la route refuse ce qu'il ne sait
 * pas rattacher à un appareil du compte. Le local ne peut donc pas y injecter un
 * historique fabriqué — il rend ce que les écrans ont réellement signé.
 *
 * On ne renvoie que ce qui est PLUS ANCIEN que la borne basse du cloud : le reste
 * y est déjà.
 */
export async function remontee() {
  const cfg = config();
  const borneCloud = Number(state("oldest_created_at") ?? 0);
  // Sans borne connue (jamais de miroir réussi), on ne renvoie rien : le cloud
  // n'a rien oublié de connu, et tout renvoyer serait du gaspillage.
  if (!borneCloud) return { renvoyees: 0, raison: "borne inconnue" };

  const ops = db
    .prepare(
      `SELECT id, shop_id, device_id, seq, type, entity_id, payload, created_at, sig
         FROM mirror_ops WHERE created_at < ? ORDER BY created_at, id LIMIT ?`,
    )
    .all(borneCloud, 2000)
    .map((r) => ({
      id: r.id,
      shop_id: r.shop_id,
      device_id: r.device_id,
      seq: Number(r.seq),
      type: r.type,
      entity_id: r.entity_id,
      payload: r.payload ? JSON.parse(r.payload) : null,
      created_at: Number(r.created_at),
      ...(r.sig ? { sig: r.sig } : {}),
    }));
  if (ops.length === 0) return { renvoyees: 0 };

  const res = await fetch(`${cfg.cloud}/api/v1/mirror/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      account_phone: cfg.phone,
      account_password: cfg.password,
      ops,
    }),
  });
  if (!res.ok) throw new Error(`Remontée refusée : HTTP ${res.status}`);
  const data = await res.json();
  return {
    renvoyees: Number(data.acceptes ?? 0),
    refusees: Number(data.refuses ?? 0),
    doublons: Number(data.doublons ?? 0),
  };
}

/** Un cycle complet : on descend (le cloud → local), puis on remonte ce qui a été oublié. */
export async function synchroniser() {
  const descendu = await miroir();
  const remonte = await remontee();
  return { ...descendu, ...remonte };
}

const PAGE_SIZE = 100;

/** Une page de l'archive locale, dans l'ordre du rejeu. */
function pageOps(cursor, limit) {
  return db
    .prepare(
      `SELECT id, shop_id, device_id, seq, type, entity_id, payload, created_at, sig
         FROM mirror_ops ORDER BY created_at, id LIMIT ? OFFSET ?`,
    )
    .all(limit, cursor)
    .map((r) => ({
      id: r.id,
      shop_id: r.shop_id,
      device_id: r.device_id,
      seq: Number(r.seq),
      type: r.type,
      entity_id: r.entity_id,
      payload: r.payload ? JSON.parse(r.payload) : null,
      created_at: Number(r.created_at),
      ...(r.sig ? { sig: r.sig } : {}),
    }));
}

const countOps = () =>
  Number(db.prepare("SELECT COUNT(*) AS c FROM mirror_ops").get()?.c ?? 0);

const json = (res, code, body) => {
  const texte = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(texte);
};

/**
 * L'instance locale sert l'archive DU COMPTE : elle doit prouver qu'on est bien ce
 * compte, sinon quiconque approche sur le réseau local (un café voisin, un portable
 * d'invité) pourrait vider l'archive.
 *
 * Les identifiants sont ceux du compte — les mêmes que ceux du cloud, que le
 * commerçant connaît déjà. On les compare en temps constant : une comparaison
 * `===` laisse fuiter le préfixe correct par chronométrage.
 */
function identifiantsOk(phone, password) {
  const cfg = config();
  const attendu = cfg.phone;
  const donne = String(phone ?? "").trim();
  if (donne !== attendu) return false;
  const a = Buffer.from(String(password ?? ""));
  const b = Buffer.from(cfg.password);
  // `timingSafeEqual` exige deux buffers de MÊME longueur.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function lireCorps(req) {
  const morceaux = [];
  for await (const m of req) morceaux.push(m);
  if (morceaux.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(morceaux).toString("utf8"));
  } catch {
    return {};
  }
}

// ── Le serveur local ─────────────────────────────────────────────────────────────
export function creerServeur() {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const chemin = url.pathname;

    // 1. La restauration est servie DEPUIS LE LOCAL.
    if (chemin === "/api/v1/restore" && req.method === "POST") {
      const body = await lireCorps(req);
      const device_id = String(body.device_id ?? "");
      const shop_id = String(body.shop_id ?? "");
      if (!device_id || !shop_id) {
        return json(res, 400, { error: "device_id et shop_id sont requis." });
      }
      // L'archive du compte ne se sert qu'à son compte.
      if (!identifiantsOk(body.account_phone, body.account_password)) {
        return json(res, 401, { error: "Identifiants du compte incorrects." });
      }
      const jobId = randomUUID().replace(/-/g, "");
      db.prepare("INSERT INTO mirror_jobs (id, created_at) VALUES (?, ?)").run(jobId, Date.now());
      const total = countOps();
      return json(res, 200, {
        job_id: jobId,
        status: total > 0 ? "ready" : "pending",
        total_ops: total,
        message: total > 0 ? "Archive locale disponible." : "Aucune donnée archivée localement.",
      });
    }

    if (chemin.startsWith("/api/v1/restore/") && req.method === "GET") {
      const jobId = chemin.split("/").pop();
      if (!jobId || !db.prepare("SELECT id FROM mirror_jobs WHERE id = ?").get(jobId)) {
        return json(res, 404, { error: "Restauration inconnue." });
      }
      // Le job EST la preuve : il est aléatoire et n'existe que si les identifiants
      // du compte ont été vérifiés à l'ouverture. Le relire ne demande donc rien de
      // plus — comme la route du cloud, où le job tient lieu de jeton.
      const cursor = Math.max(0, Number(url.searchParams.get("cursor")) || 0);
      const ops = pageOps(cursor, PAGE_SIZE);
      const total = countOps();
      const next = cursor + ops.length;
      return json(res, 200, {
        status: "ready",
        ops,
        cursor: next,
        has_more: next < total,
        total_ops: total,
      });
    }

    // 2. Le miroir part tout seul, régulièrement.
    if (chemin === "/api/v1/local/mirror" && req.method === "POST") {
      try {
        const r = await synchroniser();
        return json(res, 200, { ok: true, ...r });
      } catch (e) {
        return json(res, 502, { error: e instanceof Error ? e.message : "Miroir impossible." });
      }
    }

    // 3. Le reste de l'API est PROXYFIÉ vers le cloud : l'instance locale est alors
    //    un orchestrateur de substitution.
    //
    //    SAUF le miroir : le proxy ne doit pas le relayer. Toutes les requêtes
    //    sortiraient alors de la MÊME IP (celle du PC), et le verrou de débit du
    //    cloud — qui protège la vérification du mot de passe — serait contourné :
    //    n'importe qui sur le réseau local pourrait tester des mots de passe sans
    //    jamais être bloqué. Le miroir local a son propre chemin (ci-dessus).
    if (chemin.startsWith("/api/")) {
      if (chemin === "/api/v1/mirror/ops" || chemin === "/api/v1/mirror/push") {
        return json(res, 403, { error: "Le miroir se tire directement du cloud." });
      }
      const cible = `${config().cloud}${req.url}`;
      const corps = req.method === "GET" || req.method === "HEAD" ? null : await lireCorps(req);
      try {
        const r = await fetch(cible, {
          method: req.method,
          headers: { "Content-Type": "application/json" },
          ...(corps ? { body: JSON.stringify(corps) } : {}),
        });
        const texte = await r.text();
        res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") ?? "application/json" });
        return res.end(texte);
      } catch (e) {
        return json(res, 502, {
          error: `Cloud injoignable : ${e instanceof Error ? e.message : "erreur"}`,
        });
      }
    }

    return json(res, 404, { error: "Route inconnue." });
  });
}

/** Ferme la base locale (indispensable sous Windows : le fichier reste verrouillé
 *  tant que la connexion est ouverte). */
export function fermer() {
  try {
    db.close();
  } catch {
    /* déjà fermée */
  }
}

// Lancement direct (et non importé par un test).
if (process.argv[1] && process.argv[1].endsWith("local-orchestrator.mjs")) {
  const server = creerServeur();
  server.listen(PORT, () => {
    console.log(`Orchestrateur local sur http://localhost:${PORT}`);
    console.log(`  miroir : ${config().cloud} (compte ${config().phone})`);
    console.log(`  archive locale : ${dbPath}`);
  });
  miroir()
    .then((r) => console.log(`  premier miroir : ${r.recues} opération(s)`))
    .catch((e) => console.error(`  premier miroir impossible : ${e.message}`));
  setInterval(() => {
    synchroniser()
      .then((r) => {
        if (r.recues > 0) console.log(`miroir : ${r.recues} opération(s) reçue(s)`);
        if (r.renvoyees > 0) console.log(`remontée : ${r.renvoyees} opération(s) rendue(s)`);
      })
      .catch((e) => console.error(`miroir impossible : ${e.message}`));
  }, MIRROR_INTERVAL_MS);
}
