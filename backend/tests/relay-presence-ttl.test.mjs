// RELAIS — mission 3 niveaux : API Presence + TTL 7 jours.
//
// Scénario 2 (patron offline) : la caisse consulte la présence AVANT de pousser —
// absent, elle confie quand même l'op au relais et garde une copie `sent`.
// Scénario 3 (relais coupe le fil) : toute op dépôtée vit au plus OPS_TTL_MS
// (7 jours), puis le balai TTL la supprime — le patron qui reviendra trop tard
// force la caisse à re-pousser (ops `sent` → `pending` → drain).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.REQUIRE_SECRETS = "true";
process.env.ADMIN_PASSWORD ||= "mot-de-passe-de-test";
process.env.SMS_WEBHOOK_TOKEN ||= "jeton-webhook-de-test";
process.env.OPS_TOKEN ||= "jeton-relais-de-test";
process.env.BACKUP_KEY ||= "pepper-de-test-32-octets-minimum-ici";

const handler = readFileSync(
  new URL("../../relay/handler.mjs", import.meta.url),
  "utf8",
);
const schema = readFileSync(
  new URL("../../relay/schema.sql", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL("../../relay/migrations/2026-11-02-presence-ttl.sql", import.meta.url),
  "utf8",
);

test("l'API PRESENCE existe et renvoie les device_id vus au cours des 2 dernières minutes", () => {
  assert.match(handler, /case "\/api\/v1\/presence"/);
  assert.match(handler, /PRESENCE_MS/);
  assert.match(handler, /7 \* 60_000|2 \* 60_000/, "fenêtre de présence");
  // La requête filtre sur `last_pulled_at` de la table device_pull.
  assert.match(handler, /last_pulled_at >= \$2/);
  // La réponse est `{ online: [...] }` — le contrat attendu par la caisse.
  assert.match(handler, /\{ online: rows\.map/);
});

test("chaque push reçoit une date d'expiration (TTL 7 jours)", () => {
  assert.match(handler, /OPS_TTL_MS/);
  assert.match(handler, /7 \* 86_400_000/, "TTL par défaut de 7 jours");
  // La colonne est écrite à l'INSERT et le INSERT la référence.
  assert.match(handler, /now \+ OPS_TTL_MS/);
  assert.match(handler, /received_at, sig, expires_at\)/);
  assert.match(handler, /\$\$\{base \+ 11\}\)/, "11e paramètre de l'INSERT");
});

test("le balai TTL supprime les ops expirées, indépendamment de SWEEP_ENABLED", () => {
  assert.match(handler, /async function sweepExpiredTtl/);
  assert.match(
    handler,
    /DELETE FROM sync_ops WHERE expires_at IS NOT NULL AND expires_at < \$1/,
  );
  // Indépendant du filet de fraîcheur : pas de `if (!SWEEP_ENABLED)` dans le balai TTL.
  const balai = handler.split("async function sweepExpiredTtl")[1];
  assert.ok(!balai.includes("SWEEP_ENABLED"), "le TTL ne doit pas être désactivable");
});

test("le pull ne partage jamais une op expirée", () => {
  assert.match(handler, /expires_at IS NULL OR expires_at >= /);
});

test("le schéma et la migration portent la colonne + index", () => {
  assert.match(schema, /expires_at\s+BIGINT/);
  assert.match(schema, /idx_sync_ops_expires/);
  assert.match(migration, /ALTER TABLE sync_ops ADD COLUMN IF NOT EXISTS expires_at BIGINT/);
  // Rampe de départ : les ops déjà déposées reçoivent leur TTL (received_at + 7 j).
  assert.match(migration, /SET expires_at = received_at \+ 7 \* 86400000/);
});
