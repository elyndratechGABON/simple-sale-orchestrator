// Routes admin legacy (dashboard) — commandes, boutiques, comptes, demandes,
// paiements SMS, projets, reset et routes rétrocompat de l'ancien server.mjs.
import { Router } from "express";
import { randomUUID } from "node:crypto";
import {
  db,
  PRICE_TIERS,
  PRICE_PER_MONTH_FCFA,
  COMMAND_TTL_MS,
  DAY_MS,
  ONLINE_WINDOW_MS,
  manifests,
  projectById,
} from "../config.mjs";
import {
  str,
  byId,
  byDeviceId,
  listShops,
  accountById,
  accountDevices,
  computeAccountStatus,
  publicAccount,
  deviceOverLimit,
  syncShopsFromAccount,
  accountOriginOk,
  priceForDevices,
  computeStatus,
  publicShop,
  applyTierRenewal,
  tierForAmount,
  computeSubscriptions,
  aggregateStats,
  attachAccountForLegacy,
  upsertShop,
} from "../lib.mjs";
import {
  sessionOf,
  requireAdmin,
  requireMaster,
} from "./auth.mjs";
import { logAdminAction, logActivity } from "./audit.mjs";

const router = Router();

// ── Protocole v3 : commandes admin (boîte aux lettres) ────────────────────────────
// Les ordres ciblent le COMPTE (account_id) ou, par compatibilité, un device_id dont on
// remonte au compte. Suspendre, prolonger ou écrire touche TOUS les écrans du compte.
router.post("/api/v1/admin/commands", requireAdmin, (req, res) => {
  const body = req.body ?? {};
  const action_type = str(body.action_type);
  if (!["suspend", "renew", "broadcast_message"].includes(action_type))
    return res.status(400).json({ error: "action_type inconnu." });

  // Cible : account_id direct, sinon le compte de la boutique visée.
  const accountIdInput = Math.round(Number(body.account_id));
  let account;
  if (Number.isFinite(accountIdInput) && accountIdInput > 0) {
    account = accountById(accountIdInput);
    if (!account) return res.status(404).json({ error: "Compte introuvable." });
  } else {
    const shop = byDeviceId(str(body.device_id));
    if (!shop) return res.status(404).json({ error: "Boutique introuvable." });
    account = shop.account_id ? accountById(shop.account_id) : null;
    if (!account) return res.status(409).json({ error: "Cette boutique n'a pas encore de compte." });
  }
  const session = sessionOf(req);
  if (!accountOriginOk(account, session.scope === "project" ? session.project : null))
    return res.status(403).json({ error: "Compte hors de ce projet." });

  const now = Date.now();
  // Idempotence au niveau compte : un ordre de même action encore en attente est
  // remplacé — « Prolonger » cliqué trois fois ne produit qu'UNE prolongation, la dernière.
  db.prepare(
    `UPDATE admin_commands SET superseded_at = ?
     WHERE account_id = ? AND action_type = ? AND delivered_at IS NULL AND superseded_at IS NULL`,
  ).run(now, account.id, action_type);

  let payload;
  let applyStatus = null;
  if (action_type === "suspend") {
    payload = {};
    // L'état compte dès la commande : des écrans hors ligne restent suspendus au
    // prochain handshake même s'ils n'ont jamais reçu l'ordre.
    applyStatus = () => {
      db.prepare("UPDATE accounts SET suspended_at = ?, updated_at = ? WHERE id = ?").run(now, now, account.id);
      syncShopsFromAccount(account.id);
    };
  } else if (action_type === "renew") {
    // Deux saisies : un montant encaissé (prime) converti selon les PALIERS — +30 jours
    // et places du palier —, ou un nombre de jours explicite qui laisse le palier tel quel.
    const daysInput = Math.round(Number(body.days));
    const amount = Math.round(Number(body.amount_fcfa));
    let days;
    let tierDevices = account.max_devices;
    let paidAmount = 0;
    let renewal = null;
    if (Number.isFinite(amount) && amount > 0) {
      renewal = applyTierRenewal(account, amount, now);
      if (!renewal) {
        return res.status(400).json({
          error: `Montant insuffisant. Paliers : ${PRICE_TIERS.map(
            (t) => `${t.price.toLocaleString("fr-FR")} F (${t.devices} appareils)`,
          ).join(" · ")}.`,
        });
      }
      days = renewal.days;
      tierDevices = renewal.tier.devices;
      paidAmount = amount;
    } else if (Number.isFinite(daysInput) && daysInput > 0) {
      days = daysInput;
    } else {
      return res.status(400).json({ error: "days ou amount_fcfa requis." });
    }
    const new_end_date = renewal
      ? renewal.new_end_date
      : Math.max(now, account.expiry_date) + days * DAY_MS;
    payload = {
      new_end_date,
      days,
      ...(paidAmount > 0 ? { amount_fcfa: paidAmount, max_devices: tierDevices } : {}),
    };
    // La prolongation par montant a déjà tout appliqué (applyTierRenewal) ; la variante
    // « par jours » ne touche qu'à l'échéance et lève aussi la suspension.
    applyStatus =
      paidAmount > 0
        ? null
        : () => {
            db.prepare(
              "UPDATE accounts SET suspended_at = NULL, expiry_date = ?, max_devices = ?, updated_at = ? WHERE id = ?",
            ).run(new_end_date, tierDevices, now, account.id);
            syncShopsFromAccount(account.id);
          };
  } else {
    const message = str(body.message);
    if (!message) return res.status(400).json({ error: "message vide." });
    payload = { message_text: message };
  }

  const id = randomUUID();
  const expires_at = now + COMMAND_TTL_MS;
  if (applyStatus) applyStatus();
  // Commande adressée au COMPTE : device_id vide (colonne NOT NULL héritée du v2),
  // tous les écrans du compte la récupèrent au handshake.
  db.prepare(
    "INSERT INTO admin_commands (id, device_id, account_id, action_type, payload, expires_at, created_at) VALUES (?, '', ?, ?, ?, ?, ?)",
  ).run(id, account.id, action_type, JSON.stringify(payload), expires_at, now);

  logAdminAction(req, "account", account.id, `command:${action_type}`, str(body.message ?? body.reason ?? ""));
  if (action_type === "suspend") logActivity("warn", "account", "Compte suspendu via commande", `${account.name} — commande ${id}`, { account_id: account.id, command_id: id }, null, account.id);
  else if (action_type === "renew") logActivity("success", "account", "Compte prolongé", `${account.name}`, { account_id: account.id, command_id: id, days: body.days, amount: body.amount_fcfa }, null, account.id);
  else if (action_type === "broadcast_message") logActivity("info", "message", "Message diffusé", `${account.name} — ${body.message}`, { account_id: account.id, command_id: id }, null, account.id);

  res.status(201).json({
    command: { id, account_id: account.id, action_type, payload, expires_at, created_at: now, delivered_at: null },
    account: publicAccount(accountById(account.id)),
  });
});

// ── Protocole v2 : listes admin ───────────────────────────────────────────────────
router.get("/api/v1/admin/shops", requireAdmin, (req, res) => {
  const now = Date.now();
  const session = sessionOf(req);
  // Scope projet → ses caisses uniquement. Master → tout, ou `?project=` pour filtrer.
  const scopeOrigin =
    session.scope === "project" ? session.project : str(req.query.project) || null;
  const shops = listShops(scopeOrigin).map((s) => {
    const lastCommand = db
      .prepare(
        `SELECT id, action_type, payload, expires_at, created_at, delivered_at, superseded_at
         FROM admin_commands WHERE device_id = ? AND superseded_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(s.device_id);
    const expired = db
      .prepare(
        `SELECT COUNT(*) AS c FROM admin_commands
         WHERE device_id = ? AND delivered_at IS NULL AND superseded_at IS NULL AND expires_at <= ?`,
      )
      .get(s.device_id, now).c;
    return {
      ...publicShop(s),
      id: s.id,
      last_sync_at: s.last_sync_at ?? null,
      payments: s.payments,
      status: computeStatus(s),
      last_command: lastCommand
        ? {
            id: lastCommand.id,
            action_type: lastCommand.action_type,
            payload: JSON.parse(lastCommand.payload),
            expires_at: lastCommand.expires_at,
            created_at: lastCommand.created_at,
            delivered_at: lastCommand.delivered_at ?? null,
          }
        : null,
      expired_commands: expired,
    };
  });
  res.json({ shops });
});

router.get("/api/v1/admin/shops/:device_id/commands", requireAdmin, (req, res) => {
  const device_id = str(req.params.device_id);
  const session = sessionOf(req);
  const shop = byDeviceId(device_id);
  if (!shop) return res.status(404).json({ error: "Boutique introuvable." });
  if (session.scope === "project" && shop.app_origin !== session.project)
    return res.status(403).json({ error: "Boutique hors de ce projet." });
  const rows = db
    .prepare(
      `SELECT id, action_type, payload, expires_at, created_at, delivered_at, superseded_at
       FROM admin_commands WHERE device_id = ?
       ORDER BY created_at DESC`,
    )
    .all(device_id);
  res.json({
    commands: rows.map((c) => ({ ...c, payload: JSON.parse(c.payload) })),
  });
});

// ── Historique des paiements d'une caisse (facturation des prolongations) ─────────
router.get("/api/v1/admin/shops/:device_id/payments", requireAdmin, (req, res) => {
  const device_id = str(req.params.device_id);
  const session = sessionOf(req);
  const shop = byDeviceId(device_id);
  if (!shop) return res.status(404).json({ error: "Boutique introuvable." });
  if (session.scope === "project" && shop.app_origin !== session.project)
    return res.status(403).json({ error: "Boutique hors de ce projet." });
  res.json({
    payments: db
      .prepare("SELECT * FROM payments WHERE shop_id = ? ORDER BY created_at DESC")
      .all(shop.id),
  });
});

// ── Comptes marchands (vue abonnements multi-écrans) ───────────────────────────────
// Un compte = un abonnement couvrant N écrans. Le statut d'un écran en dépassement de
// quota est signalé `over_limit` : c'est le classement par ancienneté qui décide, le
// même qu'applique le handshake.
router.get("/api/v1/admin/accounts", requireAdmin, (req, res) => {
  const now = Date.now();
  const session = sessionOf(req);
  // Scope projet → les comptes possédant au moins une caisse du projet. Master → tout,
  // ou `?project=` pour filtrer.
  const origin = session.scope === "project" ? session.project : str(req.query.project) || null;
  // Les comptes absorbés par fusion d'enseigne ne sont pas listés : leurs fiches et
  // leur historique vivent désormais sous le compte survivant.
  const accounts = db
    .prepare("SELECT * FROM accounts WHERE merged_into IS NULL ORDER BY expiry_date ASC")
    .all()
    .filter((a) => accountOriginOk(a, origin))
    .map((a) => {
      const devices = accountDevices(a.id);
      return {
        id: a.id,
        name: a.name,
        owner_name: a.owner_name,
        phone: a.phone ?? null,
        max_devices: a.max_devices,
        expiry_date: a.expiry_date,
        suspended_at: a.suspended_at ?? null,
        status: computeAccountStatus(a),
        monthly_price_fcfa: priceForDevices(a.max_devices),
        online: devices.some((d) => d.last_sync_at && now - d.last_sync_at < ONLINE_WINDOW_MS),
        // La migration a réaffecté les paiements legacy au compte : ce compteur les
        // couvre tous.
        payments: db.prepare("SELECT COUNT(*) AS c FROM payments WHERE account_id = ?").get(a.id).c,
        devices: devices.map((d) => {
          const over = deviceOverLimit(a, d.device_id);
          return {
            device_id: d.device_id,
            store_name: d.store_name,
            owner_name: d.owner_name,
            registration_date: d.registration_date,
            last_sync_at: d.last_sync_at ?? null,
            over_limit: over,
            status: over ? "over_limit" : computeStatus(d),
          };
        }),
      };
    });
  res.json({ accounts });
});

function accountForAdmin(req, res) {
  const account = accountById(Number(req.params.id));
  if (!account) {
    res.status(404).json({ error: "Compte introuvable." });
    return null;
  }
  const session = sessionOf(req);
  if (!accountOriginOk(account, session.scope === "project" ? session.project : null)) {
    res.status(403).json({ error: "Compte hors de ce projet." });
    return null;
  }
  return account;
}

// Historique de facturation du compte : paiements niveau compte + paiements legacy
// restés rattachés à une fiche sans account_id.
router.get("/api/v1/admin/accounts/:id/payments", requireAdmin, (req, res) => {
  const account = accountForAdmin(req, res);
  if (!account) return;
  const ids = accountDevices(account.id).map((d) => d.id);
  const legacy = ids.length
    ? db
        .prepare(
          `SELECT * FROM payments WHERE account_id IS NULL AND shop_id IN (${ids.map(() => "?").join(",")})`,
        )
        .all(...ids)
    : [];
  const payments = db
    .prepare("SELECT * FROM payments WHERE account_id = ? ORDER BY created_at DESC")
    .all(account.id)
    .concat(legacy.sort((a, b) => b.created_at - a.created_at));
  res.json({ payments });
});

// Historique des ordres adressés au compte.
router.get("/api/v1/admin/accounts/:id/commands", requireAdmin, (req, res) => {
  const account = accountForAdmin(req, res);
  if (!account) return;
  const rows = db
    .prepare(
      `SELECT id, action_type, payload, expires_at, created_at, delivered_at, superseded_at
       FROM admin_commands WHERE account_id = ? ORDER BY created_at DESC`,
    )
    .all(account.id);
  res.json({ commands: rows.map((c) => ({ ...c, payload: JSON.parse(c.payload) })) });
});

// Réinitialisation du mot de passe du compte : la nouvelle valeur devient la clé que
// les écrans devront présenter (l'écran muni de l'ancienne sera refusé au handshake).
router.post("/api/v1/admin/accounts/:id/password", requireAdmin, (req, res) => {
  const password = str(req.body?.password);
  if (!password) return res.status(400).json({ error: "password requis." });
  const account = accountForAdmin(req, res);
  if (!account) return;
  db.prepare("UPDATE accounts SET password = ?, updated_at = ? WHERE id = ?").run(
    password,
    Date.now(),
    account.id,
  );
  res.json({ ok: true });
});

// ── Demandes d'abonnement (vue + validation EN UN CLIC) ────────────────────────────
// La caisse dépose une preuve de paiement mobile money ; l'admin la valide ici sans
// rien ressaisir : « Valider » applique exactement une Prolongation par montant au
// compte (même code que « Prolonger »), « Refuser » archive la demande avec sa raison.

function publicRequest(r) {
  const account = accountById(r.account_id);
  return {
    id: r.id,
    account_id: r.account_id,
    account_name: account?.name ?? null,
    account_phone: account?.phone ?? null,
    account_status: account ? computeAccountStatus(account) : "unknown",
    device_id: r.device_id,
    store_name: r.store_name,
    owner_name: r.owner_name,
    plan_name: r.plan_name,
    plan_price: r.plan_price,
    plan_devices: r.plan_devices,
    reference: r.reference,
    note: r.note,
    status: r.status,
    created_at: r.created_at,
    decided_at: r.decided_at ?? null,
    decided_by: r.decided_by ?? null,
  };
}

router.get("/api/v1/admin/requests", requireAdmin, (req, res) => {
  const session = sessionOf(req);
  const origin = session.scope === "project" ? session.project : str(req.query.project) || null;
  const statusFilter = str(req.query.status);
  const rows = db
    .prepare(
      `SELECT * FROM subscription_requests ${statusFilter ? "WHERE status = ?" : ""}
       ORDER BY created_at DESC LIMIT 200`,
    )
    .all(...(statusFilter ? [statusFilter] : []));
  res.json({
    requests: rows.map(publicRequest).filter((r) => {
      if (!origin) return true;
      const a = accountById(r.account_id);
      return a ? accountOriginOk(a, origin) : false;
    }),
  });
});

function requestForAdmin(req, res) {
  const row = db
    .prepare("SELECT * FROM subscription_requests WHERE id = ?")
    .get(Number(req.params.id));
  if (!row) {
    res.status(404).json({ error: "Demande introuvable." });
    return null;
  }
  const session = sessionOf(req);
  const account = accountById(row.account_id);
  if (!account || !accountOriginOk(account, session.scope === "project" ? session.project : null)) {
    res.status(403).json({ error: "Demande hors de ce projet." });
    return null;
  }
  return { row, account };
}

/** Un clic « Valider » : prolonge le compte du montant demandé et notifie les écrans. */
router.post("/api/v1/admin/requests/:id/approve", requireAdmin, (req, res) => {
  const found = requestForAdmin(req, res);
  if (!found) return;
  const { row, account } = found;
  if (row.status !== "pending")
    return res.status(409).json({ error: `Demande déjà traitée (${row.status}).` });
  const now = Date.now();
  const renewal = applyTierRenewal(account, row.plan_price, now);
  if (!renewal)
    return res.status(400).json({
      error: `Montant insuffisant. Paliers : ${PRICE_TIERS.map(
        (t) => `${t.price.toLocaleString("fr-FR")} F (${t.devices} appareils)`,
      ).join(" · ")}.`,
    });

  // Idempotence identique à « Prolonger » : un seul renew en attente à la fois.
  db.prepare(
    `UPDATE admin_commands SET superseded_at = ?
     WHERE account_id = ? AND action_type = 'renew' AND delivered_at IS NULL AND superseded_at IS NULL`,
  ).run(now, account.id);
  // Commande adressée au COMPTE : tous les écrans recalculent échéance/quota au
  // prochain handshake — y compris celui qui n'a pas encore reçu la nouvelle place.
  const id = randomUUID();
  db.prepare(
    "INSERT INTO admin_commands (id, device_id, account_id, action_type, payload, expires_at, created_at) VALUES (?, '', ?, 'renew', ?, ?, ?)",
  ).run(
    id,
    account.id,
    JSON.stringify({
      new_end_date: renewal.new_end_date,
      days: renewal.days,
      amount_fcfa: row.plan_price,
      max_devices: renewal.tier.devices,
    }),
    now + COMMAND_TTL_MS,
    now,
  );
  const session = sessionOf(req);
  const by = session.scope === "project" ? `projet:${session.project}` : "master";
  db.prepare(
    "UPDATE subscription_requests SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ?",
  ).run(now, by, row.id);
  console.log(
    `[${new Date().toISOString()}] DEMANDE #${row.id} VALIDÉE (${by}) — compte « ${account.name} », +${renewal.days} j, palier ${renewal.tier.devices}`,
  );
  res.json({
    ok: true,
    command_id: id,
    request: publicRequest(db.prepare("SELECT * FROM subscription_requests WHERE id = ?").get(row.id)),
    account: publicAccount(accountById(account.id)),
  });
});

router.post("/api/v1/admin/requests/:id/reject", requireAdmin, (req, res) => {
  const found = requestForAdmin(req, res);
  if (!found) return;
  const { row } = found;
  if (row.status !== "pending")
    return res.status(409).json({ error: `Demande déjà traitée (${row.status}).` });
  const now = Date.now();
  const session = sessionOf(req);
  const by = session.scope === "project" ? `projet:${session.project}` : "master";
  db.prepare(
    "UPDATE subscription_requests SET status = 'rejected', decided_at = ?, decided_by = ? WHERE id = ?",
  ).run(now, by, row.id);
  console.log(`[${new Date().toISOString()}] DEMANDE #${row.id} REFUSÉE (${by})`);
  res.json({
    ok: true,
    request: publicRequest(db.prepare("SELECT * FROM subscription_requests WHERE id = ?").get(row.id)),
  });
});

// ── Paiements SMS (levier admin sur l'auto-renouvellement TextBee) ───────────────
// Le webhook gère le cas nominal (match → renouvellement auto). Ici : la liste pour le
// dashboard et le rattachement manuel d'un SMS 'unmatched' à un compte (typographie du
// nom différente, téléphone absent du compte, etc.).

/** Version publique d'un paiement SMS, avec le nom du compte matché si présent. */
function publicSmsPayment(row) {
  const account = row.matched_account_id ? accountById(row.matched_account_id) : null;
  return {
    id: row.id,
    phone: row.phone,
    name: row.name,
    amount_fcfa: row.amount_fcfa,
    tid: row.tid,
    status: row.status,
    error: row.error,
    received_at: row.received_at,
    processed_at: row.processed_at,
    matched_account_id: row.matched_account_id,
    matched_tier_price: row.matched_tier_price,
    matched_account_name: account?.name ?? null,
  };
}

router.get("/api/v1/admin/sms-payments", requireAdmin, (req, res) => {
  const status = str(req.query.status);
  const rows = db
    .prepare(
      status
        ? "SELECT * FROM sms_payments WHERE status = ? ORDER BY received_at DESC LIMIT 100"
        : "SELECT * FROM sms_payments ORDER BY received_at DESC LIMIT 100",
    )
    .all(...(status ? [status] : []));
  res.json({ payments: rows.map(publicSmsPayment) });
});

// Rattachement manuel : body = { account_id }. Vérifie que le SMS est encore 'unmatched'
// ou 'pending', applique la renouvelement, puis passe la ligne en 'processed'.
router.post("/api/v1/admin/sms-payments/:id/process", requireAdmin, (req, res) => {
  const row = db.prepare("SELECT * FROM sms_payments WHERE id = ?").get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: "Paiement SMS introuvable." });
  if (row.status !== "unmatched" && row.status !== "pending")
    return res.status(409).json({ error: `Paiement déjà traité (${row.status}).` });

  const account_id = Math.round(Number(req.body?.account_id));
  const account = Number.isFinite(account_id) && account_id > 0 ? accountById(account_id) : null;
  if (!account) return res.status(400).json({ error: "account_id invalide." });

  const tier = tierForAmount(row.amount_fcfa);
  if (!tier)
    return res.status(400).json({
      error: `Montant ${row.amount_fcfa} F ne couvre aucun palier (10 000 / 25 000 / 50 000 F).`,
    });

  const now = Date.now();
  const renewal = applyTierRenewal(account, row.amount_fcfa, now);
  db.prepare(
    "UPDATE sms_payments SET status = 'processed', matched_account_id = ?, matched_tier_price = ?, error = ?, processed_at = ? WHERE id = ?",
  ).run(account.id, tier.price, null, now, row.id);
  const session = sessionOf(req);
  const by = session.scope === "project" ? `projet:${session.project}` : "master";
  console.log(
    `[${new Date().toISOString()}] SMS #${row.id} RATTACHÉ par ${by} → « ${account.name} » (+${renewal.days} j, palier ${renewal.tier.devices})`,
  );
  res.json({
    ok: true,
    payment: publicSmsPayment(db.prepare("SELECT * FROM sms_payments WHERE id = ?").get(row.id)),
    account: publicAccount(accountById(account.id)),
  });
});

// ── Suppression d'une caisse ──────────────────────────────────────────────────────
// Tout ou rien : la fiche, ses paiements, ses ordres en attente et ses payloads de
// sync. Un oubli ici laisserait une caisse fantôme qui ressurgirait dans les stats.
//
// Si la caisse était la DERNIÈRE du compte marchand (plus aucune autre boutique ne
// porte account_id = X), le compte devient orphelin : on le supprime complètement —
// abonnement, demandes, ordres, références SMS. Une boutique qui se supprime elle-même
// depuis l'app doit disparaître entièrement du tableau de bord (et du MRR), pas laisser
// un fantôme qui continue de compter. Un compte avec plusieurs écrans, lui, survit :
// les autres caisses le servent encore.
function deleteAccountCompletely(accountId) {
  db.prepare("DELETE FROM payments WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM admin_commands WHERE account_id = ?").run(accountId);
  db.prepare("DELETE FROM subscription_requests WHERE account_id = ?").run(accountId);
  // Les lignes SMS gardent leur valeur de preuve mais perdent la référence au compte.
  db.prepare("UPDATE sms_payments SET matched_account_id = NULL WHERE matched_account_id = ?").run(accountId);
  db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
}

export function deleteShop(deviceId) {
  const shop = byDeviceId(deviceId);
  if (!shop) return null;
  const accountId = shop.account_id ?? null;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM payments WHERE shop_id = ?").run(shop.id);
    db.prepare("DELETE FROM admin_commands WHERE device_id = ?").run(deviceId);
    db.prepare("DELETE FROM sync_payloads WHERE device_id = ?").run(deviceId);
    db.prepare("DELETE FROM shops WHERE id = ?").run(shop.id);
    if (accountId) {
      const remaining = db.prepare("SELECT COUNT(*) AS c FROM shops WHERE account_id = ?").get(accountId).c;
      if (remaining === 0) deleteAccountCompletely(accountId);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return shop;
}

// Par l'administrateur (scope master, ou projet si la caisse y appartient).
router.delete("/api/v1/admin/shops/:device_id", requireAdmin, (req, res) => {
  const device_id = str(req.params.device_id);
  const session = sessionOf(req);
  const shop = byDeviceId(device_id);
  if (!shop) return res.status(404).json({ error: "Boutique introuvable." });
  if (session.scope === "project" && shop.app_origin !== session.project)
    return res.status(403).json({ error: "Boutique hors de ce projet." });
  deleteShop(device_id);
  logAdminAction(req, "shop", shop.id, "delete", str(req.body?.reason));
  logActivity("error", "shop", "Boutique supprimée", `"${shop.store_name}" (${device_id}) par ${session.scope}`, { device_id, reason: str(req.body?.reason) ?? null }, shop.id, shop.account_id);
  console.log(
    `[${new Date().toISOString()}] BOUTIQUE SUPPRIMÉE "${shop.store_name}" (${device_id}) par ${session.scope}`,
  );
  res.json({ ok: true, device_id });
});

// Par la caisse elle-même, depuis Paramètres. Lien faible mais suffisant : elle prouve
// qu'elle connaît son device_id ET le nom de boutique que le serveur a enregistré.
router.delete("/api/v1/shops/:device_id", (req, res) => {
  const device_id = str(req.params.device_id);
  const store_name = str(req.body?.store_name);
  const shop = byDeviceId(device_id);
  if (!shop) return res.status(404).json({ error: "Boutique introuvable." });
  if (!store_name || store_name !== shop.store_name)
    return res.status(403).json({ error: "Le nom de la boutique ne correspond pas." });
  deleteShop(device_id);
  console.log(
    `[${new Date().toISOString()}] BOUTIQUE SUPPRIMÉE "${shop.store_name}" (${device_id}) par la caisse elle-même`,
  );
  res.json({ ok: true, device_id });
});

// ── Reset total de la base (Phase 1 — nettoyage complet) ───────────────────────────
// POST /api/v1/admin/reset : supprime TOUTES les données (shops, accounts, payments,
// admin_commands, sync_payloads, subscription_requests) et réinitialise les séquences.
// Protégé par authentification admin (scope master uniquement). Utilisé pour repartir
// de zéro lors du lancement du système de fingerprinting.
router.post("/api/v1/admin/reset", requireAdmin, (req, res) => {
  const session = sessionOf(req);
  if (session.scope !== "master") {
    return res.status(403).json({ error: "Seul l'administrateur master peut réinitialiser la base." });
  }
  const confirm = str(req.body?.confirm);
  if (confirm !== "CONFIRM_RESET") {
    return res.status(400).json({ error: "Envoyez { confirm: 'CONFIRM_RESET' } pour confirmer." });
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM subscription_requests").run();
    db.prepare("DELETE FROM sync_payloads").run();
    db.prepare("DELETE FROM admin_commands").run();
    db.prepare("DELETE FROM payments").run();
    db.prepare("DELETE FROM shops").run();
    db.prepare("DELETE FROM accounts").run();
    db.exec("DELETE FROM sqlite_sequence WHERE name IN ('shops', 'payments', 'subscription_requests')");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  console.log(`[${new Date().toISOString()}] BASE RÉINITIALISÉE par ${session.scope} (toutes les données supprimées)`);
  res.json({ ok: true, message: "Toutes les données ont été supprimées. Les projets ont été conservés." });
});

// ── Liste publique des projets (id + nom seulement) : sert au sélecteur du login. ──
// Aucune donnée sensible : pas de mot de passe, pas de compteurs.
router.get("/api/v1/public/projects", (_req, res) => {
  res.json({
    projects: db.prepare("SELECT id, name FROM projects ORDER BY name ASC").all(),
  });
});

// ── Stats réelles par projet (agrégées depuis sync_payloads) ──────────────────────
// Le dashboard affiche les données que les caisses déposent réellement.
router.get("/api/v1/admin/stats", requireAdmin, (req, res) => {
  const session = sessionOf(req);
  // Scope projet → ses caisses uniquement. Master → tout, ou `?project=` pour filtrer.
  const origin =
    session.scope === "project" ? session.project : str(req.query.project) || null;
  const shops = listShops(origin);
  const accounts = db
    .prepare("SELECT * FROM accounts WHERE merged_into IS NULL")
    .all()
    .filter((a) => accountOriginOk(a, origin));
  res.json({
    project: origin,
    subscriptions: computeSubscriptions(accounts),
    ...aggregateStats(shops),
  });
});

// ── Forecast MRR prévisionnel (12 mois) ───────────────────────────────────────────
// Projette le MRR mois par mois en supposant que les abonnements non renouvelés
// perdent leur revenu au mois de leur expiration. Taux de renouvellement configurable
// (défaut 80 %) via query param `renewal_rate`.
router.get("/api/v1/admin/forecast", requireAdmin, (req, res) => {
  const accounts = db
    .prepare("SELECT * FROM accounts WHERE merged_into IS NULL")
    .all();
  const now = Date.now();
  const nowDate = new Date();
  const months = 12;
  const renewalRate = Math.min(1, Math.max(0, parseFloat(str(req.query.renewal_rate)) || 0.8));

  // MRR courant = tous les comptes actifs ou en grace.
  const currentMrr = accounts
    .filter((a) => {
      const st = computeAccountStatus(a);
      return st === "active" || st === "grace";
    })
    .reduce((sum, a) => sum + priceForDevices(a.max_devices), 0);

  // Pour chaque compte actif, on calcule dans quel mois il expire (si non renouvelé).
  const lossByMonth = new Map();
  for (const account of accounts) {
    const st = computeAccountStatus(account);
    if (st !== "active" && st !== "grace") continue;
    const price = priceForDevices(account.max_devices);
    const expiry = new Date(account.expiry_date);
    const label = `${expiry.getFullYear()}-${String(expiry.getMonth() + 1).padStart(2, "0")}`;
    lossByMonth.set(label, (lossByMonth.get(label) ?? 0) + price);
  }

  // Projection mois par mois.
  const result = [];
  let projectedMrr = currentMrr;
  for (let i = 0; i < months; i++) {
    const d = new Date(nowDate.getFullYear(), nowDate.getMonth() + i, 1);
    const label = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const loss = lossByMonth.get(label) ?? 0;
    // Les abonnements expirant ce mois sont perdus sauf ceux renouvelés (renewalRate).
    projectedMrr -= loss * (1 - renewalRate);
    result.push({
      month: label,
      mrr_fcfa: Math.max(0, Math.round(projectedMrr)),
      churn_fcfa: Math.round(loss * (1 - renewalRate)),
      renewal_rate: renewalRate,
    });
  }

  res.json({ current_mrr_fcfa: currentMrr, forecast: result });
});

// ── Revenus par palier d'abonnement (mensuel) ─────────────────────────────────────
// Retourne les 6 derniers mois de revenus, ventilés par palier (10k / 25k / 50k).
// Un paiement est « daté » de created_at ; le palier est déduit du montant.
router.get("/api/v1/admin/revenue-by-tier", requireAdmin, (_req, res) => {
  const months = 6;
  const now = new Date();
  const result = [];

  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year = d.getFullYear();
    const month = d.getMonth(); // 0-based
    const startMs = new Date(year, month, 1).getTime();
    const endMs = new Date(year, month + 1, 1).getTime();
    const label = `${year}-${String(month + 1).padStart(2, "0")}`;

    const payments = db
      .prepare("SELECT amount FROM payments WHERE created_at >= ? AND created_at < ?")
      .all(startMs, endMs);

    const tiers = { tier_10k: 0, tier_25k: 0, tier_50k: 0, other: 0 };
    let total = 0;

    for (const p of payments) {
      total += p.amount;
      if (p.amount >= 50_000) tiers.tier_50k += p.amount;
      else if (p.amount >= 25_000) tiers.tier_25k += p.amount;
      else if (p.amount >= 10_000) tiers.tier_10k += p.amount;
      else tiers.other += p.amount;
    }

    result.push({ month: label, ...tiers, total });
  }

  res.json({ months: result });
});

// ── Rétention / churn clients ────────────────────────────────────────────────────
// Pour chaque mois des 6 derniers : combien de comptes actifs, nouveaux, perdus,
// et taux de rétention.
router.get("/api/v1/admin/retention", requireAdmin, (_req, res) => {
  const months = 6;
  const now = new Date();
  const accounts = db
    .prepare("SELECT * FROM accounts WHERE merged_into IS NULL")
    .all();

  // Par compte, on détermine son statut à la fin de chaque mois.
  const result = [];

  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year = d.getFullYear();
    const month = d.getMonth();
    const endMs = new Date(year, month + 1, 0, 23, 59, 59, 999).getTime();
    const label = `${year}-${String(month + 1).padStart(2, "0")}`;

    let active = 0;
    let newThisMonth = 0;
    let churnedThisMonth = 0;

    for (const a of accounts) {
      const createdBefore = a.created_at <= endMs;
      const expiredBy = a.expiry_date <= endMs;
      const isChurned = expiredBy || (a.status === "suspended" && a.updated_at <= endMs);

      if (createdBefore && !isChurned) active++;
      if (a.created_at >= new Date(year, month, 1).getTime() && createdBefore) newThisMonth++;
      if (isChurned && a.created_at < new Date(year, month, 1).getTime()) churnedThisMonth++;
    }

    const prev = result.length > 0 ? result[result.length - 1].active : active;
    const retention = prev > 0 ? Math.round(((active - newThisMonth) / prev) * 100) : 100;

    result.push({ month: label, active, new: newThisMonth, churned: churnedThisMonth, retention_pct: retention });
  }

  res.json({ months: result });
});

// ── Protocole v2 : gestion des projets (master uniquement) ────────────────────────
router.get("/api/v1/admin/projects", requireMaster, (_req, res) => {
  const projects = db
    .prepare(
      `SELECT p.id, p.name, p.created_at, p.type, p.price_per_month_fcfa, p.trial_days,
              (SELECT COUNT(*) FROM shops s WHERE s.app_origin = p.id) AS shop_count
       FROM projects p ORDER BY p.created_at ASC`,
    )
    .all()
    .map((p) => ({ ...p, from_manifest: manifests.has(p.id) }));
  res.json({ projects });
});

router.post("/api/v1/admin/projects", requireMaster, (req, res) => {
  const id = str(req.body?.id);
  const name = str(req.body?.name);
  const password = str(req.body?.password);
  const type = str(req.body?.type) || null;
  const price = Math.round(Number(req.body?.price_per_month_fcfa));
  const trial = Math.round(Number(req.body?.trial_days));
  if (!id || !name || !password)
    return res.status(400).json({ error: "id, name et password requis." });
  if (!/^[a-z0-9_-]+$/.test(id))
    return res.status(400).json({ error: "id invalide (minuscules, chiffres, _ ou -)." });
  if (projectById(id))
    return res.status(409).json({ error: "Ce projet existe déjà." });
  db.prepare(
    `INSERT INTO projects (id, name, password, created_at, type, price_per_month_fcfa, trial_days)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    name,
    password,
    Date.now(),
    type,
    Number.isFinite(price) && price > 0 ? price : null,
    Number.isFinite(trial) && trial > 0 ? trial : null,
  );
  res.status(201).json({ project: projectById(id) });
});

router.post("/api/v1/admin/projects/:id/password", requireMaster, (req, res) => {
  const password = str(req.body?.password);
  const proj = projectById(str(req.params.id));
  if (!proj) return res.status(404).json({ error: "Projet introuvable." });
  if (!password) return res.status(400).json({ error: "password requis." });
  db.prepare("UPDATE projects SET password = ? WHERE id = ?").run(password, proj.id);
  logAdminAction(req, "project", proj.id, "change_password", null);
  logActivity("warn", "project", "Mot de passe modifié", `"${proj.name}"`, { project_id: proj.id }, null, null, proj.id);
  res.json({ ok: true });
});

// Tarif / essai / type d'un projet — pilote la facturation (montant → jours) et la
// durée d'essai appliquée aux nouvelles caisses. Vide un champ pour repasser au défaut.
router.post("/api/v1/admin/projects/:id/config", requireMaster, (req, res) => {
  const proj = projectById(str(req.params.id));
  if (!proj) return res.status(404).json({ error: "Projet introuvable." });
  const type = str(req.body?.type) || null;
  const price = Math.round(Number(req.body?.price_per_month_fcfa));
  const trial = Math.round(Number(req.body?.trial_days));
  db.prepare(
    `UPDATE projects SET type = ?, price_per_month_fcfa = ?, trial_days = ? WHERE id = ?`,
  ).run(
    type,
    Number.isFinite(price) && price > 0 ? price : null,
    Number.isFinite(trial) && trial > 0 ? trial : null,
    proj.id,
  );
  logAdminAction(req, "project", proj.id, "change_config", null);
  logActivity("info", "project", "Configuration modifiée", `"${proj.name}"`, { project_id: proj.id }, null, null, proj.id);
  res.json({ ok: true, project: projectById(proj.id) });
});

// ── Rétrocompat : routes de l'ancien server.mjs (builds déjà installées) ──────────
router.post("/api/shops", (req, res) => {
  const result = upsertShop({ ...req.body, app_version_used: undefined });
  if (result.status !== 200) return res.status(400).json(result.shop);
  // Rattrapage : la fiche rejoint (ou crée) son compte — aucun écran orphelin.
  const shop = attachAccountForLegacy(result.shop);
  // L'échéance renvoyée fait foi : l'app s'y aligne (cf. sync.ts côté app).
  res.json({ shop });
});

router.get("/api/shops", requireAdmin, (_req, res) => {
  res.json({ shops: listShops() });
});

router.get("/api/shops/:id/payments", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || !byId(id))
    return res.status(404).json({ error: "Boutique introuvable." });
  res.json({
    payments: db
      .prepare("SELECT * FROM payments WHERE shop_id = ? ORDER BY created_at DESC")
      .all(id),
  });
});

router.post("/api/shops/:id/extend", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const shop = byId(id);
  if (!shop) return res.status(404).json({ error: "Boutique introuvable." });
  const amount = Math.round(Number(req.body?.amount_fcfa));
  if (!Number.isFinite(amount) || amount <= 0)
    return res.status(400).json({ error: "Montant invalide." });
  const days = Math.max(1, Math.round((amount / PRICE_PER_MONTH_FCFA) * 30));
  const now = Date.now();
  // La prolongation vise le COMPTE de la fiche : c'est son échéance qui recule, puis le
  // miroir met les fiches à jour. Formule tarifaire historique conservée pour cette
  // route legacy.
  const account = attachAccountForLegacy(shop) ? accountById(shop.account_id) : null;
  const base = account ? Math.max(now, account.expiry_date) : Math.max(now, shop.expiry_date);
  const next = base + days * DAY_MS;
  db.exec("BEGIN");
  try {
    if (account) {
      db.prepare(
        "UPDATE accounts SET suspended_at = NULL, expiry_date = ?, updated_at = ? WHERE id = ?",
      ).run(next, now, account.id);
      syncShopsFromAccount(account.id);
    } else {
      db.prepare(
        "UPDATE shops SET suspended_at = NULL, expiry_date = ?, updated_at = ? WHERE id = ?",
      ).run(next, now, id);
    }
    db.prepare(
      "INSERT INTO payments (shop_id, account_id, amount, days_added, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, account?.id ?? null, amount, days, now);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  res.json({ shop: byId(id) });
});

export default router;
