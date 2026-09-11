import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import pg from "pg";

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

export const PORT = Number(process.env.PORT ?? 8787);
// Adresse du relais ops (boîte à lettres.) Le DRAINER la vide par copie à chaque
// démarrage + périodiquement. Sans .env ni variable d'env, c'est le relais PUBLIC
// déployé (Vercel/Neon) qui est présumé ; en dev local, .env peut pointer ailleurs.
export const OPS_RELAY_URL = String(
  process.env.OPS_RELAY_URL ?? "https://simple-sale-orchestrator.vercel.app",
).replace(/\/+$/, "");
// Secret partagé du relais ops (header x-ops-token) — même valeur que l'env OPS_TOKEN du
// relais déployé. La caisse, elle, l'envoie via VITE_OPS_TOKEN. Vide → relais ouvert (dev).
export const OPS_TOKEN = process.env.OPS_TOKEN ?? "";
export const OPS_DRAIN_INTERVAL_MS = Number(process.env.OPS_DRAIN_INTERVAL_MS ?? 3_600_000);
export const PRICE_PER_MONTH_FCFA = Number(process.env.PRICE_PER_MONTH_FCFA ?? 10_000);
export const TRIAL_DAYS = Number(process.env.TRIAL_DAYS ?? 30);
// ── Paliers d'abonnement ───────────────────────────────────────────────────────────
// Un paiement couvre 30 jours et fixe le nombre d'appareils du compte. Configurable par
// env : PRICE_TIERS="10000:3,25000:5,50000:9". Le tarif historique PRICE_PER_MONTH_FCFA
// ne sert plus qu'aux routes legacy sans palier reconnu. L'écran du propriétaire compte
// dans le nombre d'appareils affiché (3 = propriétaire + 2 autres, jamais +1).
export const PRICE_TIERS = String(process.env.PRICE_TIERS ?? "10000:3,25000:5,50000:9")
  .split(",")
  .map((chunk) => {
    const [price, devices] = chunk.split(":").map(Number);
    return Number.isFinite(price) && price > 0 && Number.isFinite(devices) && devices > 0
      ? { price, devices }
      : null;
  })
  .filter(Boolean)
  .sort((a, b) => a.price - b.price);

// Noms commerciaux des paliers (miroir des PLANS du configurateur de la caisse). Clés
// par nombre d'écrans, jamais par prix : la facturation peut bouger sans casser
// l'affichage. Au-delà des paliers connus (ou sur mesure) → null, rendu « sur mesure ».
export const planNameForDevices = (devices) =>
  devices === 3 ? "Essentiel" : devices === 5 ? "Confort" : devices === 9 ? "Affluence" : null;

export const DAY_MS = 86_400_000;
// Durée de validité d'un ordre avant qu'il ne soit déclaré « non délivré (expiré) ».
export const COMMAND_TTL_MS = 30 * DAY_MS;
export const SESSION_MS = 7 * 24 * 3600 * 1000;
// Grace period : 2 jours après l'expiration pendant lesquels le compte reste actif
// (100% fonctionnel) avant la coupure définitive. Configurable via GRACE_PERIOD_DAYS.
const GRACE_PERIOD_DAYS = Number(process.env.GRACE_PERIOD_DAYS ?? 2);
export const GRACE_PERIOD_MS = GRACE_PERIOD_DAYS * DAY_MS;

export const EXPLICIT =
  typeof process.env.ADMIN_PASSWORD === "string" && process.env.ADMIN_PASSWORD.length > 0;
export const ADMIN_PASSWORD = EXPLICIT ? process.env.ADMIN_PASSWORD : randomBytes(8).toString("hex");

// ── Webhook SMS (TextBee → auto-renouvellement) ───────────────────────────────────
// Secret partagé exigé via `?token=` sur POST /api/v1/webhook/sms — TextBee l'injecte
// dans l'URL du webhook configuré. Générez-en un fort : SMS_WEBHOOK_TOKEN=openssl rand -hex 24
export const SMS_WEBHOOK_TOKEN =
  typeof process.env.SMS_WEBHOOK_TOKEN === "string" && process.env.SMS_WEBHOOK_TOKEN.length > 0
    ? process.env.SMS_WEBHOOK_TOKEN
    : randomBytes(12).toString("hex");

// ── Base POSTGRES (Neon en production, localhost en dev) ──────────────────────────
// DATABASE_URL : chaîne de connexion complète (libpq). En local, le pool pointe vers la
// base de validation `orchestrator_local` du Postgres 15. L'orchestrateur est désormais
// STATELESS côté disque : plus aucun fichier SQLite local à exposer (fini ngrok).
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/orchestrator_local";

// Les agrégats COUNT/SUM reviennent en int8 (chaîne chez node-pg) : convertir en nombre
// pour que toute l'arithmétique existante (.c, .s) reste en Number.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.INT4, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

// Facette d'accès proche de l'API SQLite historique, mais ASYNC (promesses) :
//   await db.run(sql, ...params) → { changes }    (INSERT/UPDATE/DELETE)
//   await db.get(sql, ...params)  → ligne | undefined
//   await db.all(sql, ...params)  → lignes[]
//   await db.exec(sql)            → exécution sans paramètre
//   await db.tx(client => {...})  → transaction (BEGIN/COMMIT/ROLLBACK)
// Les `?` SQLite deviennent des `$1..$n` Postgres à chaque appel.
export const db = {
  async run(sql, ...params) {
    const r = await pool.query(sql, params);
    return { changes: r.rowCount ?? 0 };
  },
  async get(sql, ...params) {
    const r = await pool.query(sql, params);
    return r.rows[0];
  },
  async all(sql, ...params) {
    const r = await pool.query(sql, params);
    return r.rows;
  },
  async exec(sql) {
    await pool.query(sql);
    return { changes: 0 };
  },
  async tx(fn) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },
};

// ── Projets ────────────────────────────────────────────────────────────────────────
export const projectById = (id) => db.get("SELECT * FROM projects WHERE id = $1", id);

// ── Registre des manifests (types de projet connus) ────────────────────────────────
const MANIFESTS_DIR = join(__dirname, "manifests");
export const manifests = new Map();
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

// ── Tarif & essai effectifs d'un projet ─────────────────────────────────────────────
// Priorité : valeur enregistrée sur le projet > manifest du même id > valeurs globales.
export async function projectConfig(origin) {
  const proj = origin ? await projectById(origin) : null;
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

// ── Initialisation : schéma Postgres + semence du projet 'pos' ─────────────────────
// À appeler UNE fois avant d'écouter (index.mjs) : migrations idempotentes, puis le
// projet de référence 'pos' prend le mot de passe admin par défaut, pour que la
// connexion historique (sans nom de projet) retrouve son dashboard. Tarif/essai/type
// initialisés depuis son manifest s'il existe.
//
// Les instructions sont appliquées UNE PAR UNE : déjà validé sur Neon, où une exécution
// groupée (client.query multi-statement) n'est pas fiable à travers le pooler. La
// division se fait sur `;\n` et les en-têtes de commentaires sont escamotés.
const MIGRATION_STATEMENT_RE = /^(CREATE|DROP|ALTER|INSERT|UPDATE|DELETE|SELECT)/i;
async function applySchema(sql) {
  for (const raw of sql.split(";\n")) {
    const stmt = raw.replace(/^--[^\n]*\n?/gm, "").trim();
    if (!stmt || !MIGRATION_STATEMENT_RE.test(stmt)) continue;
    await pool.query(stmt);
  }
}

export async function initialize() {
  await applySchema(readFileSync(join(__dirname, "migrations.pg.sql"), "utf8"));
  const seedCfg = await projectConfig("pos");
  await db.run(
    `INSERT INTO projects (id, name, password, created_at, type, price_per_month_fcfa, trial_days)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    "pos",
    "Caisse",
    ADMIN_PASSWORD,
    Date.now(),
    seedCfg.type ?? null,
    seedCfg.price_per_month_fcfa,
    seedCfg.trial_days,
  );
  console.log("[db] schéma Postgres prêt.");
}

// Une caisse est « en ligne » si on a eu de ses nouvelles il y a moins de 2 minutes.
export const ONLINE_WINDOW_MS = 120_000;