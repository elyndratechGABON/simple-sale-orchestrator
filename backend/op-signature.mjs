// ── Signature des opérations : le cloud vérifie ce que l'instance locale renvoie ──
//
// L'instance locale peut remonter des opérations au cloud (pour lui rendre ce que
// la rétention a purgé). Sans vérification, cette route serait une FABRICATION
// d'historique : quiconque connaissant le mot de passe du compte pourrait injecter
// des ventes imaginaires dans l'archive, et la caisse les rejouerait.
//
// Le cloud vérifie donc chaque op comme le fait la caisse : signature ECDSA P-256
// sur le corps CANONIQUE de l'opération.
//
// ⚠️ Le corps canonique doit être IDENTIQUE à celui de la caisse
// (`src/lib/syncengine/identity/crypto.ts` côté client). Les deux implémentations
// sont épinglées par le MÊME vecteur de test — voir `tests/op-signature.test.mjs`
// côté serveur et `src/lib/syncengine/identity/crypto.test.ts` côté client. Si l'un
// bouge, l'autre casse : c'est voulu.

import { webcrypto } from "node:crypto";

/**
 * JSON CANONIQUE : les clés d'un objet sont triées, récursivement.
 *
 * Pourquoi : la signature ne doit dépendre que du CONTENU de l'op, jamais de l'ordre
 * des clés. Or le relais stocke le payload en JSONB — PostgreSQL réordonne les clés
 * (par longueur, puis alphabétique) en le stockant. La signature calculée à
 * l'émission ne se vérifiait donc plus à la réception : TOUTE op distante était
 * rejetée en silence.
 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const src = value;
    return Object.fromEntries(
      Object.keys(src)
        .sort()
        .map((k) => [k, canonical(src[k])]),
    );
  }
  return value;
}

/**
 * Corps exact couvert par la signature d'une opération. Les champs qui décrivent
 * l'AUTORITÉ de l'op (`device_id`, `shop_id`, `seq`, `id`, `created_at`, `type`,
 * `entity_id`) et le `payload` — mais ni `sig` ni `status` (cyclage d'outbox local,
 * réécrit après signature) ni aucun champ d'horodatage de mise à jour.
 *
 * L'ORDRE des champs du corps est FIXE (celui du littéral) : c'est lui qui est signé,
 * pas une forme « clés triées ». Seule la charge utile est canonisée.
 */
export function signableOpBody(op) {
  return JSON.stringify({
    id: op.id,
    shop_id: op.shop_id,
    device_id: op.device_id,
    seq: op.seq,
    type: op.type,
    entity_id: op.entity_id,
    payload: op.payload === undefined || op.payload === null ? null : canonical(op.payload),
    created_at: op.created_at,
  });
}

/** Vérifie une signature ECDSA P-256 (base64) sur le corps, avec la clé JWK publique. */
export async function verifyOpSignature(op, publicKeyJwk) {
  if (!op?.sig || !publicKeyJwk) return false;
  try {
    const jwk = JSON.parse(publicKeyJwk);
    if (jwk?.kty !== "EC" || jwk?.crv !== "P-256") return false;
    const key = await webcrypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await webcrypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      Buffer.from(op.sig, "base64"),
      new TextEncoder().encode(signableOpBody(op)),
    );
  } catch {
    // Clé illisible ou signature malformée : refus, jamais une exception qui
    // remonterait jusqu'à l'appelant.
    return false;
  }
}

/**
 * La clé PUBLIQUE d'un appareil du canal P2P, pour ce compte.
 *
 * Elle se trouve dans l'ANNONCE de l'appareil : l'op `device.announce` porte à la
 * fois l'identité P2P (`device_id`), la clé (`public_key`) et le lien vers la fiche
 * serveur (`server_device_id`). C'est ce même lien que le drainer utilise pour
 * rattacher un groupe à un compte — donc la même source de vérité.
 *
 * La requête est bornée au compte : une clé d'un autre commerce ne peut donc pas
 * servir à signer une op prétendant appartenir à celui-ci.
 */
export async function deviceKeyFor(db, accountId, p2pDeviceId) {
  if (!p2pDeviceId) return null;
  const rows = await db.all(
    `SELECT CASE WHEN payload ~ '^\\s*[\\{\\[]' THEN payload::jsonb ->> 'public_key' END AS public_key
       FROM sync_ops
      WHERE account_id = $1 AND type = 'device.announce' AND entity_id = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    accountId,
    p2pDeviceId,
  );
  const key = rows[0]?.public_key;
  return key ? { public_key: key } : null;
}
