// Le drainer archive-t-il les boutiques dont le `shop_id` est DÉRIVÉ localement ?
//
// Réponse précédente : non. `accountIdForShop` ne reconnaissait que `s_<accountId>` et
// renvoyait `null` sinon, sans message. Toute caisse pas encore passée par un handshake
// fournissant `accountId` — donc tout le parc antérieur à cette évolution — n'était
// jamais archivée. Une récupération de boutique était impossible pour elle.
//
// Le rattachement se fait par `shops.device_id → account_id` (clé étrangère, pas une
// devinette), en lisant les device_id des ops DU RELAIS : l'archive locale est encore
// vide au moment du rattachement, la chercher là ne rendrait rien.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.REQUIRE_SECRETS = "true";
process.env.ADMIN_PASSWORD ||= "mdp";
process.env.SMS_WEBHOOK_TOKEN ||= "jeton";
process.env.OPS_TOKEN ||= "jeton-relais";
process.env.BACKUP_KEY ||= "pepper-de-test-32-octets-minimum-ici";

const src = readFileSync(new URL("../drainer.mjs", import.meta.url), "utf8");

test("le rattachement d'un groupe dérivé passe par shops.device_id", () => {
  assert.match(
    src,
    /FROM shops[\s\S]{0,80}device_id = ANY\(\$1::text\[\]\)/,
    "device_id est la seule clé fiable pour un shop_id dérivé localement : c'est une "
      + "clé étrangère, pas une correspondance devinée",
  );
  assert.match(
    src,
    /account_id IS NOT NULL/,
    "une fiche sans compte ne peut rien rattacher",
  );
});

test("les device_id sont lus sur le RELAIS, pas sur l'archive locale", () => {
  // Le bug d'origine : chercher les device_id dans `sync_ops` alors qu'on est en train
  // de peupler cette table — donc forcément vide, donc zéro boutique archivée.
  assert.ok(
    !/JOIN shops s ON s\.device_id = o\.device_id/.test(src),
    "la jointure sur sync_ops est circulaire : au moment du rattachement l'archive est vide",
  );
  assert.match(
    src,
    /OPS_RELAY_URL\}\/api\/v1\/ops\?shop_id=/,
    "les device_id doivent venir du relais, où les ops attendent réellement",
  );
});

test("le drainer n'interroge plus shops.id (bigint) avec un shop_id texte", () => {
  assert.ok(
    !/SELECT account_id FROM shops WHERE id = \$1/.test(src),
    "shops.id est un bigint : lui passer un shop_id texte lève une erreur SQL et "
      + "l'archive ne se remplissait d'aucune boutique",
  );
});

test("une ambiguïté entre deux comptes REFUSE l'archivage", () => {
  // Deux commerces peuvent dériver le même hash : le relais a alors groupé leurs ops
  // ensemble. Attribuer le tout à un seul compte serait une fuite entre boutiques.
  assert.match(
    src,
    /if \(owners\.length === 1\) return Number\(owners\[0\]\.account_id\);/,
    "un seul compte correspondant doit suffire ; deux ou plus = ambiguïté",
  );
  assert.match(
    src,
    /if \(owners\.length === 1\)[\s\S]{0,120}return null;/,
    "en cas d'ambiguïté on retourne null : on n'attribue rien",
  );
});

test("un shop_id portant un accountId se résout sans toucher à shops", () => {
  // C'est le cas normal en production, et il doit survivre à la suppression d'une
  // fiche `shops` : le groupe porte son compte dans son propre identifiant.
  assert.match(
    src,
    /accounts WHERE id::text = \$1/,
    "s_<accountId> se résout par l'accounts, sans lecture de shops",
  );
});

test("une boutique non rattachée est signalée dans les logs", () => {
  assert.match(
    src,
    /NON ARCHIV/,
    "un saut silencieux est exactement ce qui a caché le bug bigint",
  );
});

test("le compteur de progression est réellement un nombre", () => {
  // `archive` est async : sans `await`, `stored += <Promise>` affichait
  // « 0[object Promise] » et le compteur mentait.
  assert.match(
    src,
    /stored \+= await archive\(/,
    "sans await le compteur concatène une promesse à un nombre",
  );
});