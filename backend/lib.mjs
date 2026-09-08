// Helpers partagés — modèle multi-écrans (comptes), requêtes et utilitaires purs.
// Aucune route ici ; chaque module de routes importe ce dont il a besoin.
import {
  db,
  PRICE_TIERS,
  PRICE_PER_MONTH_FCFA,
  TRIAL_DAYS,
  GRACE_PERIOD_MS,
  DAY_MS,
  ONLINE_WINDOW_MS,
} from "./config.mjs";
import { createHash, randomBytes } from "node:crypto";

// ── Requêtes ───────────────────────────────────────────────────────────────────────
export const byId = (id) => db.prepare("SELECT * FROM shops WHERE id = ?").get(id);
export const byDeviceId = (deviceId) =>
  db.prepare("SELECT * FROM shops WHERE device_id = ?").get(deviceId);

export const listShops = (origin) =>
  db
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM payments p WHERE p.shop_id = s.id) AS payments
       FROM shops s ${origin ? "WHERE s.app_origin = ?" : ""} ORDER BY s.expiry_date ASC`,
    )
    .all(...(origin ? [origin] : []));

// ── Comptes marchands ──────────────────────────────────────────────────────────────
export const accountById = (id) => db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
export const accountByPhone = (phone) =>
  phone ? db.prepare("SELECT * FROM accounts WHERE phone = ?").get(phone) : undefined;

/** Normalise un mot clé saisi : majuscules, chiffres, séparateurs (-/ espaces) ignorés. */
export const normKeyword = (k) => str(k).toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Résolution par mot clé de récupération — la clé d'appairage d'un nouvel écran. */
export const accountByKeyword = (keyword) =>
  keyword ? db.prepare("SELECT * FROM accounts WHERE keyword = ?").get(normKeyword(keyword)) : undefined;

const KEYWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Mot clé de récupération du compte : combinaison RANDOMISÉE dérivée des infos
 * enregistrées à la création (enseigne, propriétaire, téléphone, id) épicée d'un sel
 * aléatoire — un secret unique par compte, pas une valeur prévisible. Format
 * XXXX-XXXX sur un alphabet sans ambiguïté visuelle (ni 0/O, ni 1/I/L).
 */
export function generateKeyword(account) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const salt = randomBytes(8).toString("hex");
    const digest = createHash("sha256")
      .update(
        [account.name, account.owner_name, account.phone ?? "", String(account.id), salt].join("|"),
      )
      .digest("hex");
    let key = "";
    for (let i = 0; i < 8; i++) {
      key += KEYWORD_ALPHABET[parseInt(digest.slice(i * 2, i * 2 + 2), 16) % KEYWORD_ALPHABET.length];
    }
    const candidate = `${key.slice(0, 4)}-${key.slice(4)}`;
    if (!accountByKeyword(candidate)) return candidate;
  }
  throw new Error("Impossible de générer un mot clé unique.");
}

/** Écrans du compte, du plus ancien au plus récent : l'ordre décide du quota. */
export const accountDevices = (accountId) =>
  db.prepare("SELECT * FROM shops WHERE account_id = ? ORDER BY registration_date ASC, id ASC").all(accountId);

export function computeAccountStatus(account) {
  if (!account) return "unknown";
  if (account.suspended_at) return "suspended";
  const now = Date.now();
  if (account.expiry_date > now) return "active";
  // Grace period : l'expiration est passée mais on est dans les 2 jours de tolérance.
  // Le compte reste 100% fonctionnel — pas de blocage, pas de restriction.
  if (account.expiry_date > now - GRACE_PERIOD_MS) return "grace";
  return "expired";
}

export function publicAccount(account) {
  const now = Date.now();
  const status = computeAccountStatus(account);
  return {
    id: account.id,
    name: account.name,
    owner_name: account.owner_name,
    phone: account.phone ?? null,
    max_devices: account.max_devices,
    device_count: accountDevices(account.id).length,
    subscription_end_date: account.expiry_date,
    suspended_at: account.suspended_at ?? null,
    // Grace period : si le compte est en grace, renvoyer la date de fin de grace
    // pour que le dashboard puisse afficher un compteur.
    ...(status === "grace" ? { grace_ends_at: account.expiry_date + GRACE_PERIOD_MS } : {}),
  };
}

/**
 * L'écran dépasse-t-il les places du compte ? Classement déterministe par ancienneté :
 * les premiers inscrits restent actifs, les suivants sont bloqués jusqu'à libération
 * (suppression d'un écran) ou montée en palier. Recalculé à chaque lecture — aucun
 * état persistant à réparer quand un appareil disparaît.
 */
export function deviceOverLimit(account, deviceId) {
  const rows = accountDevices(account.id).map((s) => s.device_id);
  const idx = rows.indexOf(deviceId);
  return idx >= account.max_devices;
}

/**
 * Miroir compte → boutiques : shops.expiry_date / suspended_at recopient le compte.
 * Tout le code existant (listes triées par échéance, statuts, routes legacy, vieux
 * builds) continue de lire la fiche boutique sans savoir que la vérité a déménagé.
 */
export function syncShopsFromAccount(accountId) {
  const account = accountById(accountId);
  if (!account) return;
  db.prepare(
    "UPDATE shops SET expiry_date = ?, suspended_at = ?, updated_at = ? WHERE account_id = ?",
  ).run(account.expiry_date, account.suspended_at ?? null, Date.now(), accountId);
}

/** Le compte appartient-il au périmètre du scope (projet des sessions dashboard) ? */
export function accountOriginOk(account, origin) {
  if (!origin) return true;
  return (
    db.prepare("SELECT COUNT(*) AS c FROM shops WHERE account_id = ? AND app_origin = ?").get(account.id, origin).c > 0
  );
}

/**
 * Migration initiale : chaque fiche sans compte rejoint le sien. Regroupement par
 * téléphone normalisé (fusion demandée) ; sans téléphone → compte individuel. Échéance
 * du groupe = la plus lointaine, suspension seulement si TOUTES les fiches l'étaient.
 * Palier initial couvrant le nombre d'appareils du groupe : ne jamais bloquer l'existant.
 */
export function migrateShopsToAccounts() {
  const pending = db
    .prepare("SELECT * FROM shops WHERE account_id IS NULL ORDER BY registration_date ASC")
    .all();
  if (pending.length === 0) return;
  const groups = new Map(); // clé : téléphone normalisé, ou `solo:<id>` sans téléphone
  for (const shop of pending) {
    const phone = normPhone(shop.phone ?? "");
    const key = phone || `solo:${shop.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(shop);
  }
  for (const [key, shops] of groups) {
    const phone = key.startsWith("solo:") ? null : key;
    const existing = resolveAccount(phone ? accountByPhone(phone) : null);
    if (existing) {
      // Compte déjà créé pour ce téléphone plus tôt dans la boucle : simple rattachement.
      for (const s of shops)
        db.prepare("UPDATE shops SET account_id = ? WHERE id = ?").run(existing.id, s.id);
      continue;
    }
    const expiry = Math.max(...shops.map((s) => s.expiry_date));
    const allSuspended = shops.every((s) => s.suspended_at);
    const suspendedAt = allSuspended ? Math.min(...shops.map((s) => s.suspended_at)) : null;
    const tier = tierCoveringDevices(shops.length);
    const first = shops[0];
    const account = createAccount({
      name: first.store_name || "Boutique",
      owner_name: first.owner_name ?? "",
      phone,
      password: randomBytes(8).toString("hex"),
      max_devices: Math.max(tier.devices, shops.length),
      expiry_date: expiry,
      suspended_at: suspendedAt,
    });
    const ids = shops.map((s) => s.id);
    for (const id of ids)
      db.prepare("UPDATE shops SET account_id = ? WHERE id = ?").run(account.id, id);
    db.prepare(
      `UPDATE payments SET account_id = ? WHERE shop_id IN (${ids.map(() => "?").join(",")}) AND account_id IS NULL`,
    ).run(account.id, ...ids);
    console.log(
      `[migration] compte #${account.id} « ${account.name} » (${phone ?? "sans téléphone"}) ← ${shops.length} boutique(s), palier ${account.max_devices}`,
    );
  }
  console.log("[migration] rattachement des boutiques à leurs comptes terminé.");
}

/**
 * Rattrapage legacy : une fiche créée par une vieille route (/api/shops) ou un handshake
 * sans identifiants reçoit un compte individuel — aucun écran ne reste orphelin.
 */
export function attachAccountForLegacy(shop) {
  if (shop.account_id && accountById(shop.account_id)) return shop;
  const phone = normPhone(shop.phone ?? "");
  let account = resolveAccount(phone ? accountByPhone(phone) : null);
  // Regroupement par nom d'enseigne : sans identifiants présentés, une fiche rejoint
  // quand même le compte qui porte déjà ce nom de boutique — pas de compte individuel
  // par écran pour la même enseigne.
  if (!account) account = mergeGroupForKey(normName(shop.store_name));
  if (!account) {
    const tier = tierCoveringDevices(1);
    account = createAccount({
      name: shop.store_name || "Boutique",
      owner_name: shop.owner_name ?? "",
      phone: phone || null,
      password: randomBytes(8).toString("hex"),
      max_devices: tier.devices,
      expiry_date: shop.expiry_date,
      suspended_at: shop.suspended_at ?? null,
    });
  }
  db.prepare("UPDATE shops SET account_id = ? WHERE id = ?").run(account.id, shop.id);
  return byId(shop.id);
}

// ── Fusion des comptes par nom d'enseigne ──────────────────────────────────────────
// Une même boutique déclarée depuis plusieurs écrans doit rester UN abonnement : sans
// ce regroupement, chaque écran (ou chaque téléphone différent) pourrait créer son
// propre compte avec son propre quota et son propre essai. Toutes les fiches portant
// un même nom normalisé convergent donc vers le compte le plus ancien ; les comptes
// absorbés deviennent de simples redirections (merged_into) — leurs identifiants
// restent acceptés à l'authentification, puis la requête suit la chaîne. Le dépassement
// de quota se calcule ensuite naturellement sur le compte survivant : les écrans en
// trop sont coupés par le classement par ancienneté déjà en place.

/** Comptes non absorbés (les redirections ne sont ni listées ni administrables). */
export const activeAccounts = () =>
  db.prepare("SELECT * FROM accounts WHERE merged_into IS NULL").all();

/**
 * Suit les redirections merged_into jusqu'au compte vivant. Garde-fou anti-cycle :
 * une chaîne bouclée s'arrête au premier élément déjà visité.
 */
export function resolveAccount(account) {
  const seen = new Set();
  while (account?.merged_into && !seen.has(account.id)) {
    seen.add(account.id);
    account = accountById(account.merged_into);
  }
  return account ?? undefined;
}

/** Bénédiction d'un appareil sur un compte (le propriétaire approuve). */
export function deviceBlessing(deviceId, accountId, blessedBy) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO device_blessings (device_id, account_id, blessed_at, blessed_by)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET account_id = excluded.account_id, blessed_at = excluded.blessed_at, blessed_by = excluded.blessed_by`,
  ).run(deviceId, accountId, now, blessedBy);
}
export function deviceBlessingByDevice(deviceId) {
  return db.prepare("SELECT * FROM device_blessings WHERE device_id = ?").get(deviceId) ?? undefined;
}
export function deviceBlessingsForAccount(accountId) {
  return db.prepare("SELECT * FROM device_blessings WHERE account_id = ?").all(accountId);
}
/** Crée ou renouvelle le secret par-appareil ; retourne le mot de passe généré. */
export function upsertDeviceCredential(deviceId, accountId) {
  const secret = randomBytes(16).toString("hex");
  const now = Date.now();
  db.prepare(
    `INSERT INTO device_credentials (device_id, account_id, password, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET account_id = excluded.account_id, password = excluded.password, created_at = excluded.created_at`,
  ).run(deviceId, accountId, secret, now);
  return secret;
}
export function deviceCredentialForDevice(deviceId) {
  return db.prepare("SELECT * FROM device_credentials WHERE device_id = ?").get(deviceId) ?? undefined;
}

/** Comptes vivants possédant au moins une fiche au nom normalisé donné. */
export function accountsForNameKey(key) {
  if (!key) return [];
  const ids = new Set();
  for (const s of db.prepare("SELECT account_id, store_name FROM shops WHERE account_id IS NOT NULL").all()) {
    if (normName(s.store_name) === key) ids.add(s.account_id);
  }
  return [...ids].map(accountById).filter((a) => a && !a.merged_into);
}

export function mergeAccountInto(merged, survivor) {
  const now = Date.now();
  db.prepare("UPDATE shops SET account_id = ?, updated_at = ? WHERE account_id = ?").run(
    survivor.id,
    now,
    merged.id,
  );
  db.prepare("UPDATE payments SET account_id = ? WHERE account_id = ?").run(survivor.id, merged.id);
  // L'historique suit : commandes livrées comme en attente passent au survivant — une
  // suspension visant l'absorbé vise dès lors la même enseigne réunifiée.
  db.prepare("UPDATE admin_commands SET account_id = ? WHERE account_id = ?").run(
    survivor.id,
    merged.id,
  );
  db.prepare("UPDATE accounts SET merged_into = ?, updated_at = ? WHERE id = ?").run(
    survivor.id,
    now,
    merged.id,
  );
  syncShopsFromAccount(survivor.id);
  console.log(
    `[fusion] compte « ${merged.name} » (#${merged.id}) → « ${survivor.name} » (#${survivor.id}) : même enseigne, un seul abonnement.`,
  );
}

/**
 * Réunit les comptes d'une même enseigne dans le compte qui fait foi :
 *   1. celui qui a des paiements enregistrés (le vrai abonnement, jamais un compte
 *      fantôme né d'un téléphone mal saisi) ;
 *   2. sinon l'échéance la plus lointaine ;
 *   3. départage final par id le plus ancien (déterminisme).
 * Retourne le survivant, ou null si aucun compte ne porte ce nom. Aucun élargissement
 * de quota : fusionner deux paliers de 2 places n'en donne pas 4 — c'est même le but,
 * les écrans au-delà du palier survivant sont coupés.
 */
export function mergeGroupForKey(key) {
  const group = accountsForNameKey(key);
  if (group.length === 0) return null;
  if (group.length === 1) return group[0];
  const paymentCount = (accountId) =>
    db.prepare("SELECT COUNT(*) AS c FROM payments WHERE account_id = ?").get(accountId).c;
  const ranked = [...group].sort(
    (x, y) =>
      paymentCount(y.id) - paymentCount(x.id) ||
      y.expiry_date - x.expiry_date ||
      x.id - y.id,
  );
  const survivor = ranked[0];
  for (const a of ranked.slice(1)) mergeAccountInto(a, survivor);
  return survivor;
}

/** Passe de démarrage : converge toutes les enseignes dupliquées (idempotent). */
export function mergeAccountsByName() {
  const keys = new Set(
    db
      .prepare("SELECT store_name FROM shops WHERE account_id IS NOT NULL")
      .all()
      .map((r) => normName(r.store_name))
      .filter(Boolean),
  );
  for (const key of keys) mergeGroupForKey(key);
}

export function computeStatus(shop) {
  if (!shop) return "unknown";
  if (shop.suspended_at) return "suspended";
  const now = Date.now();
  if (shop.expiry_date > now) return "active";
  // Grace period : même logique que computeAccountStatus pour les boutiques legacy.
  if (shop.expiry_date > now - GRACE_PERIOD_MS) return "grace";
  return "expired";
}

export function publicShop(shop) {
  return {
    device_id: shop.device_id,
    owner_name: shop.owner_name,
    store_name: shop.store_name,
    phone: shop.phone ?? null,
    location: shop.location ?? null,
    registration_date: shop.registration_date,
    // L'échéance fait foi côté client (l'app s'y aligne).
    subscription_end_date: shop.expiry_date,
    expiry_date: shop.expiry_date,
    suspended_at: shop.suspended_at ?? null,
    app_version_used: shop.app_version_used ?? null,
    app_origin: shop.app_origin ?? "pos",
  };
}

export const str = (v) => (typeof v === "string" ? v.trim() : "");
export const optStr = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Normalisation d'un numéro : l'identité de compte ne retient que les chiffres et
 * retire le préfixe international « 00 » — « +241 06 11 22 33 », « 0024106112233 » et
 * « 24106112233 » désignent le même compte.
 */
export function normPhone(v) {
  const digits = str(v).replace(/\D/g, "");
  return digits.startsWith("00") ? digits.slice(2) : digits;
}

/**
 * Clé de regroupement des boutiques par nom : casse, accents, ponctuation et espaces ne
 * comptent pas — « Alimentation Chez Marie », « ALIMENTATION CHEZ MARIE » et
 * « alimentation-chez-marie » désignent la même enseigne. Vide si le nom ne porte
 * rien de comparable (alors aucun regroupement par nom).
 */
export function normName(v) {
  return str(v)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Plus grand palier couvert par un montant (null si inférieur au premier palier). */
export function tierForAmount(amount) {
  let match = null;
  for (const t of PRICE_TIERS) if (amount >= t.price) match = t;
  return match;
}

/** Plus petit palier couvrant n appareils ; au-delà du dernier palier, n places sur mesure. */
export function tierCoveringDevices(n) {
  for (const t of PRICE_TIERS) if (t.devices >= n) return t;
  const last = PRICE_TIERS[PRICE_TIERS.length - 1];
  return { price: last?.price ?? PRICE_PER_MONTH_FCFA, devices: Math.max(n, last?.devices ?? n) };
}

/** Tarif associé à un nombre de places (MRR) ; palier sur mesure → tarif du palier couvrant. */
export function priceForDevices(devices) {
  const exact = PRICE_TIERS.find((t) => t.devices === devices);
  if (exact) return exact.price;
  return tierCoveringDevices(devices).price;
}

/** Création d'un compte ; renvoie la ligne insérée. Le mot clé de récupération est
 *  généré une fois pour toutes, dérivé de la fiche (combo aléatoire des infos). */
export function createAccount({
  name,
  owner_name = "",
  phone = null,
  password,
  max_devices,
  expiry_date,
  suspended_at = null,
}) {
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO accounts (name, owner_name, phone, password, keyword, max_devices, expiry_date, suspended_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(name, owner_name, phone, password, max_devices, expiry_date, suspended_at, now, now);
  const account = accountById(Number(info.lastInsertRowid));
  db.prepare("UPDATE accounts SET keyword = ?, updated_at = ? WHERE id = ?").run(
    generateKeyword(account),
    now,
    account.id,
  );
  return accountById(Number(info.lastInsertRowid));
}

/**
 * Prolongation d'un COMPTE par montant encaissé : palier déduit du montant, échéance
 * repoussée de 30 jours par palier, suspension levée, paiement tracé au niveau compte.
 * Partagée par la commande « Prolonger » du dashboard et la validation EN UN CLIC d'une
 * demande d'abonnement — un seul code, donc un seul comportement de facturation.
 * Renvoie { days, tier, new_end_date } ou null si le montant ne couvre aucun palier.
 */
export function applyTierRenewal(account, amountFcfa, now) {
  const tier = tierForAmount(amountFcfa);
  if (!tier) return null;
  const days = Math.max(1, Math.round((amountFcfa / tier.price) * 30));
  const new_end_date = Math.max(now, account.expiry_date) + days * DAY_MS;
  db.prepare(
    "UPDATE accounts SET suspended_at = NULL, expiry_date = ?, max_devices = ?, updated_at = ? WHERE id = ?",
  ).run(new_end_date, tier.devices, now, account.id);
  syncShopsFromAccount(account.id);
  // Paiement rattaché au compte ; la colonne shop_id (NOT NULL, FK vers shops) porte
  // l'écran fondateur du compte — cf. commande « renew » pour le même choix.
  const anchor = db
    .prepare(
      "SELECT id FROM shops WHERE account_id = ? ORDER BY registration_date ASC, id ASC LIMIT 1",
    )
    .get(account.id);
  if (anchor) {
    db.prepare(
      "INSERT INTO payments (shop_id, account_id, amount, days_added, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(anchor.id, account.id, amountFcfa, days, now);
  }
  return { days, tier, new_end_date };
}

/** Upsert d'une boutique — partagé par l'inscription legacy et le handshake. */
export function upsertShop(body) {
  const device_id = str(body.device_id);
  const store_name = str(body.store_name);
  if (!device_id || !store_name)
    return { error: "device_id et store_name sont requis.", status: 400 };
  const owner_name = str(body.owner_name);
  const phone = optStr(body.phone);
  const location = optStr(body.location);
  const app_version_used = optStr(body.app_version_used);
  const device_fingerprint = optStr(body.device_fingerprint);
  const registered_at =
    typeof body.registered_at === "number" && Number.isFinite(body.registered_at)
      ? body.registered_at
      : Date.now();
  const now = Date.now();
  const existing = byDeviceId(device_id);
  if (existing) {
    db.prepare(
      `UPDATE shops
       SET owner_name = ?, store_name = ?, phone = ?, location = ?,
           app_version_used = COALESCE(?, app_version_used),
           device_fingerprint = COALESCE(?, device_fingerprint),
           updated_at = ?
       WHERE id = ?`,
    ).run(owner_name, store_name, phone, location, app_version_used, device_fingerprint, now, existing.id);
    return { shop: byId(existing.id), status: 200 };
  }
  // Nouvelle boutique : vérifier l'unicité de l'empreinte numérique.
  if (device_fingerprint) {
    const clash = db.prepare("SELECT device_id, store_name FROM shops WHERE device_fingerprint = ?").get(device_fingerprint);
    if (clash) {
      return {
        error: `Cet appareil est déjà enregistré sous la boutique « ${clash.store_name} » (${clash.device_id}). Un seul appareil physique par boutique.`,
        status: 409,
        code: "fingerprint_conflict",
        existing_device_id: clash.device_id,
      };
    }
  }
  db.prepare(
    `INSERT INTO shops
       (device_id, owner_name, store_name, phone, location, registration_date,
        expiry_date, created_at, updated_at, app_version_used, device_fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    device_id,
    owner_name,
    store_name,
    phone,
    location,
    registered_at,
    registered_at + TRIAL_DAYS * DAY_MS,
    now,
    now,
    app_version_used,
    device_fingerprint,
  );
  return { shop: byDeviceId(device_id), status: 200 };
}

// ── Protocole v2 : stats réelles par projet (agrégées depuis sync_payloads) ───────
// Le dashboard affiche les données que les caisses déposent réellement. Chaque caisse
// envoie une fenêtre glissante de 7 j déjà cumulée : on ne retient donc que le DERNIER
// payload par caisse, puis on somme les totaux du projet. Top produits agrégés par nom.
// Jamais le brut : uniquement des totaux et des top produits.
export function aggregateStats(shops) {
  const zero = { revenue: 0, profit: 0, sales: 0, items: 0, customers: 0 };
  if (shops.length === 0)
    return { generated_at: null, totals: zero, top_products: [], by_day: [], shops: [] };

  const ids = shops.map((s) => s.device_id);
  const rows = db
    .prepare(
      `SELECT sp.device_id, sp.payload, sp.received_at
       FROM sync_payloads sp
       JOIN (SELECT device_id, MAX(received_at) AS m FROM sync_payloads GROUP BY device_id) t
         ON sp.device_id = t.device_id AND sp.received_at = t.m
       WHERE sp.device_id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids);

  const byDevice = new Map();
  for (const row of rows) {
    let p;
    try {
      p = JSON.parse(row.payload);
    } catch {
      continue;
    }
    const t = p.totals ?? {};
    byDevice.set(row.device_id, {
      last_sync_at: row.received_at,
      totals: {
        revenue: Number(t.revenue) || 0,
        profit: Number(t.profit) || 0,
        sales: Number(t.sales) || 0,
        items: Number(t.items) || 0,
        customers: Number(t.customers) || 0,
      },
      top_products: Array.isArray(p.top_products) ? p.top_products : [],
      by_day: Array.isArray(p.by_day) ? p.by_day : [],
    });
  }

  const totals = { ...zero };
  const top = new Map();
  const dayAgg = new Map();
  let generated_at = null;
  for (const st of byDevice.values()) {
    for (const k of Object.keys(totals)) totals[k] += st.totals[k];
    generated_at = Math.max(generated_at ?? 0, st.last_sync_at);
    for (const prod of st.top_products) {
      const name = String(prod.name ?? "—");
      const cur = top.get(name) ?? { name, quantity: 0, revenue: 0 };
      cur.quantity += Number(prod.quantity) || 0;
      cur.revenue += Number(prod.revenue) || 0;
      top.set(name, cur);
    }
    // Série chronologique du projet : les fenêtres glissantes de 7 j de chaque caisse
    // sont sommées jour par jour (même jour = même cumul).
    for (const d of st.by_day) {
      const day = Number(d?.day) || 0;
      if (!day) continue;
      const cur = dayAgg.get(day) ?? { day, revenue: 0, profit: 0, sales: 0 };
      cur.revenue += Number(d.revenue) || 0;
      cur.profit += Number(d.profit) || 0;
      cur.sales += Number(d.sales) || 0;
      dayAgg.set(day, cur);
    }
  }

  return {
    generated_at,
    totals,
    top_products: [...top.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 5),
    by_day: [...dayAgg.values()].sort((a, b) => a.day - b.day),
    shops: shops
      .filter((s) => byDevice.has(s.device_id))
      .map((s) => ({ device_id: s.device_id, store_name: s.store_name, ...byDevice.get(s.device_id) })),
  };
}

// ── Vue Abonnements (comptes + MRR) — agrégée côté serveur pour rester cohérente. ──
// Comptée au niveau COMPTE : un abonnement couvre plusieurs écrans, compter les fiches
// gonflerait le MRR d'autant. MRR = somme du tarif du palier des comptes ACTIFS + EN GRACE.
// Un compte est « expirant » quand son échéance est sous 7 ou 30 jours.
export function computeSubscriptions(accounts) {
  const now = Date.now();
  const s = {
    total: accounts.length,
    active: 0,
    grace: 0,
    suspended: 0,
    expired: 0,
    online: 0,
    expiring_7d: 0,
    expiring_30d: 0,
    grace_ending_2d: 0,
    mrr_fcfa: 0,
  };
  for (const account of accounts) {
    const st = computeAccountStatus(account);
    if (st === "active") s.active++;
    else if (st === "grace") s.grace++;
    else if (st === "suspended") s.suspended++;
    else if (st === "expired") s.expired++;
    if (accountDevices(account.id).some((d) => d.last_sync_at && now - d.last_sync_at < ONLINE_WINDOW_MS))
      s.online++;
    // MRR : les comptes actifs ET en grace comptent (ils sont encore payants).
    if (st === "active" || st === "grace") {
      const left = account.expiry_date - now;
      if (st === "active") {
        if (left <= 7 * DAY_MS) s.expiring_7d++;
        if (left <= 30 * DAY_MS) s.expiring_30d++;
      }
      // Grace period : le compte a expiré mais bénéficie de 2 jours de tolérance.
      if (st === "grace") {
        const graceLeft = account.expiry_date + GRACE_PERIOD_MS - now;
        if (graceLeft <= 2 * DAY_MS) s.grace_ending_2d++;
      }
      s.mrr_fcfa += priceForDevices(account.max_devices);
    }
  }
  return s;
}
