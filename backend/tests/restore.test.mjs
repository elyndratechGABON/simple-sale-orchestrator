// Restauration depuis l'archive — chiffrement, pagination, isolation entre comptes.
//
// Ces tests verrouillent ce qui protège L'HISTORIQUE : que l'archive soit illisible sans
// BACKUP_KEY, qu'un compte ne puisse pas lire celle d'un autre, et qu'une archive
// antérieure au chiffrement reste rejouable (sinon les boutiques déjà en production
// deviennent irrécupérables au jour où on déploie le chiffrement).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.REQUIRE_SECRETS = "true";
process.env.ADMIN_PASSWORD ||= "mdp-de-test";
process.env.SMS_WEBHOOK_TOKEN ||= "jeton-webhook-de-test";
process.env.OPS_TOKEN ||= "jeton-relais-de-test";
process.env.BACKUP_KEY ||= "pepper-de-test-32-octets-minimum-ici";

const crypto = await import("../archive-crypto.mjs");
const config = await import("../config.mjs");

const KEY_A = crypto.archiveKeyFor(config.BACKUP_KEY, 41);
const KEY_B = crypto.archiveKeyFor(config.BACKUP_KEY, 42);

// ── Chiffrement ─────────────────────────────────────────────────────────────────────

test("un payload chiffré ne laisse rien du commerce en clair", () => {
  const secret = { total: 125000, items: [{ sku: "CH-42", qty: 3 }] };
  const blob = crypto.encryptArchive(secret, KEY_A);
  assert.ok(crypto.isEncryptedPayload(blob), "doit porter le préfixe ENC1:");
  assert.ok(!blob.includes("CH-42"), "le SKU ne doit pas être lisible");
  assert.ok(!blob.includes("125000"), "le montant ne doit pas être lisible");
});

test("round-trip : chiffrement puis déchiffrement redonne le payload", () => {
  const secret = { a: 1, b: "accents é ü ✓", c: [null, true, 3] };
  assert.deepEqual(crypto.decryptArchive(crypto.encryptArchive(secret, KEY_A), KEY_A), secret);
});

test("deux chiffrements du même payload diffèrent (nonce aléatoire)", () => {
  const one = crypto.encryptArchive({ meme: true }, KEY_A);
  const two = crypto.encryptArchive({ meme: true }, KEY_A);
  assert.notEqual(one, two, "un nonce fixe rendrait les archives corrélables");
});

test("la clé d'un compte n'ouvre pas l'archive d'un autre", () => {
  const blob = crypto.encryptArchive({ chiffre: "secret" }, KEY_A);
  assert.throws(
    () => crypto.decryptArchive(blob, KEY_B),
    "le tag GCM doit rejeter une clé qui ne correspond pas",
  );
});

test("un tag GCM falsifié est rejeté (intégrité)", () => {
  const blob = crypto.encryptArchive({ montant: 1000 }, KEY_A);
  // Un octet du ciphertext modifié : GCM doit le détecter, pas le déchiffrer en silence.
  const raw = Buffer.from(blob.slice("ENC1:".length), "base64");
  raw[raw.length - 1] ^= 0xff;
  assert.throws(() => crypto.decryptArchive("ENC1:" + raw.toString("base64"), KEY_A));
});

test("un payload en clair (archive antérieure au chiffrement) reste lisible", () => {
  // C'est ce qui sauve les boutiques déjà en production : sans ce cas, déployer le
  // chiffrement les rendrait irrécupérables.
  const ancien = JSON.stringify({ product_id: "p1", name: "Chaise" });
  assert.equal(crypto.isEncryptedPayload(ancien), false);
  assert.deepEqual(crypto.decryptArchive(ancien, KEY_A), { product_id: "p1", name: "Chaise" });
});

test("sans BACKUP_KEY, dériver une clé échoue au lieu de produire du faux secret", () => {
  assert.throws(() => crypto.archiveKeyFor("", 41), /BACKUP_KEY/);
  assert.throws(() => crypto.archiveKeyFor(config.BACKUP_KEY, undefined), /account_id/);
});

test("la même clé n'est jamais dérivée deux fois pour deux comptes", () => {
  assert.notDeepEqual(KEY_A, KEY_B);
  assert.equal(KEY_A.length, 32, "AES-256 exige 32 octets");
});

test("accountTag ne révèle pas l'account_id et reste stable", () => {
  const t1 = crypto.accountTag(41, config.BACKUP_KEY);
  assert.equal(t1, crypto.accountTag(41, config.BACKUP_KEY));
  assert.notEqual(t1, crypto.accountTag(42, config.BACKUP_KEY));
  assert.ok(!t1.includes("41"), "l'identifiant ne doit pas apparaître en clair");
});

// ── Configuration ───────────────────────────────────────────────────────────────────

test("BACKUP_KEY est un secret exigé au démarrage", () => {
  const src = readFileSync(new URL("../config.mjs", import.meta.url), "utf8");
  assert.match(
    src,
    /\["ADMIN_PASSWORD",\s*"SMS_WEBHOOK_TOKEN",\s*"OPS_TOKEN",\s*"BACKUP_KEY"\]/,
    "BACKUP_KEY doit figurer dans la liste des secrets exigés, sinon un déploiement "
      + "oublie le pepper et écrit une archive en clair en croyant l'inverse",
  );
});

test("le drainer chiffre la colonne payload_enc et préserve payload", () => {
  const src = readFileSync(new URL("../drainer.mjs", import.meta.url), "utf8");
  assert.match(src, /encryptArchive\(/, "le drainer doit chiffrer à l'écriture");
  assert.match(
    src,
    /payload_enc/,
    "la colonne chiffrée doit être écrite",
  );
  // `ON CONFLICT (id) DO NOTHING` = la déduplication survit au chiffrement, puisque
  // c'est `id` (non chiffré) qui porte la contrainte.
  assert.match(src, /ON CONFLICT \(id\) DO NOTHING/, "l'idempotence du drainer doit tenir");
});

// ── Autorisation de la route ────────────────────────────────────────────────────────

test("la route restore refuse le shop_id d'un autre compte", () => {
  const src = readFileSync(new URL("../routes/restore.mjs", import.meta.url), "utf8");
  // Le load-bearing : la caisse annonce son shop_id, donc il faut le recouper avec
  // l'account_id du job. Sans cette comparaison, un device_id connu suffit à tout lire.
  assert.match(src, /shopBelongsToAccount/, "shop_id doit être recoupé avec le compte");
  assert.match(
    src,
    /Number\(shop\.account_id\) !== Number\(job\.account_id\)/,
    "le device_id doit correspondre au compte du job",
  );
});

test("la route restore ne rend l'archive que si le job est prêt", () => {
  const src = readFileSync(new URL("../routes/restore.mjs", import.meta.url), "utf8");
  assert.match(
    src,
    /status:\s*"ready"/,
    "POST doit signaler ready quand l'archive existe",
  );
  assert.match(
    src,
    /Lancez l'orchestrateur/,
    "l'absence de données doit dire comment y remédier, pas laisser croire à un vide définitif",
  );
});

test("la pagination suit (created_at, id), le même ordre que le relais", () => {
  const restore = readFileSync(new URL("../routes/restore.mjs", import.meta.url), "utf8");
  assert.match(restore, /ORDER BY created_at, id/);
  const relay = readFileSync(new URL("../../relay/handler.mjs", import.meta.url), "utf8");
  assert.match(relay, /ORDER BY created_at, id/, "l'archive doit suivre l'ordre du relais");
});

test("l'id du job est aléatoire, pas séquentiel", () => {
  const src = readFileSync(new URL("../routes/restore.mjs", import.meta.url), "utf8");
  assert.match(
    src,
    /gen_random_uuid\(\)/,
    // `gen_random_bytes` exigerait l'extension pgcrypto : native sur Neon, ABSENTE d'un
    // Postgres local. La route doit démarrer partout, pas seulement chez l'hébergeur.
    "un id aléatoire portable, sans extension à installer",
    "un id séquentiel permettrait de deviner le shop_id du voisin par différence",
  );
});