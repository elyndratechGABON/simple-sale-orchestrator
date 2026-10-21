// Le drainer doit rattacher un GROUPE P2P à son compte marchand.
//
// Les opérations du relais portent l'identité du canal P2P (`device_id`), qui n'est
// PAS l'identifiant serveur de la fiche boutique (`shops.device_id`) : les deux
// désignent le même téléphone, mais ce sont deux identifiants. Le lien passe par
// l'ANNONCE, qui porte les deux.
//
// Sans ce lien, l'archive ne se remplissait jamais : les opérations partaient à la
// purge du relais sans avoir jamais été archivées, et la restauration d'une boutique
// supprimée ne trouvait rien à rendre.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.REQUIRE_SECRETS = "true";
process.env.ADMIN_PASSWORD ||= "mot-de-passe-de-test";
process.env.SMS_WEBHOOK_TOKEN ||= "jeton-webhook-de-test";
process.env.OPS_TOKEN ||= "jeton-relais-de-test";
process.env.BACKUP_KEY ||= "pepper-de-test-32-octets-minimum-ici";

const drainer = readFileSync(new URL("../drainer.mjs", import.meta.url), "utf8");

test("le rattachement se fait par les DEUX identifiants (P2P et serveur)", () => {
  const start = drainer.indexOf("async function accountIdForShop");
  assert.ok(start > 0, "accountIdForShop introuvable");
  const block = drainer.slice(start, drainer.indexOf("\n}", start));

  // L'identité P2P des ops…
  assert.match(block, /o\?\.device_id/);
  // … ET l'identifiant serveur que porte l'annonce.
  assert.match(block, /server_device_id/);
  // La requête porte les DEUX jeux.
  assert.match(block, /\[\.\.\.deviceIds, \.\.\.serverIds\]/);
});

test("le drainer signale les groupes non rattachés (pas de silence)", () => {
  assert.match(drainer, /NON ARCHIVÉE/);
});
