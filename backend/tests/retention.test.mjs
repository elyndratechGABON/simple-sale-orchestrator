// La RÉTENTION : sans elle, la base grossit à l'infini.
//
// Les trois tables qui grossissent sont celles qui n'apportent plus rien au bout d'un
// certain âge : les agrégats d'écran (le tableau de bord n'en lit que le dernier par
// écran, et les graphiques sur 7 jours), le journal d'audit, et l'archive des
// opérations (le filet de restauration).
//
// Ce qui est CONSERVÉ : les chiffres du commerçant — `daily_stats` (le CA par jour et
// par écran) et `payments` (les encaissements).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.REQUIRE_SECRETS = "true";
process.env.ADMIN_PASSWORD ||= "mot-de-passe-de-test";
process.env.SMS_WEBHOOK_TOKEN ||= "jeton-webhook-de-test";
process.env.OPS_TOKEN ||= "jeton-relais-de-test";
process.env.BACKUP_KEY ||= "pepper-de-test-32-octets-minimum-ici";

const drainer = readFileSync(new URL("../drainer.mjs", import.meta.url), "utf8");

test("le drainer applique une politique de rétention", () => {
  assert.match(drainer, /async function pruneRetention/);
  // Les agrégats d'écran : 8 jours, plus le dernier de chaque écran.
  assert.match(drainer, /DELETE FROM sync_payloads/);
  assert.match(
    drainer,
    /id NOT IN \(SELECT max\(id\) FROM sync_payloads GROUP BY device_id\)/,
    "le dernier agrégat de chaque écran doit être conservé",
  );
  // Le journal d'audit : six mois.
  assert.match(drainer, /DELETE FROM activity_events WHERE created_at < \$1/);
  // L'archive des opérations (le filet de restauration) : six mois.
  assert.match(drainer, /DELETE FROM sync_ops WHERE created_at < \$1/);
});

test("les chiffres du commerçant ne sont jamais purgés", () => {
  // Le CA par jour (daily_stats) et les encaissements (payments) restent : c'est
  // l'histoire de la boutique, pas un journal technique.
  assert.ok(
    !/DELETE FROM daily_stats/.test(drainer),
    "l'historique quotidien du CA doit être conservé",
  );
  assert.ok(!/DELETE FROM payments/.test(drainer), "les encaissements doivent être conservés");
});
