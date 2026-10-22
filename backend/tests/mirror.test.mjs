// Le MIROIR LOCAL : le cloud garde une copie des données chez le commerçant.
//
// L'instance locale TIRE (le serveur ne pousse jamais) et s'authentifie avec les
// MÊMES identifiants de compte que la caisse (téléphone + mot de passe).
//
// Ce qui est verrouillé ici :
//  - le miroir ne rend QUE les opérations du compte authentifié (aucune fuite vers un
//    autre commerce) ;
//  - les charges utiles sont DÉCHIFFRÉES par le compte qui les demande (l'instance
//    locale doit pouvoir les relire, et les relire telles qu'elles ont été émises) ;
//  - un miroir sans identifiants est refusé.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.REQUIRE_SECRETS = "true";
process.env.ADMIN_PASSWORD ||= "mot-de-passe-de-test";
process.env.SMS_WEBHOOK_TOKEN ||= "jeton-webhook-de-test";
process.env.OPS_TOKEN ||= "jeton-relais-de-test";
process.env.BACKUP_KEY ||= "pepper-de-test-32-octets-minimum-ici";

const entry = readFileSync(new URL("../routes/entry.mjs", import.meta.url), "utf8");

test("le miroir exige les identifiants du compte", () => {
  const start = entry.indexOf('router.post("/api/v1/mirror/ops"');
  assert.ok(start > 0, "route de miroir introuvable");
  const block = entry.slice(start, entry.indexOf('router.post("/api/v1/sync-data"', start));

  // Pas d'identifiants, pas de miroir.
  assert.match(block, /account_phone et account_password requis/);
  // Et le mot de passe est VÉRIFIÉ (pas seulement présent).
  assert.match(block, /verifyPassword\(accPassword, account\.password\)/);
  assert.match(block, /status\(401\)/);
  // Les identifiants voyagent dans le CORPS, jamais dans l'URL : une URL est
  // journalisée par les proxies et les serveurs.
  assert.ok(!/req\.query\.account_password/.test(block), "le mot de passe ne doit pas passer par l'URL");
});

test("le miroir est limité en débit (il vérifie un mot de passe)", () => {
  assert.match(entry, /MIRROR_MAX_FAILS/);
  assert.match(entry, /noteMirrorFail\(ip\)/);
  assert.match(entry, /status\(429\)/);
});

test("le miroir ne rend que les opérations de SON compte", () => {
  const start = entry.indexOf('router.post("/api/v1/mirror/ops"');
  const block = entry.slice(start, entry.indexOf('router.post("/api/v1/sync-data"', start));
  // La requête est bornée par le compte RÉSOLU.
  assert.match(block, /WHERE account_id = \$1/);
  assert.match(block, /resolved\.id/);
  // Et le curseur permet de ne demander que ce qui manque.
  assert.match(block, /created_at >= \$2/);
  assert.match(block, /since/);
});

test("le miroir rend des charges utiles LISIBLES par l'instance locale", () => {
  const start = entry.indexOf('router.post("/api/v1/mirror/ops"');
  const block = entry.slice(start, entry.indexOf('router.post("/api/v1/sync-data"', start));
  // Déchiffrées avec la clé DU COMPTE : l'instance locale relaIRA ses données.
  assert.match(block, /decryptArchive\(r\.payload_enc \?\? r\.payload, key\)/);
  // Et l'absence de BACKUP_KEY est un message clair, pas une 500 opaque.
  assert.match(block, /code: "no_key"/);
});
