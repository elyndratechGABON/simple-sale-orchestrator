import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

// Applique relay/schema.sql sur la base pointée par DATABASE_URL (ex. Neon).
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL manquant — ex: DATABASE_URL=postgres://… node apply-schema.mjs");
  process.exit(1);
}
const sql = readFileSync(fileURLToPath(new URL("./schema.sql", import.meta.url)), "utf8");
const client = new Client({ connectionString: url });
await client.connect();
await client.query(sql);
await client.end();
console.log("Schéma du relais appliqué.");
