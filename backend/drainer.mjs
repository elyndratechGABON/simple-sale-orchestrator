// ─── Drainer du relais ops ──────────────────────────────────────────────────────
// À chaque démarrage (+ périodiquement), l'orchestrateur COPE dans sa SQLite toutes
// les opérations du relais (boîte aux lettres Neon), boutique par boutique, puis
// demande une PURGE. La purge est régie par la fraîcheur des appareils CÔTÉ RELAIS :
// une op n'est libérée que si tous les appareils du magasin encore présents l'ont
// tirée — l'orchestrateur n'a rien à vérifier ici, il ne fait que copier puis réclamer.
//
// Boucle par boutique : GET (toutes les ops) → INSERT local idempotent → POST purge →
// on recommence tant que la purge a bien libéré quelque chose (sinon l'orchestrateur
// attendrait en boucle une place que la fraîcheur ne donne pas encore).
import { db, OPS_RELAY_URL, OPS_TOKEN, BACKUP_KEY } from "./config.mjs";
import { archiveKeyFor, encryptArchive } from "./archive-crypto.mjs";

const REQ_TIMEOUT_MS = 10_000;
const OPS_HEADERS = OPS_TOKEN ? { "x-ops-token": OPS_TOKEN } : {};

export async function drainRelayFromOps() {
  const started = Date.now();
  let shops = [];
  try {
    const res = await fetch(`${OPS_RELAY_URL}/api/v1/ops/shops`, {
      headers: OPS_HEADERS,
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`liste boutique HTTP ${res.status}`);
    shops = ((await res.json())?.shops) ?? [];
  } catch (err) {
    console.error(`[drainer] relais injoignable (${OPS_RELAY_URL}) : ${err.message}`);
    return { ok: false, error: err.message };
  }

  let stored = 0;
  let purged = 0;
  let skipped = 0;
  const perShop = [];
  for (const shop of shops) {
    // On TIRE d'abord, on rattache ensuite. L'ordre importe : le rattachement d'un groupe
    // dérivé localement lit les `device_id` des opérations, et ces opérations vivent dans
    // l'archive LOCALE — vide tant qu'on n'a rien copié. Rattacher avant le pull donnait
    // toujours zéro ligne, donc aucune boutique n'était jamais archivée.
    //
    // `null` = aucun compte ne correspond → on n'archive rien en clair et on saute.
    // Archiver sans compte, c'est écrire une archive qu'aucun client ne peut déchiffrer
    // ni réclamer.
    const accountId = await accountIdForShop(shop.shop_id);
    if (accountId === null) {
      // PAS de `continue` silencieux : un `shop_id` non rattaché est soit un bug de
      // format, soit un compte supprimé. Dans les deux cas l'archive ne se remplit pas et
      // ça doit se voir dans les logs — c'est ce silence qui a caché le bug bigint.
      skipped++;
      console.warn(
        `[drainer] boutique "${shop.shop_id}" NON ARCHIVÉE : aucun compte ne correspond à ` +
          `ce shop_id. Vérifiez que la caisse a bien reçu son accountId (handshake), sinon ` +
          `ses opérations resteront au relais jusqu'à sa purge.`,
      );
      perShop.push({ shop_id: shop.shop_id, stored: 0, purged: 0, skipped: true });
      continue;
    }
    const r = await drainOne(shop.shop_id, accountId);
    stored += r.stored;
    purged += r.purged;
    perShop.push({ shop_id: shop.shop_id, ...r });
  }

  const info = {
    ok: true,
    relay: OPS_RELAY_URL,
    boutiques: shops.length,
    ops_copiees: stored,
    ops_purgees: purged,
    boutiques_ignorees: skipped,
    duree_ms: Date.now() - started,
    details: perShop,
  };
  console.log(`[drainer] ${new Date().toISOString()} — ${info.boutiques} boutique(s), ` +
    `${stored} op(s) copiées vers l'archive, ${purged} purgée(s) (${info.duree_ms} ms)`);
  return info;
}

async function drainOne(shopId, accountId) {
  let stored = 0;
  let purged = 0;
  let empty = false;
  let rounds = 0;
  // Clé d'archive du compte. Levée si BACKUP_KEY manque : on préfère un drainer qui
  // échoue bruyamment à une archive écrite en clair en croyant l'inverse.
  const key = archiveKeyFor(BACKUP_KEY, accountId);
  while (!empty) {
    const ops = await pullShop(shopId);
    if (ops.length === 0) break;
    const ids = ops.map((o) => o.id);
    // `await` obligatoire : `archive` est async. Sans lui, `stored += <Promise>` concatène
// une promesse à un nombre (« 0[object Promise] ») et le compteur de progression ment —
// l'archive se remplissait quand même, mais rien ne le disait.
stored += await archive(shopId, ops, key);
    const r = await purgeIds(ids);
    purged += r.purged ?? 0;
    rounds++;
    empty = (r.purged ?? 0) === 0 && (r.kept ?? ids.length) === ids.length;
  }
  return { stored, purged, rounds };
}

/**
 * Rattache un `shop_id` du relais à un `account_id` local.
 *
 * Le relais ne stocke qu'un `shop_id`. Ce `shop_id` PORTE l'identifiant de compte quand
 * le serveur l'a fourni à la caisse : `deriveShopId` (src/lib/syncengine/identity.ts)
 * produit `s_<accountId>` dès que `profile.accountId` existe. C'est le seul lien fiable.
 *
 * ⚠️ Bug corrigé ici : la version précédente rattachait par `shops.id`, qui est un
 * BIGINT. Passer un `shop_id` texte comme `s_41` y levait
 * `invalid input syntax for type bigint`, et la seconde branche testait
 * `typeof row.id === "string"` — toujours faux sur un bigint. Résultat : AUCUNE
 * boutique n'était jamais archivée, et le drainer ne signalait rien de special.
 *
 * Pourquoi ne pas deviner quand le motif ne correspond pas : un `shop_id` dérivé
 * localement (ancienne formule SHA-256 téléphone|nom) ne contient aucun `accountId`, et
 * rien en base ne permet de le rattacher sans deviner. Deviner attribuerait les ventes
 * d'une boutique au compte d'une AUTRE — exactement ce que l'archive chiffrée doit
 * empêcher. Une boutique non archivée est un oubli ; une boutique mal rattachée est une
 * fuite entre comptes. On ne devine pas.
 *
 * @returns l'account_id, ou `null` pour « ne pas archiver ».
 */
async function accountIdForShop(shopId) {
  const derived = /^s_([A-Za-z0-9_-]{1,24})$/.exec(shopId);

  // 1. `s_<accountId>` : le groupe PORTE l'identifiant de compte. C'est le cas depuis que
  //    le handshake fournit `accountId`, donc le cas normal en production.
  if (derived) {
    const asAccount = await db.get(`SELECT id FROM accounts WHERE id::text = $1`, derived[1]);
    // Un `s_<hash>` passe aussi ce motif : on n'accepte que si l'identifiant EXISTE,
    // sinon on tombe dans le chemin device_id.
    if (asAccount) return Number(asAccount.id);
  }

  // 2. Groupe derive localement (`SHA-256(telephone|nom)` ou mot cle) : le `shop_id` ne
  //    dit rien du compte. Mais les ops portent `device_id`, et le serveur connait le lien
  //    `shops.device_id -> account_id` (colonne UNIQUE). Ce n'est pas une devinette, c'est
  //    une cle etrangere : la seule voie pour archiver le parc anterieur a `accountId`.
  //
  //    On interroge le RELAIS, pas `sync_ops` : au moment de ce rattachement l'archive
  //    locale est encore vide, et la chercher ici ne retournerait rien — c'etait
  //    exactement ce qui faisait echouer toutes les boutiques.
  const headers = OPS_TOKEN ? { "x-ops-token": OPS_TOKEN } : {};
  let remoteOps = [];
  try {
    const res = await fetch(`${OPS_RELAY_URL}/api/v1/ops?shop_id=${encodeURIComponent(shopId)}`, {
      headers,
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    if (res.ok) remoteOps = ((await res.json())?.ops) ?? [];
  } catch {
    // Relais injoignable : le vrai pull produira un message d'erreur plus utile que celui-ci.
    return null;
  }

  const deviceIds = [...new Set(remoteOps.map((o) => String(o?.device_id ?? "")).filter(Boolean))];
  if (deviceIds.length === 0) return null;

  const owners = await db.all(
    `SELECT DISTINCT account_id FROM shops
      WHERE device_id = ANY($1::text[]) AND account_id IS NOT NULL`,
    deviceIds,
  );
  // Plusieurs comptes dans le meme `shop_id` : on refuse. Le relais groupant par
  // `shop_id`, deux commerces peuvent deriver le MEME hash ; attribuer la totalite de
  // leurs ventes a l'un serait une fuite entre boutiques.
if (owners.length === 1) return Number(owners[0].account_id);
  return null;
}

async function pullShop(shopId) {
  try {
    const res = await fetch(`${OPS_RELAY_URL}/api/v1/ops?shop_id=${encodeURIComponent(shopId)}`, {
      headers: OPS_HEADERS,
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const data = (await res.json().catch(() => null)) ?? null;
    return Array.isArray(data?.ops) ? data.ops : [];
  } catch (err) {
    console.error(`[drainer] pull ${shopId} : ${err.message}`);
    return [];
  }
}

/** Copie idempotente dans l'archive locale. Renvoie le nombre de lignes NOUVELLES. */
async function archive(shopId, ops, key) {
  const now = Date.now();
  let inserted = 0;
  await db.tx(async (client) => {
    for (const op of ops) {
      const r = await client.query(
        `INSERT INTO sync_ops (id, shop_id, device_id, seq, type, entity_id, payload, payload_enc, created_at, drained_at, sig)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO NOTHING`,
        [
          String(op.id ?? ""),
          shopId,
          String(op.device_id ?? ""),
          Number(op.seq ?? 0) || 0,
          String(op.type ?? ""),
          String(op.entity_id ?? ""),
          JSON.stringify(op.payload ?? null),
          // Chiffré au repos. `payload` reste écrit en clair : c'est le filet de sécurité
          // qui permet de rejouer une boutique dont BACKUP_KEY a été perdu.
          encryptArchive(op.payload ?? null, key),
          Number(op.created_at ?? now) || now,
          now,
          // La signature voyage avec l'op : l'archive doit permettre de REJOUER le
          // journal (ou de l'auditer) sans repasser par un appareil. La colonne `sig`
          // est nullable pour que l'archive accepte aussi les ops d'avant signature.
          typeof op.sig === "string" ? op.sig : null,
        ],
      );
      inserted += r.rowCount ?? 0;
    }
  });
  return inserted;
}

async function purgeIds(ids) {
  if (ids.length === 0) return { purged: 0, kept: 0 };
  try {
    const res = await fetch(`${OPS_RELAY_URL}/api/v1/ops/purge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OPS_HEADERS },
      body: JSON.stringify({ ids }),
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`purge HTTP ${res.status}`);
    return (await res.json()) ?? { purged: 0, kept: ids.length };
  } catch (err) {
    console.error(`[drainer] purge : ${err.message}`);
    return { purged: 0, kept: ids.length };
  }
}
