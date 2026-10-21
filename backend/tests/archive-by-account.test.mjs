// L'ARCHIVE se range par COMPTE, pas par groupe P2P.
//
// Pourquoi : le groupe d'un écran peut changer — un téléphone réinstallé, une fiche
// locale purgée, un compte réattribué : le groupe est recalculé. Une archive rangée
// par groupe devient alors introuvable AU MOMENT PRÉCIS où l'on en a besoin (un
// téléphone qui a perdu ses données). Le compte, lui, ne bouge pas.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.REQUIRE_SECRETS = "true";
process.env.ADMIN_PASSWORD ||= "mot-de-passe-de-test";
process.env.SMS_WEBHOOK_TOKEN ||= "jeton-webhook-de-test";
process.env.OPS_TOKEN ||= "jeton-relais-de-test";
process.env.BACKUP_KEY ||= "pepper-de-test-32-octets-minimum-ici";

const drainer = readFileSync(new URL("../drainer.mjs", import.meta.url), "utf8");
const restore = readFileSync(new URL("../routes/restore.mjs", import.meta.url), "utf8");
const migrations = readFileSync(new URL("../migrations.pg.sql", import.meta.url), "utf8");

test("l'archive porte le compte propriétaire de chaque opération", () => {
  assert.match(migrations, /ALTER TABLE sync_ops ADD COLUMN IF NOT EXISTS account_id BIGINT/);
  assert.match(migrations, /idx_sync_ops_account/);
  // Le drainer écrit le compte…
  assert.match(drainer, /INSERT INTO sync_ops \([^)]*account_id\)/);
  // … et le remplit à l'archivage.
  assert.match(drainer, /accountId,\s*\)/);
  // Une op déjà archivée se voit Completed son compte (re-drain).
  assert.match(drainer, /ON CONFLICT \(id\) DO UPDATE SET account_id = EXCLUDED\.account_id/);
});

test("la restauration lit l'archive par COMPTE, plus par groupe", () => {
  // Le comptage…
  assert.match(restore, /SELECT COUNT\(\*\) AS n FROM sync_ops WHERE account_id = \$1/);
  // … et la lecture des pages.
  assert.match(restore, /FROM sync_ops\s+WHERE account_id = \$1/);
  // Le groupe annoncé ne doit PLUS conditionner la lecture.
  assert.ok(
    !/FROM sync_ops\s+WHERE shop_id = \$1/.test(restore),
    "la lecture ne doit plus être bornée au groupe P2P",
  );
});
