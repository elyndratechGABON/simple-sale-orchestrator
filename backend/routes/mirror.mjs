// ── MIROIR LOCAL : la copie du commerce chez le commerçant ───────────────────────
//
// L'instance locale (le PC du commerçant) garde une COPIE de ses données. C'est elle
// qui sert la restauration quand le cloud est injoignable, et c'est la seule copie
// qui survit à la rétention du cloud.
//
// Deux sens de circulation :
//   - DESCENDANT : `POST /api/v1/mirror/ops` — l'instance locale TIRE les opérations
//     de SON compte. Le serveur ne pousse jamais (cf. `docs/orchestrateur-flux.md`) :
//     c'est la seule méthode qui marche derrière un routeur.
//   - REMONTANT  : `POST /api/v1/mirror/push` — l'instance locale RENVOIE ce que le
//     cloud a oublié (la rétention purge l'archive au bout de six mois ; la copie
//     locale, elle, garde tout). C'est ce qui rend la restauration possible même
//     pour des données que le cloud ne connaît plus.
//
// L'instance locale s'authentifie avec les MÊMES identifiants de compte que la
// caisse (téléphone + mot de passe). Le miroir ne rend ET ne prend QUE les
// opérations de ce compte.
//
// Les identifiants voyagent dans le CORPS, jamais dans l'URL : une URL est
// journalisée par les proxies et les serveurs.

import { Router } from "express";
import { db, BACKUP_KEY } from "../config.mjs";
import {
  str,
  normPhone,
  accountByPhone,
  resolveAccount,
  verifyPassword,
} from "../lib.mjs";
import { archiveKeyFor, decryptArchive, encryptArchive } from "../archive-crypto.mjs";
import { deviceKeyFor, verifyOpSignature, signableOpBody } from "../op-signature.mjs";

const router = Router();

/** Une page : assez pour aller vite, assez peu pour rester sous la limite de
 *  65 535 paramètres de Postgres (500 × 12 colonnes = 6 000). */
const PAGE_SIZE = 500;

/** Bornes de la route : le miroir est borné pour ne pas saturer la fonction
 *  serverless (dont la mémoire ET le temps sont facturés). */
const MAX_LIMIT = 5000;
const DEFAULT_LIMIT = 1000;
const MAX_PUSH_OPS = 2000;

// ── Limitation de débit ───────────────────────────────────────────────────────────
//
// Le miroir vérifie un MOT DE PASSE. Sans verrou, cette route est une oracle
// d'énumération : le téléphone est devinable (numéro), le mot de passe beaucoup
// moins — mais une boucle de tests finit toujours par trouver le bon.
//
// Le mécanisme est celui du dashboard (`routes/auth.mjs`) : on verrouille l'IP après
// N échecs, et l'IP reste verrouillée un moment. Un client légitime qui réussit
// voit son compteur remis à zéro.
const MIRROR_MAX_FAILS = Number(process.env.MIRROR_MAX_FAILS ?? 8);
const MIRROR_LOCK_MS = Number(process.env.MIRROR_LOCK_MS ?? 15 * 60_000);
const mirrorFails = new Map(); // ip → { count, until }

function mirrorLocked(ip) {
  const e = mirrorFails.get(ip);
  if (!e) return 0;
  if (e.until && e.until > Date.now()) return e.until - Date.now();
  if (e.until && e.until <= Date.now()) mirrorFails.delete(ip);
  return 0;
}
function noteMirrorFail(ip) {
  const e = mirrorFails.get(ip) ?? { count: 0, until: 0 };
  e.count += 1;
  if (e.count >= MIRROR_MAX_FAILS) e.until = Date.now() + MIRROR_LOCK_MS;
  mirrorFails.set(ip, e);
}
function clearMirrorFail(ip) {
  mirrorFails.delete(ip);
}
// Purge périodique : la Map ne doit pas grossir avec des IP éphémères (proxies, mobile).
const mirrorSweep = setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of mirrorFails) if (e.until && e.until <= now) mirrorFails.delete(ip);
}, 60_000);
mirrorSweep.unref?.();

/** Le compte présenté, ou `null` si les identifiants ne sont pas les siens. */
async function compteAuthentifie(body) {
  const phone = normPhone(str(body.account_phone));
  const password = str(body.account_password);
  if (!phone || !password) return { erreur: 400, corps: { error: "account_phone et account_password requis." } };
  const account = await accountByPhone(phone);
  if (!account || !verifyPassword(password, account.password)) return { erreur: 401, corps: { error: "Identifiants du compte incorrects." } };
  const resolved = await resolveAccount(account);
  if (!resolved) return { erreur: 404, corps: { error: "Compte introuvable." } };
  return { compte: resolved };
}

// ── DESCENDANT : le cloud sert la copie locale ────────────────────────────────────
router.post("/api/v1/mirror/ops", async (req, res) => {
  const body = req.body ?? {};
  const ip = req.socket.remoteAddress ?? "inconnu";
  const remaining = mirrorLocked(ip);
  if (remaining > 0) {
    return res
      .status(429)
      .json({ error: `Trop de tentatives. Réessayez dans ${Math.ceil(remaining / 60_000)} min.` });
  }

  const auth = await compteAuthentifie(body);
  if (auth.erreur) {
    if (auth.erreur === 401) noteMirrorFail(ip);
    return res.status(auth.erreur).json(auth.corps);
  }
  clearMirrorFail(ip);
  const compte = auth.compte;

  // Sans BACKUP_KEY, l'archive ne peut pas être déchiffrée : le dire, plutôt que
  // renvoyer une 500 opaque. (Le cas est réel : le secret est optionnel au démarrage.)
  let key;
  try {
    key = archiveKeyFor(BACKUP_KEY, compte.id);
  } catch (err) {
    return res.status(503).json({
      error: `Chiffrement indisponible côté serveur : ${err.message}`,
      code: "no_key",
    });
  }

  const since = Number(body.since) || 0;
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(body.limit) || DEFAULT_LIMIT));
  const rows = await db.all(
    `SELECT id, shop_id, device_id, seq, type, entity_id, payload, payload_enc, created_at, sig
       FROM sync_ops
      WHERE account_id = $1 AND created_at >= $2
      ORDER BY created_at, id
      LIMIT $3`,
    compte.id,
    since,
    limit,
  );

  const ops = [];
  let degraded = 0;
  for (const r of rows) {
    let payload = null;
    try {
      payload = decryptArchive(r.payload_enc ?? r.payload, key);
    } catch {
      // Une ligne corrompue ne doit pas faire tomber TOUTE la page : on la saute.
      degraded++;
      continue;
    }
    ops.push({
      id: r.id,
      shop_id: r.shop_id,
      device_id: r.device_id,
      seq: Number(r.seq),
      type: r.type,
      entity_id: r.entity_id,
      payload,
      created_at: Number(r.created_at),
      ...(r.sig ? { sig: r.sig } : {}),
    });
  }

  // La borne basse de l'archive : ce que le cloud a ENCORE. L'instance locale
  // s'en sert pour savoir ce qu'elle doit lui renvoyer (tout ce qui est plus ancien
  // a été purgé).
  const plusAncien = await db.get(
    "SELECT MIN(created_at) AS t FROM sync_ops WHERE account_id = $1",
    compte.id,
  );

  const dernier = rows.length > 0 ? Number(rows[rows.length - 1].created_at) : since;
  res.json({
    ok: true,
    account_id: compte.id,
    account_name: compte.name,
    ops,
    // Curseur du prochain miroir : l'instance le garde, et ne demandera que ce qui
    // manque la fois suivante.
    since: dernier,
    has_more: rows.length >= limit,
    // Borne basse de l'archive du cloud. En dessous, le cloud a oublié — c'est
    // exactement ce que l'instance locale doit lui renvoyer.
    oldest_created_at: plusAncien?.t === null || plusAncien?.t === undefined ? null : Number(plusAncien.t),
    ...(degraded ? { skipped: degraded } : {}),
  });
});

// ── REMONTANT : l'instance locale rend au cloud ce qu'il a oublié ─────────────────
router.post("/api/v1/mirror/push", async (req, res) => {
  const body = req.body ?? {};
  const ip = req.socket.remoteAddress ?? "inconnu";
  const remaining = mirrorLocked(ip);
  if (remaining > 0) {
    return res
      .status(429)
      .json({ error: `Trop de tentatives. Réessayez dans ${Math.ceil(remaining / 60_000)} min.` });
  }

  const auth = await compteAuthentifie(body);
  if (auth.erreur) {
    if (auth.erreur === 401) noteMirrorFail(ip);
    return res.status(auth.erreur).json(auth.corps);
  }
  clearMirrorFail(ip);
  const compte = auth.compte;

  const ops = Array.isArray(body.ops) ? body.ops : [];
  if (ops.length === 0) {
    return res.status(400).json({ error: "ops requis." });
  }
  if (ops.length > MAX_PUSH_OPS) {
    return res.status(413).json({ error: `Trop d'opérations (max ${MAX_PUSH_OPS}).` });
  }

  let key;
  try {
    key = archiveKeyFor(BACKUP_KEY, compte.id);
  } catch (err) {
    return res.status(503).json({
      error: `Chiffrement indisponible côté serveur : ${err.message}`,
      code: "no_key",
    });
  }

  let acceptes = 0;
  let refuses = 0;
  let doublons = 0;

  for (const op of ops) {
    const opId = str(op?.id);
    const deviceId = str(op?.device_id);
    const type = str(op?.type);
    if (!opId || !deviceId || !type) {
      refuses++;
      continue;
    }

    // L'op doit être SIGNÉE par un appareil de CE compte. C'est ce qui distingue
    // « l'instance locale du commerçant rend ses données » de « quelqu'un fabrique
    // un historique de ventes » : une signature que le serveur sait vérifier, avec
    // une clé qu'il a déjà vue pour ce compte.
    const cle = await deviceKeyFor(db, compte.id, deviceId);
    if (!cle) {
      refuses++;
      continue;
    }
    const opComplete = {
      id: opId,
      shop_id: str(op?.shop_id),
      device_id: deviceId,
      seq: Number(op?.seq) || 0,
      type,
      entity_id: str(op?.entity_id),
      payload: op?.payload ?? null,
      created_at: Number(op?.created_at) || Date.now(),
      sig: str(op?.sig),
    };
    if (!(await verifyOpSignature(opComplete, cle.public_key))) {
      refuses++;
      continue;
    }

    // Idempotence par `id` : renvoyer la même op deux fois ne duplique rien.
    const dejaLa = await db.get("SELECT id FROM sync_ops WHERE id = $1", opId);
    if (dejaLa) {
      doublons++;
      continue;
    }

    const now = Date.now();
    await db.run(
      `INSERT INTO sync_ops
         (id, shop_id, device_id, seq, type, entity_id, payload, payload_enc, created_at, drained_at, sig, account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO NOTHING`,
      opId,
      opComplete.shop_id,
      deviceId,
      opComplete.seq,
      type,
      opComplete.entity_id,
      JSON.stringify(opComplete.payload ?? null),
      // Chiffré au repos, comme le drainer. `payload` reste en clair : c'est le filet
      // de sécurité qui permet de rejouer une boutique dont BACKUP_KEY a été perdu.
      encryptArchive(opComplete.payload ?? null, key),
      opComplete.created_at,
      now,
      opComplete.sig || null,
      compte.id,
    );
    acceptes++;
  }

  res.json({
    ok: true,
    acceptes,
    refuses,
    doublons,
  });
});

export default router;
