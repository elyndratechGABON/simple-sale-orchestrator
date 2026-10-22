// Le corps canonique d'une opération est ce que la CAISSE signe et ce que le CLOUD
// vérifie. Les deux implémentations vivent dans deux dépôts : si l'une bouge sans
// l'autre, TOUTE opération distante est rejetée en silence (c'est exactement le bug
// qu'a causé la signature canonique, commit 3e2f1b5c côté client).
//
// Ce vecteur est donc ÉPINGLÉ des deux côtés : ici, et dans
// `src/lib/syncengine/identity/crypto.test.ts` côté client. Un changement d'un
// côté doit casser le test de l'autre.
import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

process.env.REQUIRE_SECRETS = "true";
process.env.ADMIN_PASSWORD ||= "mot-de-passe-de-test";
process.env.SMS_WEBHOOK_TOKEN ||= "jeton-webhook-de-test";
process.env.OPS_TOKEN ||= "jeton-relais-de-test";
process.env.BACKUP_KEY ||= "pepper-de-test-32-octets-minimum-ici";

const { signableOpBody, verifyOpSignature } = await import("../op-signature.mjs");

/** L'op d'exemple : charge utile volontairementdésordonnée (les clés ne sont pas
 *  triées), pour que la canonicalisation soit observable. */
const OP = {
  id: "op-1",
  shop_id: "s_42",
  device_id: "dev-1",
  seq: 7,
  type: "sale.created",
  entity_id: "v-1",
  payload: { total: 100, items: [{ qte: 2, sku: "A" }], client: { nom: "Ada" } },
  created_at: 1700000000000,
};

// ── LE VECTEUR ÉPINGLÉ ───────────────────────────────────────────────────────────
//
// Ce corps exact est celui que la caisse signe. Ne pas le modifier sans modifier
// `src/lib/syncengine/identity/crypto.test.ts` côté client (et inversement).
const CORPS_EPINGLE =
  '{"id":"op-1","shop_id":"s_42","device_id":"dev-1","seq":7,"type":"sale.created",' +
  '"entity_id":"v-1","payload":{"client":{"nom":"Ada"},"items":[{"qte":2,"sku":"A"}],"total":100},' +
  '"created_at":1700000000000}';

test("le corps canonique est ÉPINGLÉ (le client signe exactement cela)", () => {
  assert.equal(signableOpBody(OP), CORPS_EPINGLE);
});

test("l'ordre des clés de la charge utile n'a pas d'importance", () => {
  const desordre = { ...OP, payload: { client: { nom: "Ada" }, items: [{ sku: "A", qte: 2 }], total: 100 } };
  assert.equal(signableOpBody(desordre), CORPS_EPINGLE);
});

test("une signature valide se vérifie", async () => {
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const jwk = JSON.stringify(await webcrypto.subtle.exportKey("jwk", pair.publicKey));
  const sig = Buffer.from(
    await webcrypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      new TextEncoder().encode(signableOpBody(OP)),
    ),
  ).toString("base64");

  assert.equal(await verifyOpSignature({ ...OP, sig }, jwk), true);

  // La même signature sur une op MODIFIEE doit être refusée : c'est le point.
  assert.equal(await verifyOpSignature({ ...OP, sig, payload: { total: 999 } }, jwk), false);
  assert.equal(await verifyOpSignature({ ...OP, sig, created_at: 1700000000001 }, jwk), false);
});

test("une signature absente ou une clé illisible sont refusées, jamais une exception", async () => {
  assert.equal(await verifyOpSignature(OP, "{}"), false);
  assert.equal(await verifyOpSignature({ ...OP, sig: "pas-base64" }, "{}"), false);
});
