// Le MIROIR LOCAL : la copie du commerce chez le commerçant.
//
// Deux sens de circulation, et les DEUX sont sensibles :
//   - descendant (`/api/v1/mirror/ops`) : le cloud rend les opérations du compte ;
//   - remontant  (`/api/v1/mirror/push`) : l'instance locale rend au cloud ce que
//     la rétention a purgé.
//
// La remontant est la plus sensible : elle écrit dans l'archive, et l'archive est
// rejouée par la caisse SANS vérification de signature (le serveur engage sa parole).
// Une remontée non vérifiée serait donc une injection d'historique.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.REQUIRE_SECRETS = "true";
process.env.ADMIN_PASSWORD ||= "mot-de-passe-de-test";
process.env.SMS_WEBHOOK_TOKEN ||= "jeton-webhook-de-test";
process.env.OPS_TOKEN ||= "jeton-relais-de-test";
process.env.BACKUP_KEY ||= "pepper-de-test-32-octets-minimum-ici";

const mirror = readFileSync(new URL("../routes/mirror.mjs", import.meta.url), "utf8");

const routeOps = mirror.slice(
  mirror.indexOf('router.post("/api/v1/mirror/ops"'),
  mirror.indexOf('router.post("/api/v1/mirror/push"'),
);
const routePush = mirror.slice(mirror.indexOf('router.post("/api/v1/mirror/push"'));

test("le miroir descendant exige les identifiants du compte", () => {
  // Le message est produit par la fonction d'authentification partagée.
  assert.match(mirror, /account_phone et account_password requis/);
  // Et le mot de passe est VÉRIFIÉ (pas seulement présent).
  assert.match(mirror, /verifyPassword\(password, account\.password\)/);
  // Un compte inconnu ou un mot de passe faux : 401.
  assert.match(mirror, /erreur: 401/);
  assert.match(routeOps, /status\(auth\.erreur\)/);
  // Les identifiants voyagent dans le CORPS, jamais dans l'URL : une URL est
  // journalisée par les proxies et les serveurs.
  assert.ok(!/req\.query\.account_password/.test(mirror), "le mot de passe ne doit pas passer par l'URL");
});

test("le miroir est limité en débit (il vérifie un mot de passe)", () => {
  assert.match(mirror, /MIRROR_MAX_FAILS/);
  assert.match(mirror, /noteMirrorFail\(ip\)/);
  assert.match(mirror, /status\(429\)/);
});

test("le miroir descendant ne rend que les opérations de SON compte", () => {
  // La requête est bornée par le compte RÉSOLU.
  assert.match(routeOps, /WHERE account_id = \$1/);
  assert.match(routeOps, /compte\.id/);
  // Et le curseur permet de ne demander que ce qui manque.
  assert.match(routeOps, /created_at >= \$2/);
  assert.match(routeOps, /since/);
  // La borne basse de l'archive est annoncée : c'est elle qui dit à l'instance
  // locale ce que le cloud a oublié.
  assert.match(routeOps, /oldest_created_at/);
});

test("le miroir descendant rend des charges utiles LISIBLES par l'instance locale", () => {
  // Déchiffrées avec la clé DU COMPTE : l'instance locale relaIRA ses données.
  assert.match(routeOps, /decryptArchive\(r\.payload_enc \?\? r\.payload, key\)/);
  // Et l'absence de BACKUP_KEY est un message clair, pas une 500 opaque.
  assert.match(routeOps, /code: "no_key"/);
});

test("la remontant VÉRIFIE la signature de chaque op", () => {
  // Sans ça, la route écrit directement dans l'archive rejouée sans vérification.
  assert.match(routePush, /verifyOpSignature\(opComplete, cle\.public_key\)/);
  // La clé doit venir d'un appareil DU COMPTE.
  assert.match(routePush, /deviceKeyFor\(db, compte\.id, deviceId\)/);
  // Une op refusée n'est pas écrite.
  assert.match(routePush, /refuses\+\+;\s*continue;/);
});

test("la remontant est idempotente (une op déjà archivée n'est pas dupliquée)", () => {
  assert.match(routePush, /SELECT id FROM sync_ops WHERE id = \$1/);
  assert.match(routePush, /ON CONFLICT \(id\) DO NOTHING/);
});

test("la remontant écrit dans l'archive CHIFFRÉE, comme le drainer", () => {
  assert.match(routePush, /encryptArchive\(opComplete\.payload \?\? null, key\)/);
  assert.match(routePush, /account_id/);
});

test("la remontant est bornée (une grosse rafale ne sature pas la fonction)", () => {
  assert.match(routePush, /MAX_PUSH_OPS/);
  assert.match(routePush, /status\(413\)/);
});
