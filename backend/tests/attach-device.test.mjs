// Le rattachement ADMIN d'un écran à un commerce : le recours quand un écran n'a pas
// pu rejoindre de lui-même (empreinte déjà prise, code expiré, place manquante).
//
// Ce qui est verrouillé ici :
//  - on ne rattache QUE si le compte a de la place (sinon l'écran serait immédiatement
//    « hors quota », c'est-à-dire suspendu) ;
//  - on ne rattache QUE si l'écran existe (il doit s'être présenté) ;
//  - le rattachement passe par un COMTE, pas par une boutique : c'est le compte qui
//    détient les places.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.REQUIRE_SECRETS = "true";
process.env.ADMIN_PASSWORD ||= "mot-de-passe-de-test";
process.env.SMS_WEBHOOK_TOKEN ||= "jeton-webhook-de-test";
process.env.OPS_TOKEN ||= "jeton-relais-de-test";
process.env.BACKUP_KEY ||= "pepper-de-test-32-octets-minimum-ici";

const cc = readFileSync(new URL("../routes/cc.mjs", import.meta.url), "utf8");

test("le rattachement d'un écran existe et refuse l'attachement sans place", () => {
  const start = cc.indexOf('router.post("/api/v1/admin/accounts/:account_id/attach-device"');
  assert.ok(start > 0, "route de rattachement introuvable");
  const block = cc.slice(start, cc.indexOf('router.post("/api/v1/admin/devices/:device_id/revoke"', start));

  // L'écran doit exister : on ne rattache pas un device_id inventé.
  assert.match(block, /const shop = await byDeviceId\(device_id\)/);
  assert.match(block, /Écran introuvable/);
  // La place est vérifiée AVANT l'écriture.
  assert.match(block, /accountDevices\(account\.id\)/);
  assert.match(block, /used >= account\.max_devices/);
  assert.match(block, /status\(409\)/);
  // L'écriture rattache bien l'ÉCRAN au COMPTE (et pas l'inverse).
  assert.match(block, /UPDATE shops SET account_id = \$1/);
  // Et le compte est miroir : ses écrans partagent son échéance et sa suspension.
  assert.match(block, /syncShopsFromAccount\(account\.id\)/);
  // La décision est tracée.
  assert.match(block, /logAdminAction/);
  assert.match(block, /logActivity/);
});

test("le rattachement est réservé aux administrateurs", () => {
  const start = cc.indexOf('router.post("/api/v1/admin/accounts/:account_id/attach-device"');
  const block = cc.slice(start, start + 400);
  assert.match(block, /requireAdmin/);
  // Et le client du compte doit être dans la portée de la session.
  assert.match(block, /accountOriginOk/);
});
