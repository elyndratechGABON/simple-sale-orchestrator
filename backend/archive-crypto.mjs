// ── Archive chiffrée des opérations (récupération de boutique) ──────────────────────
//
// L'archive `sync_ops` porte l'historique complet des ventes, produits et stocks. C'est
// la seule copie qui survit à la perte d'un téléphone : le relais, lui, est une boîte aux
// lettres purgeable (cf. relay/handler.mjs). Elle est donc chiffrée AU REPOS.
//
// Chiffrement au repos, PAS en transit (choix assumé) : le relais et le drainer
// travaillent sur du clair. Ce n'est pas un oubli — le relais est aveugle et ne doit
// rien lire, mais il faut qu'il TRANSPORTE les ops pour qu'elles se rencontrent ; chiffrer
// avant le push le rendrait incapable de les copier vers l'archive. La surface
// exposée est donc « qui lit la base orchestrateur », pas « qui lit le relais ».
//
// Clé : HKDF-SHA256(secret serveur BACKUP_KEY, sel = account_id) → 32 octets.
//   - Par boutique : une fuite ne déchiffre qu'UN compte, pas tous.
//   - Avec pepper : un commit de la base seul ne suffit PAS — il faut aussi BACKUP_KEY,
//     qui ne vit que dans l'environnement de déploiement.
//   → Dériver la clé du seul account_id ne protégerait de rien : la colonne account_id
//     est dans la base, l'attaquant la relit et recalcule la clé.
//
// Format : "ENC1:" + base64(nonce 12o ‖ tag 16o ‖ ciphertext)  — AES-256-GCM.
// Le préfixe sert de VERSION ET de détection : une ligne sans "ENC1:" est un payload
// en clair archivé avant ce chiffrement, et doit rester lisible (voir decryptArchive).

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const PREFIX = "ENC1:";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Version en dur, donc jamais nulle : elle est écrite et relue par le MÊME code. */
const HKDF_VERSION = "archive-v1";

/**
 * Clé de chiffrement d'un compte. `secret` = BACKUP_KEY côté serveur.
 * On ne dérive jamais vers null : sans secret, le chiffrement ne protège rien et il
 * vaut mieux le dire que faire semblant (même principe que REQUIRE_SECRETS).
 */
export function archiveKeyFor(secret, accountId) {
  if (!secret) throw new Error("BACKUP_KEY absent : archive non chiffrable");
  if (accountId === undefined || accountId === null) {
    throw new Error("account_id absent : impossible de dériver une clé d'archive");
  }
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(String(accountId), "utf8"), Buffer.from(secret, "utf8"), Buffer.from(HKDF_VERSION, "utf8"), 32),
  );
}

export function isEncryptedPayload(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

/** Chiffre un payload JSON. `key` = archiveKeyFor(BACKUP_KEY, account_id). */
export function encryptArchive(payload, key) {
  // Nonce aléatoire par écriture : deux payloads identiques ne doivent pas produire
  // le même ciphertext, sinon l'observateur voit quelles boutiques vendent les mêmes
  // articles le même jour.
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGO, key, nonce);
  const plain = Buffer.from(JSON.stringify(payload ?? null), "utf8");
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return PREFIX + Buffer.concat([nonce, cipher.getAuthTag(), enc]).toString("base64");
}

/**
 * Déchiffre et rend TOUJOURS un objet (pas une chaîne) : la colonne `payload` en clair
 * contient du JSON sérialisé, donc un retour brut donnerait une chaîne à la route
 * alors que le chemin chiffré rend un objet — deux types pour la même donnée selon
 * l'âge de la ligne. Une chaîne illisible est renvoyée telle quelle plutôt que de faire
 * échouer une page entière.
 *
 * Un tag GCM falsifié, lui, est une corruption ou une attaque → on lève.
 */
export function decryptArchive(value, key) {
  if (!isEncryptedPayload(value)) {
    if (typeof value !== "string") return value ?? null;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  const raw = Buffer.from(value.slice(PREFIX.length), "base64");
  if (raw.length <= NONCE_BYTES + TAG_BYTES) {
    throw new Error("payload chiffré tronqué");
  }
  const nonce = raw.subarray(0, NONCE_BYTES);
  const tag = raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const body = raw.subarray(NONCE_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(body), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

/**
 * Empreinte d'un secret, pour comparer sans le stocker ni le journaliser.
 * `account_id` n'est PAS un secret — mais il ne doit pas non plus apparaître en clair
 * dans un log de diagnostic ; ce HMAC permet de corréler deux lignes sans le révéler.
 */
export function accountTag(accountId, secret) {
  return createHmac("sha256", secret).update(`acct:${accountId}`).digest("hex").slice(0, 12);
}