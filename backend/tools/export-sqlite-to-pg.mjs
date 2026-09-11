// ── Migration des données : orchestrator.db (SQLite) → Postgres / Neon ──────────
// Copie plate, colonne par colonne, dans l'ordre respectueux des clés étrangères.
// Le schéma Postgres (migrations.pg.sql) est un calque exact de la base SQLite
// (mêmes noms, mêmes types au sens BIGINT=INTEGER, TEXT=TEXT) : aucun re-typeage
// nécessaire — seuls les épisodes epoch-ms sont préservés tels quels.
//
// Idempotent : INSERT ... ON CONFLICT DO NOTHING partout (on peut relancer).
//
//   node tools/export-sqlite-to-pg.mjs                 # dry-run (plan + écarts)
//   node tools/export-sqlite-to-pg.mjs --apply         # écrit sous Postgres
//
// Cible : DATABASE_URL (défaut : la base locale de développement).
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SOURCE_DB = process.env.SOURCE_DB ?? join(__dirname, "..", "..", "orchestrator", "data", "orchestrator.db");
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/orchestrator_local";
const APPLY = process.argv.includes("--apply");
const ONLY = process.argv.includes("--table") ? process.argv[process.argv.indexOf("--table") + 1] : null;
const BATCH = 500;

// Affichage SANS jamais exposer le mot de passe (l'URL complète contient les creds).
function publicUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.username) {
      u.username = "***";
      u.password = "";
    }
    return u.toString();
  } catch {
    return raw.replace(/[^:]*@/, "***@");
  }
}

// Ordre de copie : d'abord les tables sans dépendance, puis celles qui pointent.
const TABLES = [
  "projects",
  "shops",
  "accounts",
  "payments",
  "admin_commands",
  "sync_payloads",
  "daily_stats",
  "subscription_requests",
  "delete_requests",
  "admin_actions",
  "activity_events",
  "payment_events",
  "sync_ops",
  "device_blessings",
  "device_credentials",
  "sms_payments",
];

// FKs (table enfant → colonne → table parent) pour le contrôle d'intégrité.
const FKS = [
  ["payments", "shop_id", "shops"],
  ["payments", "account_id", "accounts"],
  ["subscription_requests", "account_id", "accounts"],
  ["activity_events", "shop_id", "shops"],
  ["activity_events", "account_id", "accounts"],
  ["activity_events", "project_id", "projects"],
  ["payment_events", "account_id", "accounts"],
  ["payment_events", "shop_id", "shops"],
  ["device_blessings", "account_id", "accounts"],
  ["device_credentials", "account_id", "accounts"],
  ["sms_payments", "matched_account_id", "accounts"],
];

const source = new DatabaseSync(SOURCE_DB, { readOnly: true });
const client = new pg.Client({ connectionString: DATABASE_URL });

function pad(n) {
  return String(n).padStart(9, " ");
}

async function countRows(q, params = []) {
  const r = await client.query(`SELECT COUNT(*) AS c FROM ${q}`, params);
  return Number(r.rows[0].c);
}

async function setSequences() {
  // Les id explicites importés n'avancent pas la séquence : on la rembobine après coup
  // pour que les prochaines insertions (BIGSERIAL) ne heurtent pas un id existant.
  // Seules les tables à id BIGSERIAL ont une séquence (projects/admin_commands/sync_ops
  // ont un id TEXT, sans solveur de séquence).
  const serial = (
    await client.query(
      `SELECT table_name FROM information_schema.columns
       WHERE column_name = 'id' AND data_type IN ('integer', 'bigint')`,
    )
  ).rows.map((r) => r.table_name);
  for (const t of serial) {
    await client.query(
      `SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE(MAX(id), 1), true) FROM "${t}"`,
    );
  }
  console.log(`[seq] séquences BIGSERIAL renroulées sur MAX(id) (${serial.length} table(s)).`);
}

async function checkOrphans(inserted) {
  for (const [child, col, parent] of FKS) {
    if (!inserted.includes(child)) continue;
    const r = await client.query(
      `SELECT COUNT(*) AS c FROM "${child}" c
       WHERE c.${col} IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM "${parent}" p WHERE p.id = c.${col})`,
    );
    const n = Number(r.rows[0].c);
    if (n > 0) console.log(`  ⚠ orphelins ${child}.${col} → ${parent} : ${n}`);
  }
}

async function main() {
  await client.connect();
  console.log(`Cible : ${publicUrl(DATABASE_URL)}  (${APPLY ? "APPLICATION" : "DRY-RUN"})`);
  console.log(`Source : ${SOURCE_DB}`);
  console.log("");

  let grand = { source: 0, inserted: 0, target: 0 };
  const inserted = [];

  for (const table of TABLES) {
    if (ONLY && table !== ONLY) continue;

    const srcCols = source
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map((c) => c.name);
    const dstCols = (
      await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [table],
      )
    ).rows.map((r) => r.column_name);

    const cols = srcCols.filter((c) => dstCols.includes(c));
    if (cols.length === 0) {
      console.log(`- ${table.padEnd(22)} : aucune colonne commune.`);
      continue;
    }
    const colList = cols.join(", ");
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");

    const srcRows = source.prepare(`SELECT ${colList} FROM "${table}"`).all();
    const srcCount = srcRows.length;
    const dstCount = await countRows(`"${table}"`);
    grand.source += srcCount;
    grand.target += dstCount;

    if (!APPLY) {
      const pending = Math.max(0, srcCount - dstCount);
      console.log(`- ${table.padEnd(22)} : src ${pad(srcCount)} · dst ${pad(dstCount)} · à copier ${pad(pending)}`);
      continue;
    }

    let insertedCount = 0;
    for (let i = 0; i < srcRows.length; i += BATCH) {
      const chunk = srcRows.slice(i, i + BATCH);
      const values = chunk.flatMap((row) => cols.map((c) => row[c] ?? null));
      const rowsPlaceholders = chunk.map((_, k) => `(${cols.map((_, j) => `$${k * cols.length + j + 1}`).join(", ")})`).join(", ");
      const r = await client.query(
        `INSERT INTO "${table}" (${colList}) VALUES ${rowsPlaceholders} ON CONFLICT DO NOTHING`,
        values,
      );
      insertedCount += r.rowCount ?? 0;
    }
    grand.inserted += insertedCount;
    inserted.push(table);
    console.log(`- ${table.padEnd(22)} : src ${pad(srcCount)} · copiées +${pad(insertedCount)} · dst ${pad(await countRows(`"${table}"`))}`);
  }

  if (APPLY) {
    await setSequences();
    await checkOrphans(inserted);
    console.log("");
    console.log(`Terminé. ${grand.inserted} ligne(s) insérée(s) sur la cible (total source ${grand.source}).`);
  } else {
    console.log("");
    console.log("Dry-run : rien n'a été écrit. Relancez avec --apply pour importer.");
    console.log("Astuce : contrôlez d'abord les écarts ci-dessus ; colone explique ensuite");
    console.log("que les doublons (ON CONFLICT DO NOTHING) rendent l'outil relançable sans risque.");
  }

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(async () => {
  try {
    await client.end();
  } catch {}
});