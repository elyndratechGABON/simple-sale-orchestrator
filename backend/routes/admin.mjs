// Routes admin (dashboard) — commandes, boutiques, comptes, demandes,
// paiements SMS, projets, reset et routes rétrocompat de l'ancien server.mjs.
// Tout est ASYNC (Postgres, facette db de config.mjs).
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
  planNameForDevices,
} from "../config.mjs";
import {
  str,
  byId,
  byDeviceId,
  groupShopsByAccount,
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
  applyTierRenewal,
  tierForAmount,
  computeSubscriptions,
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

// ── Vue structurée : toutes les boutiques + appareils par boutique ─────────────
router.get("/api/v1/admin/shops", requireAdmin, async (req, res) => {
  const shops = await listShops(req.query.origin);
  const result = await Promise.all(
    shops.map(async (s) => {
      const account = s.account_id ? await accountById(s.account_id) : null;
      return {
        id: s.id,
        device_id: s.device_id,
        store_name: s.store_name,
        owner_name: s.owner_name,
        account_id: s.account_id,
        account_name: account?.name ?? null,
        phone: s.phone,
        location: s.location,
        cluster: s.app_origin ?? "pos",
        expiry_date: s.expiry_date,
        suspended_at: s.suspended_at ?? null,
        status: account ? computeAccountStatus(account) : (s.account_id ? "unknown" : "unlinked"),
        over_limit: account ? await deviceOverLimit(account, s.device_id) : false,
        registered_at: s.registration_date,
        last_sync_at: s.last_sync_at ?? null,
        app_origin: s.app_origin ?? "pos",
      };
    }),
  );
  res.json({ shops: result, total: result.length });
});

// ── Protocole v3 : commandes admin (boîte aux lettres) ────────────────────────────
// Les ordres ciblent le COMPTE (account_id) ou, par compatibilité, un device_id dont on
// remonte au compte. Suspendre, prolonger ou écrire touche TOUS les écrans du compte.
router.post("/api/v1/admin/commands", requireAdmin, async (req, res) => {
  const body = req.body ?? {};
  const action_type = str(body.action_type);
  if (!["suspend", "renew", "broadcast_message"].includes(action_type))
    return res.status(400).json({ error: "action_type inconnu." });

  // Cible : account_id direct, sinon le compte de la boutique visée.
  const accountIdInput = Math.round(Number(body.account_id));
  let account;
  if (Number.isFinite(accountIdInput) && accountIdInput > 0) {
    account = await accountById(accountIdInput);
    if (!account) return res.status(404).json({ error: "Compte introuvable." });
  } else {
    const shop = await byDeviceId(str(body.device_id));
    if (!shop) return res.status(404).json({ error: "Boutique introuvable." });
    account = shop.account_id ? await accountById(shop.account_id) : null;
    if (!account) return res.status(409).json({ error: "Cette boutique n'a pas encore de compte." });
  }
  const session = sessionOf(req);
  if (!(await accountOriginOk(account, session.scope === "project" ? session.project : null)))
    return res.status(403).json({ error: "Compte hors de ce projet." });

  const now = Date.now();
  // Idempotence au niveau compte : un ordre de même action encore en attente est
  // remplacé — « Prolonger » cliqué trois fois ne produit qu'UNE prolongation, la dernière.
  await db.run(
    `UPDATE admin_commands SET superseded_at = $1
     WHERE account_id = $2 AND action_type = $3 AND delivered_at IS NULL AND superseded_at IS NULL`,
    now,
    account.id,
    action_type,
  );

  let payload;
  let applyStatus = null;
  if (action_type === "suspend") {
    payload = {};
    // L'état compte dès la commande : des écrans hors ligne restent suspendus au
    // prochain handshake même s'ils n'ont jamais reçu l'ordre.
    applyStatus = async () => {
      await db.run("UPDATE accounts SET suspended_at = $1, updated_at = $2 WHERE id = $3", now, now, account.id);
      await syncShopsFromAccount(account.id);
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
      renewal = await applyTierRenewal(account, amount, now);
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
        : async () => {
            await db.run(
              "UPDATE accounts SET suspended_at = NULL, expiry_date = $1, max_devices = $2, updated_at = $3 WHERE id = $4",
              new_end_date,
              tierDevices,
              now,
              account.id,
            );
            await syncShopsFromAccount(account.id);
          };
  } else {
    const message = str(body.message);
    if (!message) return res.status(400).json({ error: "message vide." });
    payload = { message_text: message };
  }

  const id = randomUUID();
  const expires_at = now + COMMAND_TTL_MS;
  if (applyStatus) await applyStatus();
  // Commande adressée au COMPTE : device_id vide (colonne NOT NULL héritée du v2),
  // tous les écrans du compte la récupèrent au handshake.
  await db.run(
    "INSERT INTO admin_commands (id, device_id, account_id, action_type, payload, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    id,
    "",
    account.id,
    action_type,
    JSON.stringify(payload),
    expires_at,
    now,
  );

  await logAdminAction(req, "account", account.id, `command:${action_type}`, str(body.message ?? body.reason ?? ""));
  if (action_type === "suspend") await logActivity("warn", "account", "Compte suspendu via commande", `${account.name} — commande ${id}`, { account_id: account.id, command_id: id }, null, account.id);
  else if (action_type === "renew") await logActivity("success", "account", "Compte prolongé", `${account.name}`, { account_id: account.id, command_id: id, days: body.days, amount: body.amount_fcfa }, null, account.id);
  else if (action_type === "broadcast_message") await logActivity("info", "message", "Message diffusé", `${account.name} — ${body.message}`, { account_id: account.id, command_id: id }, null, account.id);

  res.status(201).json({
    command: { id, account_id: account.id, action_type, payload, expires_at, created_at: now, delivered_at: null },
    account: await publicAccount(await accountById(account.id)),
  });
});

router.get("/api/v1/admin/shops/:device_id/commands", requireAdmin, async (req, res) => {
  const device_id = str(req.params.device_id);
  const session = sessionOf(req);
  const shop = await byDeviceId(device_id);
  if (!shop) return res.status(404).json({ error: "Boutique introuvable." });
  if (session.scope === "project" && shop.app_origin !== session.project)
    return res.status(403).json({ error: "Boutique hors de ce projet." });
  const rows = await db.all(
    `SELECT id, action_type, payload, expires_at, created_at, delivered_at, superseded_at
     FROM admin_commands WHERE device_id = $1
     ORDER BY created_at DESC`,
    device_id,
  );
  res.json({
    commands: rows.map((c) => ({ ...c, payload: JSON.parse(c.payload) })),
  });
});

// ── Historique des paiements d'une caisse (facturation des prolongations) ─────────
router.get("/api/v1/admin/shops/:device_id/payments", requireAdmin, async (req, res) => {
  const device_id = str(req.params.device_id);
  const session = sessionOf(req);
  const shop = await byDeviceId(device_id);
  if (!shop) return res.status(404).json({ error: "Boutique introuvable." });
  if (session.scope === "project" && shop.app_origin !== session.project)
    return res.status(403).json({ error: "Boutique hors de ce projet." });
  res.json({
    payments: await db.all("SELECT * FROM payments WHERE shop_id = $1 ORDER BY created_at DESC", shop.id),
  });
});

// ── Comptes marchands (vue abonnements multi-écrans) ───────────────────────────────
// Un compte = un abonnement couvrant N écrans. Le statut d'un écran en dépassement de
// quota est signalé `over_limit` : c'est le classement par ancienneté qui décide, le
// même qu'applique le handshake.
router.get("/api/v1/admin/accounts", requireAdmin, async (req, res) => {
  const now = Date.now();
  const session = sessionOf(req);
  // Scope projet → les comptes possédant au moins une caisse du projet. Master → tout,
  // ou `?project=` pour filtrer.
  const origin = session.scope === "project" ? session.project : str(req.query.project) || null;
  // Les comptes absorbés par fusion d'enseigne ne sont pas listés : leurs fiches et
  // leur historique vivent désormais sous le compte survivant.
  const rows = await db.all("SELECT * FROM accounts WHERE merged_into IS NULL ORDER BY expiry_date ASC");
  const okRows = [];
  for (const a of rows) {
    if (await accountOriginOk(a, origin)) okRows.push(a);
  }
  const accounts = await Promise.all(
    okRows.map(async (a) => {
      const devices = await accountDevices(a.id);
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
        payments: (await db.get("SELECT COUNT(*) AS c FROM payments WHERE account_id = $1", a.id)).c,
        devices: await Promise.all(
          devices.map(async (d) => {
            const over = await deviceOverLimit(a, d.device_id);
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
        ),
      };
    }),
  );
  res.json({ accounts });
});

async function accountForAdmin(req, res) {
  const account = await accountById(Number(req.params.id));
  if (!account) {
    res.status(404).json({ error: "Compte introuvable." });
    return null;
  }
  const session = sessionOf(req);
  if (!(await accountOriginOk(account, session.scope === "project" ? session.project : null))) {
    res.status(403).json({ error: "Compte hors de ce projet." });
    return null;
  }
  return account;
}

// Historique de facturation du compte : paiements niveau compte + paiements legacy
// restés rattachés à une fiche sans account_id.
router.get("/api/v1/admin/accounts/:id/payments", requireAdmin, async (req, res) => {
  const account = await accountForAdmin(req, res);
  if (!account) return;
  const ids = (await accountDevices(account.id)).map((d) => d.id);
  const legacy = ids.length
    ? await db.all(
        `SELECT * FROM payments WHERE account_id IS NULL AND shop_id IN (${ids.map((_, i) => "$" + (i + 1)).join(",")})`,
        ...ids,
      )
    : [];
  const payments = await db.all("SELECT * FROM payments WHERE account_id = $1 ORDER BY created_at DESC", account.id);
  res.json({ payments: payments.concat(legacy.sort((a, b) => b.created_at - a.created_at)) });
});

// Historique des ordres adressés au compte.
router.get("/api/v1/admin/accounts/:id/commands", requireAdmin, async (req, res) => {
  const account = await accountForAdmin(req, res);
  if (!account) return;
  const rows = await db.all(
    `SELECT id, action_type, payload, expires_at, created_at, delivered_at, superseded_at
     FROM admin_commands WHERE account_id = $1 ORDER BY created_at DESC`,
    account.id,
  );
  res.json({ commands: rows.map((c) => ({ ...c, payload: JSON.parse(c.payload) })) });
});

// Réinitialisation du mot de passe du compte : la nouvelle valeur devient la clé que
// les écrans devront présenter (l'écran muni de l'ancienne sera refusé au handshake).
router.post("/api/v1/admin/accounts/:id/password", requireAdmin, async (req, res) => {
  const password = str(req.body?.password);
  if (!password) return res.status(400).json({ error: "password requis." });
  const account = await accountForAdmin(req, res);
  if (!account) return;
  await db.run("UPDATE accounts SET password = $1, updated_at = $2 WHERE id = $3", password, Date.now(), account.id);
  res.json({ ok: true });
});

// ── Demandes d'abonnement (vue + validation EN UN CLIC) ────────────────────────────
// La caisse dépose une preuve de paiement mobile money ; l'admin la valide ici sans
// rien ressaisir : « Valider » applique exactement une Prolongation par montant au
// compte (même code que « Prolonger »), « Refuser » archive la demande avec sa raison.

async function publicRequest(r) {
  const account = await accountById(r.account_id);
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

router.get("/api/v1/admin/requests", requireAdmin, async (req, res) => {
  const session = sessionOf(req);
  const origin = session.scope === "project" ? session.project : str(req.query.project) || null;
  const statusFilter = str(req.query.status);
  const rows = await db.all(
    `SELECT * FROM subscription_requests ${statusFilter ? "WHERE status = $1" : ""}
     ORDER BY created_at DESC LIMIT 200`,
    ...(statusFilter ? [statusFilter] : []),
  );
  const requests = [];
  for (const r of await Promise.all(rows.map(publicRequest))) {
    if (!origin) {
      requests.push(r);
      continue;
    }
    const a = await accountById(r.account_id);
    if (a && (await accountOriginOk(a, origin))) requests.push(r);
  }
  res.json({ requests });
});

// ── Demandes de paiement (payment_requests) ───────────────────────────────────────────
router.get("/api/v1/admin/payment-requests", requireAdmin, async (req, res) => {
  const session = sessionOf(req);
  const origin = session.scope === "project" ? session.project : str(req.query.project) || null;
  const statusFilter = str(req.query.status);
  const rows = await db.all(
    `SELECT * FROM payment_requests ${statusFilter ? "WHERE status = $1" : ""}
     ORDER BY created_at DESC LIMIT 200`,
    ...(statusFilter ? [statusFilter] : []),
  );
  const requests = await Promise.all(rows.map(async (r) => {
    const shop = await byId(r.shop_id);
    return {
      id: r.id,
      shop_id: r.shop_id,
      store_name: shop?.store_name ?? null,
      sms_text: r.sms_text,
      plan: r.plan,
      status: r.status,
      created_at: r.created_at,
      validated_at: r.validated_at,
    };
  }));
  res.json({ requests });
});

async function paymentRequestForAdmin(req, res) {
  const row = await db.get("SELECT * FROM payment_requests WHERE id = $1", Number(req.params.id));
  if (!row) {
    res.status(404).json({ error: "Demande de paiement introuvable." });
    return null;
  }
  const session = sessionOf(req);
  const account = await accountById(row.shop_id > 0 ? /* not directly usable */ null : null);
  // On vérifie l'appartenance projet via la boutique
  const shop = await byId(row.shop_id);
  if (!shop) return null;
  if (session.scope === "project" && shop.app_origin !== session.project) {
    res.status(403).json({ error: "Demande hors de ce projet." });
    return null;
  }
  return { row, shop };
}

/** Un clic « Valider » : approuve la demande de paiement et prolonge le compte de +30 jours. */
router.post("/api/v1/admin/payment-requests/:id/validate", requireAdmin, async (req, res) => {
  const found = await paymentRequestForAdmin(req, res);
  if (!found) return;
  const { row, shop } = found;
  if (row.status !== "pending")
    return res.status(409).json({ error: `Demande déjà traitée (${row.status}).` });
  const nowTimestamp = Date.now();
  // 1. Met à jour le statut de la demande
  await db.run(
    "UPDATE payment_requests SET status = 'approved', validated_at = $1 WHERE id = $2",
    nowTimestamp,
    row.id,
  );
  // 2. Met à jour la date d'expiration de la boutique de +30 jours
  const shopAccount = shop.account_id ? await accountById(shop.account_id) : null;
  if (!shopAccount) return res.status(409).json({ error: "Cette boutique n'a pas de compte associé." });
  const new_expiry_date = shopAccount.expiry_date
    ? Math.max(Date.now(), shopAccount.expiry_date) + 30 * DAY_MS
    : nowTimestamp + 30 * DAY_MS;
  await db.run(
    "UPDATE accounts SET expiry_date = $1, updated_at = $2 WHERE id = $3",
    new_expiry_date,
    nowTimestamp,
    shopAccount.id,
  );
  await syncShopsFromAccount(shopAccount.id);
  console.log(
    `[${new Date().toISOString()}] DEMANDE DE PAIEMENT #${row.id} VALIDÉE → shop_id=${shop.id}, compte #${shopAccount.id}, nouvelle échéance +30 j`,
  );
  res.json({
    ok: true,
    request_id: row.id,
    shop_id: shop.id,
    new_expiry_date,
    account: await publicAccount(await accountById(shopAccount.id)),
  });
});

// ── Demandes d'abonnement (vue + validation EN UN CLIC) ────────────────────────────

async function requestForAdmin(req, res) {
  const row = await db.get("SELECT * FROM subscription_requests WHERE id = $1", Number(req.params.id));
  if (!row) {
    res.status(404).json({ error: "Demande introuvable." });
    return null;
  }
  const session = sessionOf(req);
  const account = await accountById(row.account_id);
  if (!account || !(await accountOriginOk(account, session.scope === "project" ? session.project : null))) {
    res.status(403).json({ error: "Demande hors de ce projet." });
    return null;
  }
  return { row, account };
}

/** Un clic « Valider » : prolonge le compte du montant demandé et notifie les écrans. */
router.post("/api/v1/admin/requests/:id/approve", requireAdmin, async (req, res) => {
  const found = await requestForAdmin(req, res);
  if (!found) return;
  const { row, account } = found;
  if (row.status !== "pending")
    return res.status(409).json({ error: `Demande déjà traitée (${row.status}).` });
  const now = Date.now();
  const renewal = await applyTierRenewal(account, row.plan_price, now);
  if (!renewal)
    return res.status(400).json({
      error: `Montant insuffisant. Paliers : ${PRICE_TIERS.map(
        (t) => `${t.price.toLocaleString("fr-FR")} F (${t.devices} appareils)`,
      ).join(" · ")}.`,
    });

  // Idempotence identique à « Prolonger » : un seul renew en attente à la fois.
  await db.run(
    `UPDATE admin_commands SET superseded_at = $1
     WHERE account_id = $2 AND action_type = 'renew' AND delivered_at IS NULL AND superseded_at IS NULL`,
    now,
    account.id,
  );
  // Commande adressée au COMPTE : tous les écrans recalculent échéance/quota au
  // prochain handshake — y compris celui qui n'a pas encore reçu la nouvelle place.
  const id = randomUUID();
  await db.run(
    "INSERT INTO admin_commands (id, device_id, account_id, action_type, payload, expires_at, created_at) VALUES ($1, $2, $3, 'renew', $4, $5, $6)",
    id,
    "",
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
  await db.run(
    "UPDATE subscription_requests SET status = 'approved', decided_at = $1, decided_by = $2 WHERE id = $3",
    now,
    by,
    row.id,
  );
  console.log(
    `[${new Date().toISOString()}] DEMANDE #${row.id} VALIDÉE (${by}) — compte « ${account.name} », +${renewal.days} j, palier ${renewal.tier.devices}`,
  );
  res.json({
    ok: true,
    command_id: id,
    request: await publicRequest(await db.get("SELECT * FROM subscription_requests WHERE id = $1", row.id)),
    account: await publicAccount(await accountById(account.id)),
  });
});

router.post("/api/v1/admin/requests/:id/reject", requireAdmin, async (req, res) => {
  const found = await requestForAdmin(req, res);
  if (!found) return;
  const { row } = found;
  if (row.status !== "pending")
    return res.status(409).json({ error: `Demande déjà traitée (${row.status}).` });
  const now = Date.now();
  const session = sessionOf(req);
  const by = session.scope === "project" ? `projet:${session.project}` : "master";
  await db.run(
    "UPDATE subscription_requests SET status = 'rejected', decided_at = $1, decided_by = $2 WHERE id = $3",
    now,
    by,
    row.id,
  );
  console.log(`[${new Date().toISOString()}] DEMANDE #${row.id} REFUSÉE (${by})`);
  res.json({
    ok: true,
    request: await publicRequest(await db.get("SELECT * FROM subscription_requests WHERE id = $1", row.id)),
  });
});

// ── Paiements SMS (levier admin sur l'auto-renouvellement TextBee) ───────────────
// Le webhook ne renouvelle PLUS rien : le SMS arrive en 'pending' et attend une
// décision humaine. Ici : la liste pour le dashboard et le rattachement manuel d'un
// SMS à un compte (typographie du nom différente, téléphone absent du compte, etc.).
// Statuts SIMPLIFIÉS : 'pending' (à traiter) | 'processed' (validé) | 'rejected' (refusé).

/** Version publique d'un paiement SMS, avec le nom du compte matché si présent. */
async function publicSmsPayment(row) {
  const account = row.matched_account_id ? await accountById(row.matched_account_id) : null;
  return {
    id: row.id,
    phone: row.phone,
    name: row.name,
    amount_fcfa: row.amount_fcfa,
    tid: row.tid,
    status: row.status,
    // Le SMS BRUT : l'administrateur doit pouvoir lire ce que le client a envoyé
    // (montant illisible, faute de frappe) avant de valider ou de rejeter.
    raw_sms: row.raw_sms ?? null,
    error: row.error,
    received_at: row.received_at,
    processed_at: row.processed_at,
    matched_account_id: row.matched_account_id,
    matched_tier_price: row.matched_tier_price,
    matched_account_name: account?.name ?? null,
  };
}

router.get("/api/v1/admin/sms-payments", requireAdmin, async (req, res) => {
  const status = str(req.query.status);
  const rows = await db.all(
    status
      ? "SELECT * FROM sms_payments WHERE status = $1 ORDER BY received_at DESC LIMIT 100"
      : "SELECT * FROM sms_payments ORDER BY received_at DESC LIMIT 100",
    ...(status ? [status] : []),
  );
  res.json({ payments: await Promise.all(rows.map(publicSmsPayment)) });
});

// Rattachement manuel : body = { account_id }. Verifie que le SMS est encore 'pending'
// ou 'pending', applique la renouvellement, puis passe la ligne en 'processed'.
//
// C'est désormais LE SEUL chemin de renouvellement par SMS : le webhook ne prolonge plus
// rien (cf. `entry.mjs`), il journalise. Un SMS reste donc une REQUÊTE jusqu'à ce clic —
// nécessaire parce que le numéro du marchand est public (il circule dans le handshake) et
// que `parseSms` est une regex : un SMS forgé au bon numéro et au bon palier renouvelait
// auparavant n'importe quel abonnement.
//
// `account_id` est OPTIONNEL quand le webhook a déjà apparié le SMS : le
// compte trouvé est alors celui du numéro payeur. Il reste exigé pour un SMS sans
// compte reconnu, où le choix est une décision humaine. On n'oblige pas à ressaisir
// ce qu'on sait déjà.
router.post("/api/v1/admin/sms-payments/:id/process", requireAdmin, async (req, res) => {
  const row = await db.get("SELECT * FROM sms_payments WHERE id = $1", Number(req.params.id));
  if (!row) return res.status(404).json({ error: "Paiement SMS introuvable." });
  if (row.status !== "pending")
    return res.status(409).json({ error: `Paiement déjà traité (${row.status}).` });

  const account_id = Math.round(Number(req.body?.account_id));
  const account =
    Number.isFinite(account_id) && account_id > 0
      ? await accountById(account_id)
      : row.matched_account_id
        ? await accountById(row.matched_account_id)
        : null;
  if (!account) return res.status(400).json({ error: "account_id invalide." });

  // La session projet ne valide que les comptes de SON projet : sans ce garde, un
  // dashboard de projet pourrait valider le paiement d'un concurrent en devinant son id.
  const session = sessionOf(req);
  if (!(await accountOriginOk(account, session.scope === "project" ? session.project : null)))
    return res.status(403).json({ error: "Compte hors de ce projet." });


  const tier = tierForAmount(row.amount_fcfa);
  if (!tier)
    return res.status(400).json({
      error: `Montant ${row.amount_fcfa} F ne couvre aucun palier (10 000 / 25 000 / 50 000 F).`,
    });

  const now = Date.now();
  const renewal = await applyTierRenewal(account, row.amount_fcfa, now);
  await db.run(
    "UPDATE sms_payments SET status = 'processed', matched_account_id = $1, matched_tier_price = $2, error = $3, processed_at = $4 WHERE id = $5",
    account.id,
    tier.price,
    null,
    now,
    row.id,
  );
  const by = session.scope === "project" ? `projet:${session.project}` : "master";
  console.log(
    `[${new Date().toISOString()}] SMS #${row.id} VALIDÉ par ${by} → « ${account.name} » (+${renewal.days} j, palier ${renewal.tier.devices})`,
  );
  res.json({
    ok: true,
    payment: await publicSmsPayment(await db.get("SELECT * FROM sms_payments WHERE id = $1", row.id)),
    account: await publicAccount(await accountById(account.id)),
  });
});

// ── Rejet d'un SMS de paiement ─────────────────────────────────────────────────────
// Le SMS n'est PAS un renouvellement : c'est une REQUÊTE. Tant que l'administrateur
// ne décide pas, rien ne bouge. « Rejeter » n'annule donc aucun abonnement — il sort
// la ligne de la file d'attente pour qu'elle ne revienne pas dans les « à vérifier ».
router.post("/api/v1/admin/sms-payments/:id/reject", requireAdmin, async (req, res) => {
  const row = await db.get("SELECT * FROM sms_payments WHERE id = $1", Number(req.params.id));
  if (!row) return res.status(404).json({ error: "Paiement SMS introuvable." });
  if (row.status === "processed")
    return res.status(409).json({ error: "Ce paiement a déjà été validé." });

  const now = Date.now();
  await db.run(
    "UPDATE sms_payments SET status = 'rejected', error = $1, processed_at = $2 WHERE id = $3",
    str(req.body?.reason) || "Rejeté par l'administrateur",
    now,
    row.id,
  );
  await logActivity(
    "warn",
    "payment",
    "SMS de paiement rejeté",
    `${row.name} (${row.phone}) — ${row.amount_fcfa.toLocaleString("fr-FR")} F`,
    { sms_payment_id: row.id, amount: row.amount_fcfa },
    null,
  );
  const session = sessionOf(req);
  console.log(
    `[${new Date().toISOString()}] SMS #${row.id} REJETÉ par ${session.scope} — « ${row.name} » ${row.amount_fcfa} F`,
  );
  res.json({ ok: true, payment: await publicSmsPayment(await db.get("SELECT * FROM sms_payments WHERE id = $1", row.id)) });
});

// ── Suppression d'une caisse ──────────────────────────────────────────────────────
// Tout ou rien : la fiche, ses paiements, ses ordres en attente, ses payloads de sync,
// ses événements d'activité et de paiement, ses bénédictions/identifiants. Un oubli
// ici laisserait une caisse fantôme qui ressurgirait dans les stats — ou un pendouillant
// FK qui ferait échouer toute la transaction (Postgres force les clés étrangères).
//
// Si la caisse était la DERNIÈRE du compte marchand (plus aucune autre boutique ne
// porte account_id = X), le compte devient orphelin : on le supprime complètement —
// abonnement, demandes, ordres, références SMS, événements. Une boutique qui se supprime
// elle-même depuis l'app doit disparaître entièrement du tableau de bord (et du MRR), pas
// laisser un fantôme qui continue de compter. Un compte avec plusieurs écrans, lui,
// survit : les autres caisses le servent encore.
// `q` = exécuteur : la facette db (hors transaction) ou un client pg (dans une tx).
/**
 * Supprime une fiche écran et tout ce qui en dépend (ventes, ordres, historique).
 * Partagé par la suppression d'un écran et par celle d'un compte.
 */
async function deleteShopRows(shop, run) {
  await run("DELETE FROM payments WHERE shop_id = $1", [shop.id]);
  // Demande de paiement liée à CET écran : colonne shop_id NOT NULL, FK vers shops —
  // sans ce DELETE, la suppression d'une boutique qui avait déposé une demande
  // échouait sur la clé étrangère (« Erreur interne » côté console).
  await run("DELETE FROM payment_requests WHERE shop_id = $1", [shop.id]);
  // Jobs de restauration ouverts pour cet écran (shop_id non FK, mais un job qui
  // pointe vers une caisse disparue ne doit pas survivre à la suppression).
  await run("DELETE FROM restore_jobs WHERE shop_id = $1", [shop.id]);
  await run("DELETE FROM admin_commands WHERE device_id = $1", [shop.device_id]);
  await run("DELETE FROM sync_payloads WHERE device_id = $1", [shop.device_id]);
  await run("DELETE FROM daily_stats WHERE device_id = $1", [shop.device_id]);
  await run("DELETE FROM activity_events WHERE shop_id = $1", [shop.id]);
  await run("DELETE FROM payment_events WHERE shop_id = $1", [shop.id]);
  await run("DELETE FROM device_blessings WHERE device_id = $1", [shop.device_id]);
  await run("DELETE FROM device_credentials WHERE device_id = $1", [shop.device_id]);
  await run("DELETE FROM shops WHERE id = $1", [shop.id]);
}

async function removeAccountRows(accountId, q) {
  const run = (sql, ...params) => (q ? q.query(sql, params) : db.run(sql, ...params));
  // Les ÉCRANS du compte partent avec lui. Sans cela, un écran survivait à son
  // compte : il n'appartenait à plus rien (son compte était effacé) et la console
  // l'affichait quand même comme une boutique — un fantôme, avec un compteur de
  // places inventé. La promesse faite à l'administrateur (« tout est effacé :
  // ventes, stock, historique ») vaut aussi pour les écrans.
  const shops = q
    ? (await q.query("SELECT id, device_id FROM shops WHERE account_id = $1", [accountId])).rows
    : await db.all("SELECT id, device_id FROM shops WHERE account_id = $1", [accountId]);
  for (const shop of shops) {
    await deleteShopRows(shop, run);
  }
  await run("DELETE FROM payments WHERE account_id = $1", [accountId]);
  await run("DELETE FROM admin_commands WHERE account_id = $1", [accountId]);
  await run("DELETE FROM subscription_requests WHERE account_id = $1", [accountId]);
  // FK NOT NULL vers accounts : les jobs de restauration du compte partent aussi,
  // sinon la suppression du compte échouait sur la contrainte.
  await run("DELETE FROM restore_jobs WHERE account_id = $1", [accountId]);
  await run("DELETE FROM activity_events WHERE account_id = $1", [accountId]);
  await run("DELETE FROM payment_events WHERE account_id = $1", [accountId]);
  await run("DELETE FROM device_blessings WHERE account_id = $1", [accountId]);
  await run("DELETE FROM device_credentials WHERE account_id = $1", [accountId]);
  // Les lignes SMS gardent leur valeur de preuve mais perdent la référence au compte.
  await run("UPDATE sms_payments SET matched_account_id = NULL WHERE matched_account_id = $1", [accountId]);
  await run("DELETE FROM accounts WHERE id = $1", [accountId]);
}

async function deleteAccountCompletely(accountId) {
  await removeAccountRows(accountId, null);
}

export async function deleteShop(deviceId) {
  const shop = await byDeviceId(deviceId);
  if (!shop) return null;
  const accountId = shop.account_id ?? null;
  await db.tx(async (client) => {
    const run = (sql, ...params) => client.query(sql, params);
    await deleteShopRows(shop, run);
    if (accountId) {
      const r = await client.query("SELECT COUNT(*) AS c FROM shops WHERE account_id = $1", [accountId]);
      if (Number(r.rows[0].c) === 0) await removeAccountRows(accountId, client);
    }
  });
  return shop;
}

// Références FK sûres pour un `logActivity` passé APRÈS une suppression : la fiche et
// son compte peuvent avoir disparu, et Postgres force les clés étrangères — un
// identifiant pendouillant ferait échouer l'INSERT. On ne référence ce qui existe
// encore (pour un écran multi-caisses, le compte survit ; la fiche, jamais).
async function aliveRefs(shopId, accountId) {
  return {
    shopId: shopId && (await db.get("SELECT id FROM shops WHERE id = $1", shopId)) ? shopId : null,
    accountId: accountId && (await accountById(accountId)) ? accountId : null,
  };
}

// Par l'administrateur (scope master, ou projet si la caisse y appartient).
router.delete("/api/v1/admin/shops/:device_id", requireAdmin, async (req, res) => {
  const device_id = str(req.params.device_id);
  const session = sessionOf(req);
  const shop = await byDeviceId(device_id);
  if (!shop) return res.status(404).json({ error: "Boutique introuvable." });
  if (session.scope === "project" && shop.app_origin !== session.project)
    return res.status(403).json({ error: "Boutique hors de ce projet." });
  await deleteShop(device_id);
  await logAdminAction(req, "shop", shop.id, "delete", str(req.body?.reason));
  const refs = await aliveRefs(shop.id, shop.account_id);
  await logActivity("error", "shop", "Boutique supprimée", `"${shop.store_name}" (${device_id}) par ${session.scope}`, { device_id, reason: str(req.body?.reason) ?? null }, refs.shopId, refs.accountId);
  console.log(
    `[${new Date().toISOString()}] BOUTIQUE SUPPRIMÉE "${shop.store_name}" (${device_id}) par ${session.scope}`,
  );
  res.json({ ok: true, device_id });
});

// Supprimer un compte marchand complet (boutique + tous ses écrans).
// Réservé à l'admin master (scope master), car c'est une action destructrice majeure.
router.delete("/api/v1/admin/accounts/:account_id", requireAdmin, async (req, res) => {
  if (sessionOf(req).scope !== "master") {
    return res.status(403).json({ error: "Réservé à l'administrateur principal." });
  }
  const account_id = Number(req.params.account_id);
  if (!Number.isFinite(account_id)) return res.status(400).json({ error: "ID compte invalide." });
  const account = await accountById(account_id);
  if (!account) return res.status(404).json({ error: "Compte introuvable." });
  await deleteAccountCompletely(account_id);
  await logAdminAction(req, "account", String(account_id), "delete", str(req.body?.reason));
  await logActivity("error", "account", "Compte marchand supprimé", `"${account.name}" (id=${account_id})`, { reason: str(req.body?.reason) ?? null }, null, account_id);
  console.log(`[${new Date().toISOString()}] COMPTE MARCHAND SUPPRIMÉ "${account.name}" (id=${account_id})`);
  res.json({ ok: true, account_id });
});

// Force-release de TOUS les appareils d'un compte (pour débloquer un client manuellement).
// Par la caisse elle-même, depuis Paramètres. Lien faible mais suffisant : elle prouve
// qu'elle connaît son device_id ET le nom de boutique que le serveur a enregistré.
router.delete("/api/v1/shops/:device_id", async (req, res) => {
  const device_id = str(req.params.device_id);
  const store_name = str(req.body?.store_name);
  const shop = await byDeviceId(device_id);
  if (!shop) return res.status(404).json({ error: "Boutique introuvable." });
  if (!store_name || store_name !== shop.store_name)
    return res.status(403).json({ error: "Le nom de la boutique ne correspond pas." });
  await deleteShop(device_id);
  console.log(
    `[${new Date().toISOString()}] BOUTIQUE SUPPRIMÉE "${shop.store_name}" (${device_id}) par la caisse elle-même`,
  );
  res.json({ ok: true, device_id });
});

// ── Demandes de suppression soumises par les écrans employés ───────────────────────
// Le vendeur cliquait « Supprimer mon compte » : on ne supprime RIEN d'office. Une
// demande est déposée ici ; le propriétaire l'approuve (« Supprimer » à côté de la
// demande dans le dashboard) ou la refuse. Même preuve d'identité que la suppression
// directe : device_id + nom de boutique connus du serveur. Une nouvelle demande du
// MÊME écran rend la précédente caduque ('superseded').
router.post("/api/v1/shops/:device_id/delete-request", async (req, res) => {
  const device_id = str(req.params.device_id);
  const store_name = str(req.body?.store_name);
  const shop = await byDeviceId(device_id);
  if (!shop) return res.status(404).json({ error: "Boutique introuvable." });
  if (!store_name || store_name !== shop.store_name)
    return res.status(403).json({ error: "Le nom de la boutique ne correspond pas." });

  const now = Date.now();
  await db.run(
    "UPDATE delete_requests SET status = 'superseded', decided_at = $1 WHERE device_id = $2 AND status = 'pending'",
    now,
    device_id,
  );
  const info = await db.get(
    "INSERT INTO delete_requests (device_id, store_name, reason, status, created_at) VALUES ($1, $2, $3, 'pending', $4) RETURNING id",
    device_id,
    shop.store_name,
    str(req.body?.reason),
    now,
  );
  const requestId = Number(info.id);
  await logActivity(
    "info",
    "device",
    "Demande de suppression d'un écran",
    `"${shop.store_name}" (${device_id})`,
    { device_id, delete_request_id: requestId },
    shop.id,
    shop.account_id,
  );
  console.log(
    `[${new Date().toISOString()}] DEMANDE DE SUPPRESSION déposée "${shop.store_name}" (${device_id}) par son écran`,
  );
  res.status(201).json({ ok: true, id: requestId });
});

router.get("/api/v1/admin/delete-requests", requireAdmin, async (req, res) => {
  const session = sessionOf(req);
  const status = str(req.query.status) || null;
  const params = status ? [status] : [];
  const rows = await db.all(
    `SELECT dr.*,
            s.owner_name AS owner_name,
            s.app_origin AS origin,
            s.account_id AS shop_account_id
     FROM delete_requests dr
     LEFT JOIN shops s ON s.device_id = dr.device_id
     ${status ? "WHERE dr.status = $1" : ""}
     ORDER BY dr.created_at DESC
     LIMIT 200`,
    ...params,
  );
  // Scope projet → les demandes de SES caisses uniquement.
  const list = rows.filter(
    (r) => session.scope !== "project" || r.origin === session.project,
  );
  res.json({ requests: list });
});

// Commande de purge locale adressée à l'écran (approved → suppression, rejected → rien).
async function notifyDevicePush(row, status, message) {
  await db.run(
    "INSERT INTO admin_commands (id, device_id, account_id, action_type, payload, expires_at, created_at) VALUES ($1, $2, NULL, 'delete_account_request', $3, $4, $5)",
    randomUUID(),
    row.device_id,
    JSON.stringify({ device_id: row.device_id, status, message: message || undefined }),
    Date.now() + COMMAND_TTL_MS,
    Date.now(),
  );
}

router.post("/api/v1/admin/delete-requests/:id/approve", requireAdmin, async (req, res) => {
  const requestId = Math.round(Number(req.params.id));
  const row = await db.get("SELECT * FROM delete_requests WHERE id = $1", requestId);
  if (!row) return res.status(404).json({ error: "Demande introuvable." });
  if (row.status !== "pending") return res.status(409).json({ error: "Demande déjà traitée." });
  const session = sessionOf(req);
  const shop = await byDeviceId(row.device_id);
  if (shop && session.scope === "project" && shop.app_origin !== session.project)
    return res.status(403).json({ error: "Caisse hors de ce projet." });
  if (!shop) return res.status(409).json({ error: "Cette caisse n'existe plus côté serveur." });

  const now = Date.now();
  // 1. Suppression serveur : la place qu'occupait l'écran se libère (le compte entier
  //    disparaît si c'était le dernier écran — comportement existant de deleteShop).
  const deleted = await deleteShop(row.device_id);
  // 2. Ordre à l'appareil (purge locale au consentement de l'employé au prochain
  //    handshake). Inséré APRÈS deleteShop : la fiche a déjà disparu, il survit.
  await notifyDevicePush(row, "approved", str(req.body?.message));
  const decidedBy = session.scope === "master" ? "master" : `projet:${session.project}`;
  await db.run(
    "UPDATE delete_requests SET status = 'approved', decided_at = $1, decided_by = $2 WHERE id = $3",
    now,
    decidedBy,
    requestId,
  );
  await logAdminAction(req, "request", String(requestId), "approve_delete", str(req.body?.reason));
  const refs = await aliveRefs(deleted?.id, deleted?.account_id);
  await logActivity(
    "warn",
    "device",
    "Suppression approuvée",
    `"${row.store_name}" (${row.device_id})`,
    { device_id: row.device_id, delete_request_id: requestId },
    refs.shopId,
    refs.accountId,
  );
  res.json({ ok: true, device_id: row.device_id });
});

router.post("/api/v1/admin/delete-requests/:id/reject", requireAdmin, async (req, res) => {
  const requestId = Math.round(Number(req.params.id));
  const row = await db.get("SELECT * FROM delete_requests WHERE id = $1", requestId);
  if (!row) return res.status(404).json({ error: "Demande introuvable." });
  if (row.status !== "pending") return res.status(409).json({ error: "Demande déjà traitée." });
  const session = sessionOf(req);
  const shop = await byDeviceId(row.device_id);
  if (shop && session.scope === "project" && shop.app_origin !== session.project)
    return res.status(403).json({ error: "Caisse hors de ce projet." });

  const now = Date.now();
  await notifyDevicePush(row, "rejected", str(req.body?.message));
  const decidedBy = session.scope === "master" ? "master" : `projet:${session.project}`;
  await db.run(
    "UPDATE delete_requests SET status = 'rejected', decided_at = $1, decided_by = $2 WHERE id = $3",
    now,
    decidedBy,
    requestId,
  );
  await logAdminAction(req, "request", String(requestId), "reject_delete", str(req.body?.reason));
  await logActivity(
    "info",
    "device",
    "Suppression refusée",
    `"${row.store_name}" (${row.device_id})`,
    { device_id: row.device_id, delete_request_id: requestId },
    shop?.id ?? null,
    shop?.account_id ?? null,
  );
  res.json({ ok: true, device_id: row.device_id });
});

// ── Liste publique des projets (id + nom seulement) : sert au sélecteur du login. ──
// Aucune donnée sensible : pas de mot de passe, pas de compteurs.
router.get("/api/v1/public/projects", async (_req, res) => {
  res.json({
    projects: await db.all("SELECT id, name FROM projects ORDER BY name ASC"),
  });
});

// ── Vue de bord « atterrissage » : boutiques + rentrée Elyndra ───────────────────
// Toute la matière du dashboard d'accueil, agrégée en une seule réponse : les compteurs
// de boutiques (actives, en ligne/hors ligne, suspendues, expirées) et — pour CHAQUE
// caisse — son plan d'abonnement, ses écrans, son CA du mois réel (accumulé daily_stats)
// et le revenu que sa souscription rapporte à Elyndra. Scopé au projet comme /admin/stats.
router.get("/api/v1/admin/storefront", requireAdmin, async (req, res) => {
  const session = sessionOf(req);
  const origin = session.scope === "project" ? session.project : str(req.query.project) || null;
  const now = Date.now();
  const shops = await listShops(origin);
  const rows = await db.all("SELECT * FROM accounts WHERE merged_into IS NULL");
  const accounts = [];
  for (const a of rows) {
    if (await accountOriginOk(a, origin)) accounts.push(a);
  }

  // Le CA des boutiques n'est PLUS calculé ici : il reste sur les téléphones des
  // clients (l'orchestrateur ne stocke plus les ventes — cf. entry.mjs / sync-data).
  // Les champs `ca_*` restent dans le contrat de la réponse, à zéro.
  const monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime(); // minuit local du 1er

  // Une LIGNE PAR COMMERCE. Le téléphone d'un employé est un poste de la boutique de son
  // patron, pas une boutique : on regroupait les écrans et tout ce qui suit — compteurs,
  // CA, revenu Elyndra — comptait un commerce trois fois quand il a trois écrans.
  const shopRows = await Promise.all(
    groupShopsByAccount(shops).map(async (group) => {
      // Les écrans PARTIS (place libérée) ne sont plus des écrans du commerce : ils
      // restent dans l'historique — leur CA continue de compter — mais ils ne
      // consomment pas de place et ne s'affichent plus comme écrans actifs.
      const actifs = group.devices.filter((d) => !d.released_at);
      const devices = actifs.length > 0 ? actifs : group.devices;
      const premier = devices[0];
      const account = group.account_id ? await accountById(group.account_id) : null;
      const inscrites = account ? await accountDevices(account.id) : null;
      // Un commerce est « hors quota » quand ses écrans dépassent les places payées.
      const overLimit = account
        ? inscrites.length > account.max_devices
        : false;
      // Nom commercial dérivé du PALIER facturé (cf. PRICE_TIERS), pas du nombre d'écrans
      // exact : un compte à 10 000 F/mois est « Essentiel » même avec 2 écrans inscrits.
      const paid = account ? priceForDevices(account.max_devices) : null;
      const tierAtPrice = PRICE_TIERS.find((t) => t.price === paid);
      const plan = account
        ? planNameForDevices(tierAtPrice ? tierAtPrice.devices : account.max_devices) ?? "Sur mesure"
        : null;
      const online = devices.some(
        (d) => d.last_sync_at && now - d.last_sync_at < ONLINE_WINDOW_MS,
      );
      const lastSyncAt = devices.reduce(
        (max, d) => (d.last_sync_at && d.last_sync_at > max ? d.last_sync_at : max),
        0,
      );
      return {
        // `device_id` : le premier écran du commerce — la fiche détail reste par écran,
        // c'est la clé stable dont le dashboard se sert pour le drill-down.
        device_id: premier.device_id,
        store_name: account?.name ?? premier.store_name,
        owner_name: account?.owner_name || premier.owner_name,
        phone: account?.phone ?? premier.phone ?? null,
        last_sync_at: lastSyncAt || null,
        online,
        status: overLimit
          ? "over_limit"
          : account
            ? computeAccountStatus(account)
            : computeStatus(premier),
        account_id: account?.id ?? null,
        account_name: account?.name ?? null,
        // Le LIEU du commerce : le quartier du compte (c'est lui qui est quelque part),
        // à défaut la localisation déclarée par l'écran.
        location: (account?.quarter ?? premier.location ?? "").trim() || null,
        // L'abonnement du compte : places achetées, écrans réellement inscrits et revenu
        // mensuel que cette souscription rapporte à Elyndra.
        plan_name: plan,
        plan_price_fcfa: paid,
        device_count: devices.length,
        registered_devices: inscrites?.length ?? devices.length,
        max_devices: account?.max_devices ?? 1,
        over_limit: overLimit,
        // Le CA du commerce n'est plus connu de l'orchestrateur (il reste sur les
        // téléphones) : les champs subsistent dans le contrat, à zéro.
        ca_today_fcfa: 0,
        ca_month_fcfa: 0,
        ca_30d_fcfa: 0,
        elyndra_month_fcfa: paid ?? 0,
        // Les écrans du commerce, pour les voir sans compter autant de boutiques.
        devices: devices.map((d) => ({
          device_id: d.device_id,
          store_name: d.store_name,
          owner_name: d.owner_name,
          online: !!(d.last_sync_at && now - d.last_sync_at < ONLINE_WINDOW_MS),
          status: computeStatus(d),
          last_sync_at: d.last_sync_at ?? null,
          app_version_used: d.app_version_used ?? null,
        })),
      };
    }),
  );

  // KPI — l'unité est le COMMERCE. `employees` reste, lui, un compteur d'ÉCRANS : c'est
  // exactement ce qu'il doit dire (le nombre de postes occupés au-delà du fondateur).
  const statusCount = { active: 0, grace: 0, suspended: 0, expired: 0 };
  for (const r of shopRows) statusCount[r.status] = (statusCount[r.status] ?? 0) + 1;
  let employes = 0;
  for (const a of accounts) {
    const n = (await accountDevices(a.id)).length;
    if (n > 1) employes += n - 1;
  }
  const enLigne = shopRows.filter((r) => r.online).length;
  const kpi = {
    boutique_total: shopRows.length,
    boutique_active: statusCount.active,
    en_ligne: enLigne,
    hors_ligne: shopRows.length - enLigne,
    en_grace: statusCount.grace,
    suspendues: statusCount.suspended,
    expirees: statusCount.expired,
    employees: employes,
    // Écrans, pour ne plus avoir à les déduire du nombre de boutiques.
    devices_total: shops.length,
  };

  // Rentrée Elyndra. `mois_encaisse` = paiements reçus depuis le 1er du mois civil
  // (même convention que l'overview existant : non scopés par projet — la table payments
  // ne porte pas d'app_origin). `mrr` = ce que le portefeuille du périmètre rapporte
  // chaque mois si tous les abonnements sont renouvelés.
  const elyndraMois = (await db.get("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE created_at >= $1", monthStart)).s;
  const subs = await computeSubscriptions(accounts);
  const elyndra = {
    mois_encaisse: elyndraMois,
    ca_boutiques_mois: 0,
    mrr_fcfa: subs.mrr_fcfa,
    arr_fcfa: subs.mrr_fcfa * 12,
  };

  // Répartition par LIEU : d'où viennent les commerces. Le quartier du compte prime
  // (c'est le commerce qui est quelque part) ; à défaut, la localisation déclarée
  // par l'écran. Sans information : « Non renseigné » — jamais un lieu inventé.
  const parLieu = new Map();
  for (const row of shopRows) {
    const lieu = (row.location ?? "").trim() || "Non renseigné";
    parLieu.set(lieu, (parLieu.get(lieu) ?? 0) + 1);
  }

  res.json({
    generated_at: now,
    project: origin,
    kpi,
    elyndra,
    par_lieu: [...parLieu.entries()]
      .map(([lieu, count]) => ({ lieu, count }))
      .sort((a, b) => b.count - a.count || a.lieu.localeCompare(b.lieu, "fr")),
    shops: shopRows.sort(
      (a, b) => b.ca_month_fcfa - a.ca_month_fcfa || a.store_name.localeCompare(b.store_name, "fr"),
    ),
  });
});

// ── Protocole v2 : gestion des projets (master uniquement) ────────────────────────
router.get("/api/v1/admin/projects", requireMaster, async (_req, res) => {
  const projects = (await db.all(
    `SELECT p.id, p.name, p.created_at, p.type, p.price_per_month_fcfa, p.trial_days,
            (SELECT COUNT(*) FROM shops s WHERE s.app_origin = p.id) AS shop_count
     FROM projects p ORDER BY p.created_at ASC`,
  )).map((p) => ({ ...p, from_manifest: manifests.has(p.id) }));
  res.json({ projects });
});

router.post("/api/v1/admin/projects", requireMaster, async (req, res) => {
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
  if (await projectById(id))
    return res.status(409).json({ error: "Ce projet existe déjà." });
  await db.run(
    `INSERT INTO projects (id, name, password, created_at, type, price_per_month_fcfa, trial_days)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    id,
    name,
    password,
    Date.now(),
    type,
    Number.isFinite(price) && price > 0 ? price : null,
    Number.isFinite(trial) && trial > 0 ? trial : null,
  );
  res.status(201).json({ project: await projectById(id) });
});

router.post("/api/v1/admin/projects/:id/password", requireMaster, async (req, res) => {
  const password = str(req.body?.password);
  const proj = await projectById(str(req.params.id));
  if (!proj) return res.status(404).json({ error: "Projet introuvable." });
  if (!password) return res.status(400).json({ error: "password requis." });
  await db.run("UPDATE projects SET password = $1 WHERE id = $2", password, proj.id);
  await logAdminAction(req, "project", proj.id, "change_password", null);
  await logActivity("warn", "project", "Mot de passe modifié", `"${proj.name}"`, { project_id: proj.id }, null, null, proj.id);
  res.json({ ok: true });
});

// Tarif / essai / type d'un projet — pilote la facturation (montant → jours) et la
// durée d'essai appliquée aux nouvelles caisses. Vide un champ pour repasser au défaut.
router.post("/api/v1/admin/projects/:id/config", requireMaster, async (req, res) => {
  const proj = await projectById(str(req.params.id));
  if (!proj) return res.status(404).json({ error: "Projet introuvable." });
  const type = str(req.body?.type) || null;
  const price = Math.round(Number(req.body?.price_per_month_fcfa));
  const trial = Math.round(Number(req.body?.trial_days));
  await db.run(
    `UPDATE projects SET type = $1, price_per_month_fcfa = $2, trial_days = $3 WHERE id = $4`,
    type,
    Number.isFinite(price) && price > 0 ? price : null,
    Number.isFinite(trial) && trial > 0 ? trial : null,
    proj.id,
  );
  await logAdminAction(req, "project", proj.id, "change_config", null);
  await logActivity("info", "project", "Configuration modifiée", `"${proj.name}"`, { project_id: proj.id }, null, null, proj.id);
  res.json({ ok: true, project: await projectById(proj.id) });
});

// ── Rétrocompat : routes de l'ancien server.mjs (builds déjà installées) ──────────
router.post("/api/shops", async (req, res) => {
  const result = await upsertShop({ ...req.body, app_version_used: undefined });
  if (result.status !== 200) return res.status(400).json(result.shop);
  // Rattrapage : la fiche rejoint (ou crée) son compte — aucun écran orphelin.
  const shop = await attachAccountForLegacy(result.shop);
  // L'échéance renvoyée fait foi : l'app s'y aligne (cf. sync.ts côté app).
  res.json({ shop });
});

router.get("/api/shops", requireAdmin, async (_req, res) => {
  res.json({ shops: await listShops() });
});

router.get("/api/shops/:id/payments", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || !(await byId(id)))
    return res.status(404).json({ error: "Boutique introuvable." });
  res.json({
    payments: await db.all("SELECT * FROM payments WHERE shop_id = $1 ORDER BY created_at DESC", id),
  });
});

router.post("/api/shops/:id/extend", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const shop = await byId(id);
  if (!shop) return res.status(404).json({ error: "Boutique introuvable." });
  const amount = Math.round(Number(req.body?.amount_fcfa));
  if (!Number.isFinite(amount) || amount <= 0)
    return res.status(400).json({ error: "Montant invalide." });
  const days = Math.max(1, Math.round((amount / PRICE_PER_MONTH_FCFA) * 30));
  const now = Date.now();
  // La prolongation vise le COMPTE de la fiche : c'est son échéance qui recule, puis le
  // miroir met les fiches à jour. Formule tarifaire historique conservée pour cette
  // route legacy.
  const attached = await attachAccountForLegacy(shop);
  const account = attached?.account_id ? await accountById(attached.account_id) : null;
  const base = account ? Math.max(now, account.expiry_date) : Math.max(now, shop.expiry_date);
  const next = base + days * DAY_MS;
  await db.tx(async (client) => {
    if (account) {
      await client.query(
        "UPDATE accounts SET suspended_at = NULL, expiry_date = $1, updated_at = $2 WHERE id = $3",
        [next, now, account.id],
      );
      await syncShopsFromAccount(account.id);
    } else {
      await client.query(
        "UPDATE shops SET suspended_at = NULL, expiry_date = $1, updated_at = $2 WHERE id = $3",
        [next, now, id],
      );
    }
    await client.query(
      "INSERT INTO payments (shop_id, account_id, amount, days_added, created_at) VALUES ($1, $2, $3, $4, $5)",
      [id, account?.id ?? null, amount, days, now],
    );
  });
  res.json({ shop: await byId(id) });
});

export default router;