// ── Préparation d'une base cible pour l'import ──────────────────────────────────
// Crée (si absente) la base Postgres nommée et y applique migrations.pg.sql.
//   node tools/init-import-db.mjs [nom_de_base]   (défaut : orchestrator_import)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.BASE_DB_URL ?? "postgres://postgres:postgres@127.0.0.1:5432";
const NAME = process.argv[2] ?? "orchestrator_import";

const admin = new pg.Client({ connectionString: `${BASE_URL}/postgres` });
await admin.connect();
const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [NAME]);
if (exists.rowCount === 0) await admin.query(`CREATE DATABASE ${NAME}`);
await admin.end();

const db = new pg.Client({ connectionString: `${BASE_URL}/${NAME}` });
await db.connect();
await db.query(readFileSync(join(__dirname, "..", "migrations.pg.sql"), "utf8"));
await db.end();
console.log(`Base "${NAME}" prête (schéma appliqué).`);