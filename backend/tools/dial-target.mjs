// ── Diagnostic d'une base cible (Neon ou autre) ─────────────────────────────────
// SANS imprimer de secret : affiche l'hôte/la base/le rôle, liste les tables et
// vérifie la capacité à créer une base dédiée. Renseigne le choix orchestrateur
// vs relais (conflit de table `sync_ops` entre les deux schémas).
//
//   $env:TARGET_URL="postgresql://..."; node tools/dial-target.mjs
import pg from "pg";

const url = new URL(process.env.TARGET_URL ?? process.env.DATABASE_URL ?? "");
if (!url.hostname) {
  console.error("TARGET_URL manquant.");
  process.exit(1);
}
const host = url.hostname;
const dbname = url.pathname.replace(/^\//, "") || "(inconnu)";
const user = decodeURIComponent(url.username);
// Le mot de passe n'est JAMAIS affiché : ni ici, ni dans les URL imprimées.

const client = new pg.Client({ connectionString: url.toString() });
await client.connect();

const { rows: [meta] } = await client.query("SELECT current_database() AS db, current_user AS u, version() AS v");
const { rows: [priv] } = await client.query("SELECT rolcreatedb, rolsuper FROM pg_roles WHERE rolname = current_user");
console.log(`Connecté : ${host} → base "${meta.db}" (rôle ${meta.u})`);
console.log(`PG : ${meta.v.split(" on ")[0]}`);
console.log(`Droits : CREATEDB=${priv.rolcreatedb} SUPERUSER=${priv.rolsuper}`);

const tables = (await client.query(
  "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
)).rows.map((r) => r.tablename);
console.log(`Tables présentes (${tables.length}) : ${tables.join(", ") || "(aucune)"}`);

// Si `sync_ops` existe, déterminer à quel schéma elle appartient.
if (tables.includes("sync_ops")) {
  const cols = (await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'sync_ops' ORDER BY ordinal_position",
  )).rows.map((r) => r.column_name);
  const isRelay = cols.includes("received_at") && cols.includes("status");
  const isOrch = cols.includes("drained_at");
  console.log(`sync_ops → ${isRelay && !isOrch ? "schéma RELAIS (boîte aux lettres)" : isOrch && !isRelay ? "schéma ORCHESTRATEUR (archive drainée)" : "schéma AMBIGU / mixte"}`);
  console.log(`  colonnes : ${cols.join(", ")}`);
} else {
  console.log("sync_ops absente : base vierge côté orchestration.");
}

await client.end();