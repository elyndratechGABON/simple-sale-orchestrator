// Routes du Control Center Elyndra — vues globales : overview, clients, boutiques,
// appareils, sync, activité, audit, paiements, actions sur clients/abonnements.
import { Router } from "express";
import { randomUUID } from "node:crypto";
import {
  db,
  DAY_MS,
  ONLINE_WINDOW_MS,
  COMMAND_TTL_MS,
  PRICE_TIERS,
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
  computeSubscriptions,
  aggregateStats,
  resolveAccount,
} from "../lib.mjs";
import {
  sessionOf,
  requireAdmin,
  requireMaster,
} from "./auth.mjs";
import { logAdminAction, logActivity, upsertPaymentEvent } from "./audit.mjs";
import { deleteShop } from "./admin.mjs";

const router = Router();

// ── Vue globale (vue globale du Control Center) ────────────────────────────────────
// Agrège en une seule réponse : KPI business (revenu Elyndra vs CA boutique), état système,
// projets. Distinct des routes existantes — ne casse aucune vue dashboard existante.
router.get("/api/v1/admin/overview", requireAdmin, (req, res) => {
  const session = sessionOf(req);
  const origin = session.scope === "project" ? session.project : str(req.query.project) || null;
  const now = Date.now();

  const shops = listShops(origin);
  const accounts = db
    .prepare("SELECT * FROM accounts WHERE merged_into IS NULL")
    .all()
    .filter((a) => accountOriginOk(a, origin));

  const subscriptions = computeSubscriptions(accounts);
  const stats = aggregateStats(shops);

  // Revenu Elyndra = somme des paiements (abonnements) sur la période
  const revenueToday = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE created_at >= ?").get(now - DAY_MS).s;
  const revenueWeek = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE created_at >= ?").get(now - 7 * DAY_MS).s;
  const revenueMonth = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE created_at >= ?").get(now - 30 * DAY_MS).s;
  const revenueYear = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE created_at >= ?").get(now - 365 * DAY_MS).s;

  // Paiements du mois courant
  const monthStart = new Date(now).getDate() === 1
    ? now
    : new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const paymentsMonth = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE created_at >= ?").get(monthStart).s;

  // Paiements en attente (SMS unmatched + requests pending)
  const pendingSms = db.prepare("SELECT COUNT(*) AS c FROM sms_payments WHERE status IN ('pending','unmatched')").get().c;
  const pendingRequests = db.prepare("SELECT COUNT(*) AS c FROM subscription_requests WHERE status = 'pending'").get().c;
  const pendingPayments = pendingSms + pendingRequests;

  // Clients (comptes) — nouveau aujourd'hui, actifs
  const newToday = accounts.filter((a) => a.created_at >= now - DAY_MS).length;

  // Appareils connectés
  const connectedDevices = shops.filter(
    (s) => s.last_sync_at && now - s.last_sync_at < ONLINE_WINDOW_MS,
  ).length;

  // Paiements confirmés (événements de paiement validés)
  const confirmedPayments = db.prepare(
    origin
      ? "SELECT COUNT(*) AS c FROM payment_events WHERE status = 'confirmed' AND created_at >= ? AND account_id IN (SELECT id FROM accounts WHERE merged_into IS NULL)"
      : "SELECT COUNT(*) AS c FROM payment_events WHERE status = 'confirmed'",
  ).get().c;

  // Paiements en attente (payment_events pending)
  const pendingEventPayments = db.prepare("SELECT COUNT(*) AS c FROM payment_events WHERE status = 'pending'").get().c;

  // Revenus récurrents = MRR × 1 mois (revenu mensuel récurrent)
  const recurringRevenue = subscriptions.mrr_fcfa;

  // CA boutique sur 7 jours (fenêtre glissante réelle, indépendante de l'agrégat sync)
  const shopWeek = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE created_at >= ?").get(now - 7 * DAY_MS).s;

  res.json({
    generated_at: now,
    // — KPI Cards —
    kpi: {
      revenue_today: revenueToday,
      revenue_week: revenueWeek,
      revenue_month: revenueMonth,
      revenue_year: revenueYear,
      clients: accounts.length,
      clients_new_today: newToday,
      shops: shops.length,
      shops_active: shops.filter((s) => computeStatus(s) === "active").length,
      subscriptions_active: subscriptions.active,
      subscriptions_expired: subscriptions.expired,
      devices_connected: connectedDevices,
      devices_total: shops.length,
      payments_month: paymentsMonth,
      payments_confirmed: confirmedPayments,
      payments_pending: pendingPayments + pendingEventPayments,
      mrr: subscriptions.mrr_fcfa,
      arr: subscriptions.mrr_fcfa * 12,
    },
    // — Business séparé : revenu Elyndra vs CA boutique —
    business: {
      elyndra_revenue: {
        today: revenueToday,
        week: revenueWeek,
        month: revenueMonth,
        year: revenueYear,
        mrr: subscriptions.mrr_fcfa,
        arr: subscriptions.mrr_fcfa * 12,
      },
      shop_revenue: {
        today: stats.totals.revenue,
        week: shopWeek,
        month: stats.totals.revenue, // keep as-is (sync_payloads = last 7j aggregate)
        year: stats.totals.revenue,
        total_revenue: stats.totals.revenue,
        total_sales: stats.totals.sales,
        total_profit: stats.totals.profit,
      },
    },
    subscriptions,
    shop_stats: stats,
  });
});

// ── Clients (comptes) — liste unifiée ─────────────────────────────────────────────
router.get("/api/v1/admin/clients", requireAdmin, (req, res) => {
  const session = sessionOf(req);
  const origin = session.scope === "project" ? session.project : str(req.query.project) || null;
  const now = Date.now();

  const accounts = db
    .prepare("SELECT * FROM accounts WHERE merged_into IS NULL ORDER BY created_at DESC")
    .all()
    .filter((a) => accountOriginOk(a, origin))
    .map((a) => {
      const devices = accountDevices(a.id);
      const shops = devices;
      // Prochain paiement = prochaine échéance
      return {
        id: a.id,
        name: a.name,
        owner_name: a.owner_name,
        phone: a.phone ?? null,
        email: a.email ?? null,
        max_devices: a.max_devices,
        expiry_date: a.expiry_date,
        suspended_at: a.suspended_at ?? null,
        status: computeAccountStatus(a),
        monthly_price_fcfa: priceForDevices(a.max_devices),
        online: devices.some((d) => d.last_sync_at && now - d.last_sync_at < ONLINE_WINDOW_MS),
        device_count: devices.length,
        shop_count: devices.length,
        last_activity: Math.max(...devices.map((d) => d.last_sync_at ?? 0), 0) || null,
        next_payment: a.expiry_date,
        created_at: a.created_at,
        devices: devices.map((d) => ({
          device_id: d.device_id,
          store_name: d.store_name,
          app_version_used: d.app_version_used ?? null,
          last_sync_at: d.last_sync_at ?? null,
          status: d.suspended_at ? "suspended" : computeStatus(d),
        })),
      };
    });

  res.json({ clients: accounts });
});

// ── Fiche client détaillée ────────────────────────────────────────────────────────
router.get("/api/v1/admin/clients/:id", requireAdmin, (req, res) => {
  const account = accountById(Number(req.params.id));
  if (!account) return res.status(404).json({ error: "Client introuvable." });
  const session = sessionOf(req);
  if (!accountOriginOk(account, session.scope === "project" ? session.project : null))
    return res.status(403).json({ error: "Client hors de ce projet." });

  const now = Date.now();
  const devices = accountDevices(account.id);

  // Historique des paiements du compte (account_id + legacy shop payments)
  const shopIds = devices.map((d) => d.id);
  const legacyPayments = shopIds.length
    ? db.prepare(`SELECT * FROM payments WHERE account_id IS NULL AND shop_id IN (${shopIds.map(() => "?").join(",")})`).all(...shopIds)
    : [];
  const payments = db
    .prepare("SELECT * FROM payments WHERE account_id = ? ORDER BY created_at DESC")
    .all(account.id)
    .concat(legacyPayments.sort((a, b) => b.created_at - a.created_at));

  // Historique des paiement events
  const paymentEvents = db
    .prepare("SELECT * FROM payment_events WHERE account_id = ? ORDER BY received_at DESC LIMIT 50")
    .all(account.id);

  // Historique des abonnements (événements paiement = changements de palier)
  const subscriptionHistory = paymentEvents.map((pe) => ({
    id: pe.id,
    amount: pe.amount,
    provider: pe.provider,
    reference: pe.reference,
    status: pe.status,
    source: pe.source,
    received_at: pe.received_at,
    confirmed_at: pe.confirmed_at ?? null,
    note: pe.note ?? null,
  }));

  // Historique des ordres admin
  const commands = db
    .prepare(
      `SELECT id, action_type, payload, expires_at, created_at, delivered_at, superseded_at
       FROM admin_commands WHERE account_id = ? ORDER BY created_at DESC LIMIT 50`,
    )
    .all(account.id)
    .map((c) => ({ ...c, payload: JSON.parse(c.payload) }));

  // Activité récente (last sync, etc.)
  const activity = devices
    .filter((d) => d.last_sync_at)
    .map((d) => ({
      type: "sync",
      store_name: d.store_name,
      device_id: d.device_id,
      last_sync_at: d.last_sync_at,
    }))
    .sort((a, b) => b.last_sync_at - a.last_sync_at)
    .slice(0, 10);

  // Dernière demande d'abonnement
  const lastRequest = db
    .prepare(
      `SELECT status, plan_price, plan_devices, reference, created_at, decided_at, decided_by
       FROM subscription_requests WHERE account_id = ? AND status != 'superseded'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(account.id);

  res.json({
    client: {
      id: account.id,
      name: account.name,
      owner_name: account.owner_name,
      phone: account.phone ?? null,
      email: account.email ?? null,
      max_devices: account.max_devices,
      expiry_date: account.expiry_date,
      suspended_at: account.suspended_at ?? null,
      status: computeAccountStatus(account),
      monthly_price_fcfa: priceForDevices(account.max_devices),
      keyword: account.keyword ?? null,
      created_at: account.created_at,
      updated_at: account.updated_at,
    },
    subscription: {
      plan_price: priceForDevices(account.max_devices),
      max_devices: account.max_devices,
      start_date: account.created_at,
      expiry_date: account.expiry_date,
      status: computeAccountStatus(account),
      days_left: Math.ceil((account.expiry_date - now) / DAY_MS),
      history: subscriptionHistory,
      last_request: lastRequest ?? null,
    },
    shops: devices.map((d) => ({
      id: d.id,
      device_id: d.device_id,
      store_name: d.store_name,
      owner_name: d.owner_name,
      phone: d.phone ?? null,
      location: d.location ?? null,
      app_version_used: d.app_version_used ?? null,
      app_origin: d.app_origin ?? "pos",
      last_sync_at: d.last_sync_at ?? null,
      registration_date: d.registration_date,
      status: d.suspended_at ? "suspended" : computeStatus(d),
      payments: db.prepare("SELECT COUNT(*) AS c FROM payments WHERE shop_id = ?").get(d.id).c,
    })),
    payments: {
      total_paid: payments.reduce((n, p) => n + p.amount, 0),
      last_payment: payments.length > 0 ? payments[0] : null,
      history: payments.slice(0, 50),
    },
    payment_events: paymentEvents,
    commands: commands,
    activity: activity,
  });
});

// ── Boutiques — liste + fiche détaillée ───────────────────────────────────────────
router.get("/api/v1/admin/shops-detail", requireAdmin, (req, res) => {
  const session = sessionOf(req);
  const origin = session.scope === "project" ? session.project : str(req.query.project) || null;
  const now = Date.now();

  const shops = listShops(origin).map((s) => {
    const account = s.account_id ? accountById(s.account_id) : null;
    const resolvedAccount = account ? resolveAccount(account) : null;
    return {
      id: s.id,
      device_id: s.device_id,
      store_name: s.store_name,
      owner_name: s.owner_name,
      phone: s.phone ?? null,
      location: s.location ?? null,
      registration_date: s.registration_date,
      expiry_date: s.expiry_date,
      suspended_at: s.suspended_at ?? null,
      app_version_used: s.app_version_used ?? null,
      app_origin: s.app_origin ?? "pos",
      last_sync_at: s.last_sync_at ?? null,
      account_id: s.account_id ?? null,
      account_name: resolvedAccount?.name ?? null,
      status: computeStatus(s),
      payments: s.payments,
      online: s.last_sync_at ? now - s.last_sync_at < ONLINE_WINDOW_MS : false,
    };
  });

  res.json({ shops });
});

// ── Fiche boutique détaillée ───────────────────────────────────────────────────────
router.get("/api/v1/admin/shops-detail/:device_id", requireAdmin, (req, res) => {
  const device_id = str(req.params.device_id);
  const session = sessionOf(req);
  const shop = byDeviceId(device_id);
  if (!shop) return res.status(404).json({ error: "Boutique introuvable." });
  if (session.scope === "project" && shop.app_origin !== session.project)
    return res.status(403).json({ error: "Boutique hors de ce projet." });

  const now = Date.now();
  const account = shop.account_id ? resolveAccount(accountById(shop.account_id)) : null;

  const payments = db.prepare("SELECT * FROM payments WHERE shop_id = ? ORDER BY created_at DESC").all(shop.id);
  const commands = db
    .prepare(
      `SELECT id, action_type, payload, expires_at, created_at, delivered_at, superseded_at
       FROM admin_commands WHERE device_id = ? ORDER BY created_at DESC LIMIT 30`,
    )
    .all(device_id)
    .map((c) => ({ ...c, payload: JSON.parse(c.payload) }));

  // CA de la boutique (depuis sync_payloads agrégés)
  const syncRows = db
    .prepare(
      `SELECT sp.payload, sp.received_at
       FROM sync_payloads sp
       WHERE sp.device_id = ?
       ORDER BY sp.received_at DESC LIMIT 1`,
    )
    .all(device_id);

  let shopStats = null;
  if (syncRows.length > 0) {
    try {
      const p = JSON.parse(syncRows[0].payload);
      shopStats = {
        last_sync_at: syncRows[0].received_at,
        totals: p.totals ?? { revenue: 0, profit: 0, sales: 0, items: 0, customers: 0 },
        top_products: Array.isArray(p.top_products) ? p.top_products : [],
        by_day: Array.isArray(p.by_day) ? p.by_day : [],
      };
    } catch {
      shopStats = null;
    }
  }

  res.json({
    shop: {
      id: shop.id,
      device_id: shop.device_id,
      store_name: shop.store_name,
      owner_name: shop.owner_name,
      phone: shop.phone ?? null,
      location: shop.location ?? null,
      registration_date: shop.registration_date,
      expiry_date: shop.expiry_date,
      suspended_at: shop.suspended_at ?? null,
      app_version_used: shop.app_version_used ?? null,
      app_origin: shop.app_origin ?? "pos",
      last_sync_at: shop.last_sync_at ?? null,
      account_id: shop.account_id ?? null,
      status: computeStatus(shop),
      online: shop.last_sync_at ? now - shop.last_sync_at < ONLINE_WINDOW_MS : false,
    },
    account: account ? publicAccount(account) : null,
    payments,
    commands,
    stats: shopStats,
  });
});

// ── Appareils (vue détaillée des shops) ───────────────────────────────────────────
router.get("/api/v1/admin/devices", requireAdmin, (req, res) => {
  const session = sessionOf(req);
  const origin = session.scope === "project" ? session.project : str(req.query.project) || null;
  const now = Date.now();

  const shops = listShops(origin);
  const devices = shops.map((s) => {
    const status = computeStatus(s);
    return {
      device_id: s.device_id,
      store_name: s.store_name,
      owner_name: s.owner_name,
      phone: s.phone ?? null,
      shop_id: s.id,
      account_id: s.account_id ?? null,
      app_origin: s.app_origin ?? "pos",
      role: s.account_id ? "linked" : "unlinked",
      status: s.last_sync_at && now - s.last_sync_at < ONLINE_WINDOW_MS ? "online" : "offline",
      last_sync_at: s.last_sync_at ?? null,
      app_version_used: s.app_version_used ?? null,
      registration_date: s.registration_date,
      expiry_date: s.expiry_date,
      suspended_at: s.suspended_at ?? null,
      sync_pending: db.prepare("SELECT COUNT(*) AS c FROM admin_commands WHERE device_id = ? AND delivered_at IS NULL AND superseded_at IS NULL").get(s.device_id).c,
    };
  });

  const summary = {
    total: devices.length,
    online: devices.filter((d) => d.status === "online").length,
    offline: devices.filter((d) => d.status === "offline").length,
    sync_pending: devices.filter((d) => d.last_sync_at === null).length,
    versions: (() => {
      const versions = {};
      for (const d of devices) {
        const v = d.app_version_used ?? "unknown";
        versions[v] = (versions[v] ?? 0) + 1;
      }
      return versions;
    })(),
  };

  res.json({ devices, summary });
});

// ── Synchronisation — état des syncs ────────────────────────────────────────────
router.get("/api/v1/admin/sync", requireAdmin, (req, res) => {
  const session = sessionOf(req);
  const origin = session.scope === "project" ? session.project : str(req.query.project) || null;
  const now = Date.now();

  const shops = listShops(origin);

  // Dernières synchronisations
  const lastSyncs = db
    .prepare(
      `SELECT sp.device_id, sp.app_origin, sp.received_at, sp.payload
       FROM sync_payloads sp
       JOIN (SELECT device_id, MAX(received_at) AS m FROM sync_payloads GROUP BY device_id) t
         ON sp.device_id = t.device_id AND sp.received_at = t.m
       ${origin ? "WHERE sp.app_origin = ?" : ""}
       ORDER BY sp.received_at DESC`,
    )
    .all(...(origin ? [origin] : []));

  const connectedDevices = shops.filter(
    (s) => s.last_sync_at && now - s.last_sync_at < ONLINE_WINDOW_MS,
  ).length;

  const syncStatus = shops.map((s) => {
    const lastSync = s.last_sync_at;
    const recentSyncs = db.prepare("SELECT COUNT(*) AS c FROM sync_payloads WHERE device_id = ?").get(s.device_id).c;
    const isOnline = lastSync && now - lastSync < ONLINE_WINDOW_MS;
    return {
      device_id: s.device_id,
      store_name: s.store_name,
      app_origin: s.app_origin ?? "pos",
      status: isOnline ? "online" : lastSync ? "offline" : "never",
      last_sync_at: lastSync ?? null,
      operations_count: recentSyncs,
      pending: db.prepare("SELECT COUNT(*) AS c FROM admin_commands WHERE device_id = ? AND delivered_at IS NULL AND superseded_at IS NULL").get(s.device_id).c,
      errors: 0,
    };
  });

  res.json({
    connected: connectedDevices,
    total: shops.length,
    status: syncStatus,
    recent_syncs: lastSyncs.map((s) => ({
      device_id: s.device_id,
      app_origin: s.app_origin,
      received_at: s.received_at,
    })),
    // Opérations en attente (commandes non livrées)
    pending_commands: db
      .prepare(
        `SELECT COUNT(*) AS c FROM admin_commands WHERE delivered_at IS NULL AND superseded_at IS NULL AND expires_at > ?
         ${origin ? "AND (SELECT app_origin FROM shops WHERE shops.device_id = admin_commands.device_id) = ?" : ""}`,
      )
      .get(...(origin ? [now, origin] : [now])).c,
  });
});

// ── Activité / timeline ───────────────────────────────────────────────────────────
router.get("/api/v1/admin/activity", requireAdmin, (req, res) => {
  const session = sessionOf(req);
  const origin = session.scope === "project" ? session.project : str(req.query.project) || null;
  const limit = Math.min(100, Math.max(10, Math.round(Number(req.query.limit)) || 50));

  // Filtres optionnels : catégorie et niveau
  const category = str(req.query.category);
  const level = str(req.query.level);

  const conditions = [];
  const args = [];
  if (origin) {
    conditions.push("(project_id = ? OR shop_id IN (SELECT id FROM shops WHERE app_origin = ?))");
    args.push(origin, origin);
  }
  if (category) {
    conditions.push("category = ?");
    args.push(category);
  }
  if (level) {
    conditions.push("level = ?");
    args.push(level);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = db
    .prepare(`SELECT * FROM activity_events ${where} ORDER BY created_at DESC LIMIT ?`)
    .all(...args, limit);

  const events = rows.map((r) => ({
    id: r.id,
    level: r.level,
    category: r.category,
    title: r.title,
    detail: r.detail ?? null,
    data: r.data ? JSON.parse(r.data) : null,
    shop_id: r.shop_id,
    account_id: r.account_id,
    project_id: r.project_id,
    created_at: r.created_at,
  }));

  res.json({ events });
});

// ── Audit log ──────────────────────────────────────────────────────────────────────
router.get("/api/v1/admin/audit", requireMaster, (req, res) => {
  const limit = Math.min(200, Math.max(10, Math.round(Number(req.query.limit)) || 100));
  const targetType = str(req.query.target_type);
  const rows = db
    .prepare(
      `SELECT * FROM admin_actions
       ${targetType ? "WHERE target_type = ?" : ""}
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...(targetType ? [targetType, limit] : [limit]));

  res.json({ actions: rows });
});

// ── Paiements (vue unifiée payments + sms_payments + payment_events) ───────────────
router.get("/api/v1/admin/payments-view", requireAdmin, (req, res) => {
  const session = sessionOf(req);
  const origin = session.scope === "project" ? session.project : str(req.query.project) || null;
  const now = Date.now();
  const d = new Date();
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const todayStart = now - DAY_MS;

  // Paiements legacy (table payments)
  const shopIds = origin
    ? db.prepare("SELECT id FROM shops WHERE app_origin = ?").all(origin).map((s) => s.id)
    : null;

  const shopFilter = shopIds ? `AND shop_id IN (${shopIds.map(() => "?").join(",")})` : "";
  const shopArgs = shopIds ? shopIds : [];

  let legacyPayments;
  if (origin) {
    legacyPayments = db
      .prepare(
        `SELECT p.*, s.store_name, s.device_id FROM payments p
         JOIN shops s ON p.shop_id = s.id
         WHERE s.app_origin = ?
         ORDER BY p.created_at DESC LIMIT 200`,
      )
      .all(origin);
  } else {
    legacyPayments = db
      .prepare(
        `SELECT p.*, s.store_name, s.device_id FROM payments p
         LEFT JOIN shops s ON p.shop_id = s.id
         ORDER BY p.created_at DESC LIMIT 200`,
      )
      .all();
  }

  // Payment events (unifiés)
  const eventRows = db
    .prepare(
      `SELECT pe.*, a.name AS account_name, s.store_name
       FROM payment_events pe
       LEFT JOIN accounts a ON pe.account_id = a.id
       LEFT JOIN shops s ON pe.shop_id = s.id
       ORDER BY pe.received_at DESC LIMIT 100`,
    )
    .all();

  // SMS payments
  const smsRows = db.prepare("SELECT * FROM sms_payments ORDER BY received_at DESC LIMIT 100").all();

  // Totaux
  const todayTotal = db
    .prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE created_at >= ? ${shopFilter}`)
    .get(todayStart, ...shopArgs).s;
  const monthTotal = db
    .prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE created_at >= ? ${shopFilter}`)
    .get(monthStart, ...shopArgs).s;
  const pendingCount = db
    .prepare("SELECT COUNT(*) AS c FROM sms_payments WHERE status IN ('pending','unmatched')").get().c;
  const confirmedCount = db
    .prepare("SELECT COUNT(*) AS c FROM payment_events WHERE status = 'confirmed'").get().c;

  res.json({
    payments: legacyPayments,
    payment_events: eventRows,
    sms_payments: smsRows,
    summary: {
      today: todayTotal,
      month: monthTotal,
      pending: pendingCount,
      confirmed: confirmedCount,
      total: eventRows.reduce((n, p) => n + p.amount, 0),
    },
  });
});

// ── Action : suspendre / réactiver un client (compte) ────────────────────────────
router.post("/api/v1/admin/clients/:id/suspend", requireAdmin, (req, res) => {
  const account = accountById(Number(req.params.id));
  if (!account) return res.status(404).json({ error: "Client introuvable." });
  const session = sessionOf(req);
  if (!accountOriginOk(account, session.scope === "project" ? session.project : null))
    return res.status(403).json({ error: "Client hors de ce projet." });

  const now = Date.now();
  db.prepare("UPDATE accounts SET suspended_at = ?, updated_at = ? WHERE id = ?").run(now, now, account.id);
  syncShopsFromAccount(account.id);
  logAdminAction(req, "account", account.id, "suspend", str(req.body?.reason));
  logActivity("warn", "account", "Compte suspendu", `${account.name} a été suspendu`, { account_id: account.id }, null, account.id);
  res.json({ ok: true, account: publicAccount(accountById(account.id)) });
});

router.post("/api/v1/admin/clients/:id/activate", requireAdmin, (req, res) => {
  const account = accountById(Number(req.params.id));
  if (!account) return res.status(404).json({ error: "Client introuvable." });
  const session = sessionOf(req);
  if (!accountOriginOk(account, session.scope === "project" ? session.project : null))
    return res.status(403).json({ error: "Client hors de ce projet." });

  const now = Date.now();
  db.prepare("UPDATE accounts SET suspended_at = NULL, updated_at = ? WHERE id = ?").run(now, account.id);
  syncShopsFromAccount(account.id);
  logAdminAction(req, "account", account.id, "activate", str(req.body?.reason));
  logActivity("success", "account", "Compte réactivé", `${account.name} a été réactivé`, { account_id: account.id }, null, account.id);
  res.json({ ok: true, account: publicAccount(accountById(account.id)) });
});

// ── Action : changer l'abonnement d'un client ──────────────────────────────────────
router.post("/api/v1/admin/clients/:id/plan", requireAdmin, (req, res) => {
  const account = accountById(Number(req.params.id));
  if (!account) return res.status(404).json({ error: "Client introuvable." });
  const session = sessionOf(req);
  if (!accountOriginOk(account, session.scope === "project" ? session.project : null))
    return res.status(403).json({ error: "Client hors de ce projet." });

  const days = Math.round(Number(req.body?.days));
  const amount = Math.round(Number(req.body?.amount_fcfa));
  if (!Number.isFinite(amount) && !Number.isFinite(days)) return res.status(400).json({ error: "amount_fcfa ou days requis." });

  const now = Date.now();
  let result;
  if (Number.isFinite(amount) && amount > 0) {
    result = applyTierRenewal(account, amount, now);
    if (!result) return res.status(400).json({ error: "Montant insuffisant pour un palier." });
  } else {
    const newExpiry = Math.max(now, account.expiry_date) + days * DAY_MS;
    db.prepare("UPDATE accounts SET suspended_at = NULL, expiry_date = ?, updated_at = ? WHERE id = ?").run(newExpiry, now, account.id);
    syncShopsFromAccount(account.id);
    result = { days, tier: { devices: account.max_devices, price: priceForDevices(account.max_devices) }, new_end_date: newExpiry };
  }

  logAdminAction(req, "account", account.id, "change_plan", req.body?.reason ? str(req.body.reason) : null);
  logActivity("info", "account", "Abonnement modifié", `${account.name} — ${amount ? amount + " FCFA" : days + " jours"}`, { account_id: account.id }, null, account.id);
  res.json({ ok: true, account: publicAccount(accountById(account.id)), result });
});

router.post("/api/v1/admin/clients/:id/extend", requireAdmin, (req, res) => {
  const account = accountById(Number(req.params.id));
  if (!account) return res.status(404).json({ error: "Client introuvable." });
  const session = sessionOf(req);
  if (!accountOriginOk(account, session.scope === "project" ? session.project : null))
    return res.status(403).json({ error: "Client hors de ce projet." });

  const amount = Math.round(Number(req.body?.amount_fcfa));
  if (!Number.isFinite(amount) || amount <= 0)
    return res.status(400).json({ error: "amount_fcfa requis." });

  const now = Date.now();
  const renewal = applyTierRenewal(account, amount, now);
  if (!renewal) return res.status(400).json({ error: `Montant insuffisant. Paliers : ${PRICE_TIERS.map((t) => `${t.price.toLocaleString("fr-FR")} F (${t.devices} appareils)`).join(" · ")}.` });

  logAdminAction(req, "account", account.id, "extend", req.body?.note ? str(req.body.note) : null);
  logActivity("success", "payment", "Paiement reçu", `${account.name} — ${amount.toLocaleString("fr-FR")} F`, { account_id: account.id, amount }, null, account.id);

  // Créer le payment_event
  const anchor = db.prepare("SELECT id FROM shops WHERE account_id = ? ORDER BY registration_date ASC, id ASC LIMIT 1").get(account.id);
  upsertPaymentEvent({
    account_id: account.id,
    shop_id: anchor?.id,
    amount,
    provider: "manual",
    reference: `admin-${Date.now()}`,
    status: "confirmed",
    source: "manual",
    received_at: now,
    note: str(req.body?.note) || null,
  });

  res.json({ ok: true, account: publicAccount(accountById(account.id)), renewal });
});

// ── Action : révoquer un appareil (supprimer une caisse du compte) ────────────────
router.post("/api/v1/admin/devices/:device_id/revoke", requireAdmin, (req, res) => {
  const device_id = str(req.params.device_id);
  const shop = byDeviceId(device_id);
  if (!shop) return res.status(404).json({ error: "Appareil introuvable." });
  const session = sessionOf(req);
  if (session.scope === "project" && shop.app_origin !== session.project)
    return res.status(403).json({ error: "Appareil hors de ce projet." });

  logAdminAction(req, "shop", shop.id, "revoke_device", str(req.body?.reason));
  logActivity("warn", "device", "Appareil révoqué", `${shop.store_name} (${device_id})`, { device_id, shop_id: shop.id }, shop.id, shop.account_id);

  deleteShop(device_id);
  res.json({ ok: true, device_id });
});

// ── Action : forcer une synchronisation (marqueur pour prochain handshake) ──────────
router.post("/api/v1/admin/devices/:device_id/force-sync", requireAdmin, (req, res) => {
  const device_id = str(req.params.device_id);
  const shop = byDeviceId(device_id);
  if (!shop) return res.status(404).json({ error: "Appareil introuvable." });
  const session = sessionOf(req);
  if (session.scope === "project" && shop.app_origin !== session.project)
    return res.status(403).json({ error: "Appareil hors de ce projet." });

  const now = Date.now();
  // Envoie un broadcast_message comme ordre pour forcer le prochain handshake
  const cmdId = randomUUID();
  const expiresAt = now + COMMAND_TTL_MS;
  const accountId = shop.account_id ?? null;
  db.prepare(
    "INSERT INTO admin_commands (id, device_id, account_id, action_type, payload, expires_at, created_at) VALUES (?, ?, ?, 'broadcast_message', ?, ?, ?)",
  ).run(cmdId, device_id, accountId, JSON.stringify({ message_text: `[SYNC FORCÉE] ${str(req.body?.message) || "Actualisation déclenchée par l'administration."}` }), expiresAt, now);

  logAdminAction(req, "shop", shop.id, "force_sync", str(req.body?.reason));
  logActivity("info", "sync", "Synchronisation forcée", `Demande de sync pour ${shop.store_name}`, { device_id }, shop.id, shop.account_id);

  res.json({ ok: true, command_id: cmdId });
});

// ── Désactiver / réactiver une boutique ────────────────────────────────────────────
router.post("/api/v1/admin/shops/:device_id/deactivate", requireAdmin, (req, res) => {
  const device_id = str(req.params.device_id);
  const shop = byDeviceId(device_id);
  if (!shop) return res.status(404).json({ error: "Boutique introuvable." });
  const session = sessionOf(req);
  if (session.scope === "project" && shop.app_origin !== session.project)
    return res.status(403).json({ error: "Boutique hors de ce projet." });

  const now = Date.now();
  db.prepare("UPDATE shops SET suspended_at = ?, updated_at = ? WHERE id = ?").run(now, now, shop.id);
  logAdminAction(req, "shop", shop.id, "deactivate", str(req.body?.reason));
  logActivity("warn", "shop", "Boutique désactivée", shop.store_name, { device_id }, shop.id, shop.account_id);
  res.json({ ok: true, shop: publicShop(byId(shop.id)) });
});

router.post("/api/v1/admin/shops/:device_id/reactivate", requireAdmin, (req, res) => {
  const device_id = str(req.params.device_id);
  const shop = byDeviceId(device_id);
  if (!shop) return res.status(404).json({ error: "Boutique introuvable." });
  const session = sessionOf(req);
  if (session.scope === "project" && shop.app_origin !== session.project)
    return res.status(403).json({ error: "Boutique hors de ce projet." });

  const now = Date.now();
  db.prepare("UPDATE shops SET suspended_at = NULL, updated_at = ? WHERE id = ?").run(now, shop.id);
  logAdminAction(req, "shop", shop.id, "reactivate", str(req.body?.reason));
  logActivity("success", "shop", "Boutique réactivée", shop.store_name, { device_id }, shop.id, shop.account_id);
  res.json({ ok: true, shop: publicShop(byId(shop.id)) });
});

// ── Revenue by tier amélioré (période configurable) ────────────────────────────────
router.get("/api/v1/admin/revenue-timeseries", requireAdmin, (req, res) => {
  const period = str(req.query.period) || "30d"; // 7d, 30d, 3m, 12m
  let days;
  if (period === "7d") days = 7;
  else if (period === "30d") days = 30;
  else if (period === "3m") days = 90;
  else if (period === "12m") days = 365;
  else days = 30;

  const startMs = Date.now() - days * DAY_MS;
  const row = db
    .prepare("SELECT amount, created_at FROM payments WHERE created_at >= ? ORDER BY created_at ASC")
    .all(startMs);

  // Grouper par jour
  const byDay = new Map();
  for (const p of row) {
    const d = new Date(p.created_at).toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + p.amount);
  }

  const result = Array.from(byDay.entries()).map(([day, revenue]) => ({ day, revenue }));

  // Revenus par abonnement (compte) et par boutique
  const byAccount = db
    .prepare(
      `SELECT a.name, COALESCE(SUM(p.amount), 0) AS total
       FROM payments p JOIN accounts a ON p.account_id = a.id
       WHERE p.created_at >= ? GROUP BY a.id, a.name ORDER BY total DESC LIMIT 10`,
    )
    .all(startMs);

  const byShop = db
    .prepare(
      `SELECT s.store_name, COALESCE(SUM(p.amount), 0) AS total
       FROM payments p JOIN shops s ON p.shop_id = s.id
       WHERE p.created_at >= ? GROUP BY s.id, s.store_name ORDER BY total DESC LIMIT 10`,
    )
    .all(startMs);

  res.json({ period, days, by_day: result, by_account: byAccount, by_shop: byShop });
});

// ── Revenue summary (aujourd'hui / semaine / mois / année / récurrent / en attente) ─
router.get("/api/v1/admin/revenue-summary", requireAdmin, (req, res) => {
  const now = Date.now();
  const monthStart = new Date(now).getDate() === 1
    ? now
    : new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const yearStart = new Date(new Date().getFullYear(), 0, 1).getTime();

  const today = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE created_at >= ?").get(now - DAY_MS).s;
  const week = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE created_at >= ?").get(now - 7 * DAY_MS).s;
  const month = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE created_at >= ?").get(monthStart).s;
  const year = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE created_at >= ?").get(yearStart).s;

  // Revenus récurrents = MRR (comptes actifs)
  const accounts = db.prepare("SELECT * FROM accounts WHERE merged_into IS NULL").all();
  const mrr = accounts
    .filter((a) => {
      const st = computeAccountStatus(a);
      return st === "active" || st === "grace";
    })
    .reduce((sum, a) => sum + priceForDevices(a.max_devices), 0);

  // Paiements en attente
  const pendingSms = db.prepare("SELECT COUNT(*) AS c FROM sms_payments WHERE status IN ('pending','unmatched')").get().c;
  const pendingRequests = db.prepare("SELECT COUNT(*) AS c FROM subscription_requests WHERE status = 'pending'").get().c;
  const pendingEventPayments = db.prepare("SELECT COUNT(*) AS c FROM payment_events WHERE status = 'pending'").get().c;

  // Paiements confirmés
  const confirmed = db.prepare("SELECT COUNT(*) AS c FROM payment_events WHERE status = 'confirmed'").get().c;

  res.json({
    today,
    week,
    month,
    year,
    recurring_mrr: mrr,
    pending: pendingSms + pendingRequests + pendingEventPayments,
    confirmed,
  });
});

export default router;
