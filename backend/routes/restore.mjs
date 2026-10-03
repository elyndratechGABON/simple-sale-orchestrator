// ── Restauration d'une boutique depuis l'archive (récupération après perte) ───────
//
// Le relais est une boîte aux lettres PURGEABLE : passé le délai de fraîcheur, ce qui
// n'a pas été tiré disparaît. Il ne reste donc aucune copie des ventes ailleurs que
// l'archive `sync_ops` de l'orchestrateur. Cette route est la SEULE porte de sortie de
// cette archive — d'où le soin apporté à son autorisation.
//
// Le client ne fournit PAS ses identifiants ici : il fournit le `job_id` opaque qu'il a
// reçu du handshake. La session dashboard (`sessionOf`) autorise l'admin, pas la caisse.
// La caisse, elle, s'authentifie au handshake et obtient `account_id` → `shopId`.
//
// Autorisation d'une lecture, dans l'ordre (toutes obligatoires) :
//   1. le job existe et n'est pas purgé ;
//   2. il est `ready` — donc l'orchestrateur a drainé, l'archive est complète ;
//   3. `device_id` figure parmi les devices du compte (entry.mjs `isMemberDevice`) ;
//   4. `shopId` claimed par la caisse correspond à `restore_jobs.shop_id` ET ce
//      shop_id appartient bien au compte (`shops.account_id` ou préfixe `s_<accountId>`).
//
// Le point 4 est le load-bearing : sans lui, un device_id connu d'un compte A pourrait
// réclamer le shop_id du compte B, puisque le shop_id est ce que le client annonce.

import { Router } from "express";
import { db, BACKUP_KEY } from "../config.mjs";
import { str, byDeviceId, resolveAccount } from "../lib.mjs";
import {
  accountTag,
  archiveKeyFor,
  decryptArchive,
  isEncryptedPayload,
} from "../archive-crypto.mjs";

const router = Router();

/** 500 ops par page : assez pour aller vite, assez peu pour rester sous la limite
 *  de 65 535 paramètres de Postgres (500 × 12 colonnes = 6 000). */
const PAGE_SIZE = 500;

const json = (res, status, body) => res.status(status).json(body);

/** Clé de déchiffrement du compte propriétaire du job. */
function keyFor(job) {
  return archiveKeyFor(BACKUP_KEY, job.account_id);
}

/** Le device_id appartient-il à ce compte ? Même règle que le handshake (entry.mjs). */
async function isMemberDevice(account, deviceId) {
  if (!deviceId) return false;
  const shop = await byDeviceId(deviceId);
  if (!shop) return false;
  const acc = await resolveAccount({ id: Number(shop.account_id) });
  return Boolean(acc && Number(acc.id) === Number(account.id));
}

/**
 * Le shop_id réclamé correspond-il à celui du job, et à ce compte ?
 * `shops.id` n'est pas forcément le shop_id complet : le relais indexe par le
 * `shop_id` dérivé (`s_<accountId>` ou hash), pas par l'identifiant court de la fiche.
 */
async function shopBelongsToAccount(account, job, claimedShopId) {
  if (claimedShopId !== job.shop_id) return false;
  const acc = String(account.id);
  // Chemin nominal : le shop_id porte l'identifiant de compte.
  if (job.shop_id === `s_${acc}`) return true;
  // Repli sur le lien explicite Learn account_id → shops.
  const owned = await db.all(
    `SELECT id FROM shops WHERE account_id = $1`,
    Number(account.id),
  );
  return owned.some((row) => typeof row.id === "string" && job.shop_id.endsWith(row.id));
}

// ── POST /api/v1/restore ────────────────────────────────────────────────────────────
// Ouvre (ou reprend) une restauration. Rejouable : un job `ready` repasse `ready`,
// `created_at` est mis à jour, rien n'est purgé. Le client garde le `job_id` et
// l'interroge en boucle jusqu'à `status: "ready"`.
router.post("/api/v1/restore", async (req, res) => {
  const body = req.body ?? {};
  const deviceId = str(body.device_id);
  const claimedShopId = str(body.shop_id);

  if (!deviceId || !claimedShopId) {
    return json(res, 400, {
      error: "device_id et shop_id sont requis.",
      code: "missing_args",
    });
  }

  const shop = await byDeviceId(deviceId);
  if (!shop || !shop.account_id) {
    return json(res, 403, {
      error: "Écran inconnu du service. Lancez d'abord la connexion de la caisse.",
      code: "unknown_device",
    });
  }
  const account = await resolveAccount({ id: Number(shop.account_id) });
  if (!account) {
    return json(res, 403, { error: "Compte introuvable.", code: "no_account" });
  }
  if (!(await isMemberDevice(account, deviceId))) {
    return json(res, 403, { error: "Cet écran n'appartient pas à ce compte.", code: "not_member" });
  }

  // Le `shop_id` que la caisse annonce peut être celui de SON deviceId ou celui d'un
  // autre device du groupe (partage). On accepte les deux : c'est le même compte.
  const mine = String(account.id);
  const ownShopId = claimedShopId === `s_${mine}`;
  if (!ownShopId) {
    const own = await db.get(`SELECT id, account_id FROM shops WHERE device_id = $1`, deviceId);
    if (!own || !claimedShopId.endsWith(String(own.id))) {
      return json(res, 403, {
        error: "shop_id incohérent avec ce compte.",
        code: "shop_mismatch",
      });
    }
  }

  // nanoid : le job_id est la SEULE chose qui autorise la lecture de l'archive, donc il
  // ne doit pas être devinable. Un id séquentiel donnerait à un concurrent le shop_id du
  // voisin par différence.
  //
  // `gen_random_uuid()` et non `encode(gen_random_uuid(16),'hex')` : le second exige
  // l'extension `pgcrypto`, absente d'un Postgres local alors qu'elle est activée par
  // défaut sur Neon. Le premier est natif depuis Postgres 13 et n'a rien à installer.
  // L'unique et le tire-bouchon aléatoires suffisent : ce n'est pas une clé, c'est un
  // jeton d'accès à usage unique.
  const job = await db.get(
    `INSERT INTO restore_jobs (id, account_id, shop_id, status, created_at)
     VALUES (replace(gen_random_uuid()::text, '-', ''), $1, $2, 'pending', $3)
     RETURNING *`,
    Number(account.id),
    claimedShopId,
    Date.now(),
  );

  // Le nombre d'ops archivées est ce qui distingue « pas encore drainé » de « vide ».
  const counted = await db.get(
    `SELECT COUNT(*) AS n FROM sync_ops WHERE shop_id = $1`,
    claimedShopId,
  );
  const total = Number(counted?.n ?? 0);
  const ready = total > 0;

  await db.run(
    `UPDATE restore_jobs SET status = $1, total_ops = $2, resumed_at = $3 WHERE id = $4`,
    ready ? "ready" : "pending",
    total,
    Date.now(),
    job.id,
  );

  return json(res, 200, {
    job_id: job.id,
    status: ready ? "ready" : "pending",
    total_ops: total,
    // Message pour le cas « pending » : l'orchestrateur doit être lancé. Dire
    // « aucune donnée » à ce stade serait un mensonge — l'archive est peut-être juste
    // pas encore drainée.
    message: ready
      ? "Archive disponible."
      : "Aucune donnée archivée pour l'instant. Lancez l'orchestrateur pour synchroniser, puis relancez cette demande.",
    account_tag: accountTag(account.id, BACKUP_KEY),
  });
});

// ── GET /api/v1/restore/:job_id?cursor=N ─────────────────────────────────────────────
// Rend l'archive page par page, DÉCHIFFRÉE. `cursor` est un offset dans l'ordre
// (created_at, id) — le même ordre que le relais et que le drainer, donc la
// pagination est stable tant qu'aucune op n'est écrite pour ce shop_id pendant la
// lecture (et même si c'est le cas, les lignes existantes ne bougent pas).
router.get("/api/v1/restore/:job_id", async (req, res) => {
  const jobId = str(req.params.job_id);
  const deviceId = str(req.query.device_id);
  const claimedShopId = str(req.query.shop_id);

  if (!jobId || !deviceId || !claimedShopId) {
    return json(res, 400, {
      error: "job_id, device_id et shop_id sont requis.",
      code: "missing_args",
    });
  }

  const job = await db.get(`SELECT * FROM restore_jobs WHERE id = $1`, jobId);
  if (!job) {
    return json(res, 404, { error: "Restauration inconnue.", code: "no_job" });
  }

  const shop = await byDeviceId(deviceId);
  if (!shop || !shop.account_id || Number(shop.account_id) !== Number(job.account_id)) {
    return json(res, 403, {
      error: "Cet écran n'appartient pas à cette restauration.",
      code: "not_member",
    });
  }

  const account = await resolveAccount({ id: Number(job.account_id) });
  if (!account) return json(res, 403, { error: "Compte introuvable.", code: "no_account" });

  if (!(await shopBelongsToAccount(account, job, claimedShopId))) {
    return json(res, 403, {
      error: "shop_id incohérent avec cette restauration.",
      code: "shop_mismatch",
    });
  }

  const cursor = Math.max(0, Number(req.query.cursor) || 0);

  const rows = await db.all(
    `SELECT id, device_id, seq, type, entity_id, payload, payload_enc, created_at, sig
       FROM sync_ops
      WHERE shop_id = $1
      ORDER BY created_at, id
      LIMIT $2 OFFSET $3`,
    job.shop_id,
    PAGE_SIZE,
    cursor,
  );

  let key;
  try {
    key = keyFor(job);
  } catch (err) {
    return json(res, 503, {
      error: `Chiffrement indisponible côté serveur : ${err.message}`,
      code: "no_key",
    });
  }

  const ops = [];
  let degraded = 0;
  for (const r of rows) {
    let payload = null;
    try {
      // `payload_enc` quand présent, sinon le `payload` clair des archives antérieures
      // au chiffrement : decryptArchive renvoie tel quel ce qui n'est pas préfixé ENC1:.
      payload = decryptArchive(r.payload_enc ?? r.payload, key);
    } catch {
      // Une ligne corrompue ou une clé qui ne correspond pas ne doit pas faire tomber
      // TOUTE la page : on la saute et on la compte, l'orchestrateur voit le décalage.
      degraded++;
      continue;
    }
    ops.push({
      id: r.id,
      device_id: r.device_id,
      seq: Number(r.seq),
      type: r.type,
      entity_id: r.entity_id,
      payload,
      created_at: Number(r.created_at),
      ...(r.sig ? { sig: r.sig } : {}),
    });
  }

  const next = cursor + rows.length;
  const total = Number(
    (await db.get(`SELECT COUNT(*) AS n FROM sync_ops WHERE shop_id = $1`, job.shop_id))?.n ?? 0,
  );

  await db.run(`UPDATE restore_jobs SET status = 'ready' WHERE id = $1`, jobId);

  return json(res, 200, {
    status: "ready",
    ops,
    cursor: next,
    has_more: next < total,
    total_ops: total,
    ...(degraded ? { skipped: degraded } : {}),
    encrypted: rows.some((r) => isEncryptedPayload(r.payload_enc)),
  });
});

export default router;