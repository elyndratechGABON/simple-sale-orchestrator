import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

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
// Adresse du relais ops (boîte aux lettres Neon). Le DRAINER la vide par copie à chaque
// démarrage + périodiquement. Sans .env ni variable d'env, le relais local (npm start
// dans relay/, port 8080) est présumé ; en production, pointer vers l'URL déployée,
// ex. https://ecaisse-ops-relay.vercel.app.
export const OPS_RELAY_URL = String(process.env.OPS_RELAY_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
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

// ── Base SQLite (même fichier que l'ancien server.mjs) ────────────────────────────
// ORCHESTRATOR_DB permet de pointer ailleurs (tests, déploiement) ; défaut : la base
// historique de l'orchestrateur.
const DATA_DIR = join(__dirname, "..", "orchestrator", "data");
mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = process.env.ORCHESTRATOR_DB
  ? resolve(process.env.ORCHESTRATOR_DB)
  : join(DATA_DIR, "orchestrator.db");
export const db = new DatabaseSync(DB_FILE);

db.exec("PRAGMA journal_mode = WAL;");
db.exec(readFileSync(join(__dirname, "migrations.sql"), "utf8"));

// ── Paiements SMS (auto-renouvellement via TextBee) ──────────────────────────────
// Les SMS de confirmation Mobile Money sont forwardés par TextBee vers le webhook.
// Le serveur parse le SMS, match le client (phone + nom) et le montant (palier), puis
// renouvelle automatiquement l'abonnement si tout correspond. TID UNIQUE = idempotence
// (un SMS reçu 2 fois n'est jamais traité 2 fois).
// Status : pending → matched | unmatched | duplicate | processed
db.exec(`
  CREATE TABLE IF NOT EXISTS sms_payments (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_sms            TEXT NOT NULL,
    phone              TEXT NOT NULL,
    name               TEXT NOT NULL,
    amount_fcfa        INTEGER NOT NULL,
    tid                TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'matched', 'unmatched', 'duplicate', 'processed')),
    matched_account_id INTEGER REFERENCES accounts(id),
    matched_tier_price INTEGER,
    error              TEXT,
    received_at        INTEGER NOT NULL,
    processed_at       INTEGER,
    created_at         INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_payments_tid ON sms_payments (tid);
  CREATE INDEX IF NOT EXISTS idx_sms_payments_status ON sms_payments (status, created_at);
`);

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

// Colonnes du modèle multi-écrans : rattachement des fiches existantes à un compte,
// paiements et commandes adressables au niveau compte.
addShopColumn("account_id", "account_id INTEGER");
const addColumn = (table, name, ddl) => {
  if (!columnNames(table).includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
};
addColumn("payments", "account_id", "account_id INTEGER");
addColumn("admin_commands", "account_id", "account_id INTEGER");
// La boîte aux lettres accepte désormais `delete_account_request` (approbation/refus de
// la suppression d'une caisse demandée par l'employé, cf. delete_requests). Le CHECK de
// la table ne se modifie PAS en place sous SQLite : on reconstruit UNE fois (renommage +
// recopie), en conservant la colonne `account_id` ajoutée ci-dessus. Détection par le
// SQL enregistré — une base déjà migrée ne repasse jamais par là.
{
  const adminCommandsDdl =
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'admin_commands'").get()?.sql ??
    "";
  if (!adminCommandsDdl.includes("delete_account_request")) {
    db.exec("BEGIN");
    try {
      db.exec("ALTER TABLE admin_commands RENAME TO admin_commands_legacy");
      db.exec(`
        CREATE TABLE admin_commands (
          id            TEXT PRIMARY KEY,
          device_id     TEXT NOT NULL,
          account_id    INTEGER,
          action_type   TEXT NOT NULL CHECK (action_type IN ('suspend', 'renew', 'broadcast_message', 'delete_account_request')),
          payload       TEXT NOT NULL,
          expires_at    INTEGER NOT NULL,
          delivered_at  INTEGER,
          superseded_at INTEGER,
          created_at    INTEGER NOT NULL
        )
      `);
      db.exec(
        `INSERT INTO admin_commands (id, device_id, account_id, action_type, payload, expires_at, delivered_at, superseded_at, created_at)
         SELECT id, device_id, account_id, action_type, payload, expires_at, delivered_at, superseded_at, created_at
         FROM admin_commands_legacy`,
      );
      db.exec("DROP TABLE admin_commands_legacy");
      db.exec("CREATE INDEX IF NOT EXISTS idx_admin_commands_device ON admin_commands (device_id)");
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_admin_commands_pending ON admin_commands (device_id, delivered_at, superseded_at)",
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}
// Fusion par nom d'enseigne : un compte absorbé garde sa ligne (ses identifiants restent
// valides à l'authentification) mais redirige vers le compte survivant via merged_into.
addColumn("accounts", "merged_into", "merged_into INTEGER");
// Mot clé de récupération : fourni à la FIN de la création du compte, il permet de
// rattacher un nouvel écran (téléphone perdu) depuis n'importe quel appareil. Unique et
// conservé côté serveur ; jamais renvoyé ensuite — l'écran créateur le reçoit une seule
// fois, les autres le tiennent de leur utilisateur.
addColumn("accounts", "keyword", "keyword TEXT");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_keyword ON accounts (keyword) WHERE keyword IS NOT NULL");

// ── Empreinte numérique de l'appareil (Phase 2 — 1 téléphone = 1 boutique) ────────
// SHA-256 de (user-agent + screen + timezone + hardwareConcurrency + langue). Le serveur
// exige l'unicité : un même appareil physique ne peut créer qu'une seule boutique, même
// si l'utilisateur tente une réinscription avec un device_id différent.
addShopColumn("device_fingerprint", "device_fingerprint TEXT");
const shopsHasFingerprint = shopsColumns.includes("device_fingerprint") ||
  db.prepare("PRAGMA index_list('shops')").all().some((i) => i.name === "uniq_fingerprint");
if (!shopsHasFingerprint) {
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_fingerprint ON shops (device_fingerprint) WHERE device_fingerprint IS NOT NULL`);
  } catch {
    // Index peut déjà exister si la colonne a été ajoutée manuellement.
  }
}

// ── Projets ────────────────────────────────────────────────────────────────────────
// Un projet peut être adossé à un MANIFEST (dossier `backend/manifests/*.json`) : le
// fichier décrit le type d'app, son tarif et ses KPI. Généré par `tools/project-scanner`
// pour chaque app du réseau. Quand un handshake arrive avec un `app_origin` inconnu,
// le manifest correspondant (s'il existe) sert à provisionner le projet correctement.
export const projectById = (id) => db.prepare("SELECT * FROM projects WHERE id = ?").get(id);

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
export function projectConfig(origin) {
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

// Une caisse est « en ligne » si on a eu de ses nouvelles il y a moins de 2 minutes.
export const ONLINE_WINDOW_MS = 120_000;
