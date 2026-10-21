// Supprimer une BOUTIQUE (le compte marchand) doit emporter ses ÉCRANS.
//
// Sans cela, un écran survivait à son compte : il n'appartenait à plus rien — son
// compte était effacé — et la console l'affichait quand même comme une boutique, avec
// un compteur de places inventé (« 1/1 »). Un fantôme dans le back-office.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.REQUIRE_SECRETS = "true";
process.env.ADMIN_PASSWORD ||= "mot-de-passe-de-test";
process.env.SMS_WEBHOOK_TOKEN ||= "jeton-webhook-de-test";
process.env.OPS_TOKEN ||= "jeton-relais-de-test";
process.env.BACKUP_KEY ||= "pepper-de-test-32-octets-minimum-ici";

const admin = readFileSync(new URL("../routes/admin.mjs", import.meta.url), "utf8");

test("supprimer un compte supprime aussi ses écrans", () => {
  const start = admin.indexOf("async function removeAccountRows");
  assert.ok(start > 0, "removeAccountRows introuvable");
  const block = admin.slice(start, admin.indexOf("\n}", start));

  // Les écrans du compte sont lus PUIS supprimés, avec leurs données.
  assert.match(block, /SELECT id, device_id FROM shops WHERE account_id = \$1/);
  assert.match(block, /deleteShopRows\(shop, run\)/);
  // Et le compte part ensuite.
  assert.match(block, /DELETE FROM accounts WHERE id = \$1/);
});

test("la suppression d'un écran passe par le même nettoyage", () => {
  // Un seul endroit pour les données d'un écran : la suppression d'un écran et celle
  // d'un compte ne peuvent pas diverger.
  const helper = admin.indexOf("async function deleteShopRows");
  assert.ok(helper > 0, "deleteShopRows introuvable");
  const start = admin.indexOf("export async function deleteShop");
  const block = admin.slice(start, admin.indexOf("\n}", start));
  assert.match(block, /deleteShopRows\(shop, run\)/);
  // Et le compte ne survit pas à son dernier écran.
  assert.match(block, /removeAccountRows\(accountId, client\)/);
});
