// Helpers partagés — modèle multi-écrans (comptes), requêtes et utilitaires purs.
// Aucune route ici ; chaque module de routes importe ce dont il a besoin.
// Toutes les fonctions qui touchent la base sont désormais ASYNC (Postgres).
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

/** Hachage du mot de passe du compte (argon2 si disponible, sinon SHA-256 + sel).
 *  Le mot de passe en clair ne quitte JAMAIS la base. */
export async function hashPassword(password) {
  try {
    // eslint-disable-next-line no-undef
    const argon2 = globalThis.process?.getBuiltinModule?.("argon2") ?? null;
    if (argon2) return argon2.hash(password, { type: argon2.argon2id, memoryCost: 2 ** 16, timeCost: 3, parallelism: 1 });
  } catch {
    // pas d'argon2 → SHA-256 + sel ci-dessous
  }
  const salt = randomBytes(16).toString("hex");
  const digest = createHash("sha256").update(salt + password).digest("hex");
  return `sha256$${salt}$${digest}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  if (stored.startsWith("argon2$") || stored.startsWith("$argon2")) {
    try {
      // eslint-disable-next-line no-undef
      const argon2 = globalThis.process?.getBuiltinModule?.("argon2") ?? null;
      if (argon2) return argon2.verify(stored, password);
    } catch {
      return false;
    }
  }
  if (stored.startsWith("sha256$")) {
    const [, salt, digest] = stored.split("$");
    const calc = createHash("sha256").update(salt + password).digest("hex");
    return calc === digest;
  }
  return stored === password; // rétrocompat
}

// ── Requêtes ───────────────────────────────────────────────────────────────────────
export const byId = (id) => db.get("SELECT * FROM shops WHERE id = $1", id);
export const byDeviceId = (deviceId) =>
  db.get("SELECT * FROM shops WHERE device_id = $1", deviceId);

export const listShops = (origin) =>
  db.all(
    `SELECT s.*,
            (SELECT COUNT(*) FROM payments p WHERE p.shop_id = s.id) AS payments
     FROM shops s ${origin ? "WHERE s.app_origin = $1" : ""} ORDER BY s.expiry_date ASC`,
    ...(origin ? [origin] : []),
  );

// ── Comptes marchands ──────────────────────────────────────────────────────────────
export const accountById = (id) => db.get("SELECT * FROM accounts WHERE id = $1", id);
export const accountByPhone = (phone) =>
  phone ? db.get("SELECT * FROM accounts WHERE phone = $1", phone) : undefined;

/** Normalise un mot clé saisi : majuscules, chiffres, séparateurs (-/ espaces) ignorés. */
export const normKeyword = (k) => str(k).toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Résolution par mot clé de récupération — la clé d'appairage d'un nouvel écran. */
export const accountByKeyword = (keyword) =>
  keyword ? db.get("SELECT * FROM accounts WHERE keyword = $1", normKeyword(keyword)) : undefined;

const KEYWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Mot clé de récupération du compte : combinaison RANDOMISÉE dérivée des infos
 * enregistrées à la création (enseigne, propriétaire, téléphone, id) épicée d'un sel
 * aléatoire — un secret unique par compte, pas une valeur prévisible. Format
 * XXXX-XXXX sur un alphabet sans ambiguïté visuelle (ni 0/O, ni 1/I/L).
 */
export async function generateKeyword(account) {
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
    if (!(await accountByKeyword(candidate))) return candidate;
  }
  throw new Error("Impossible de générer un mot clé unique.");
}

/** Écrans du compte, du plus ancien au plus récent : l'ordre décide du quota. */
export const accountDevices = (accountId) =>
  db.all("SELECT * FROM shops WHERE account_id = $1 ORDER BY registration_date ASC, id ASC", accountId);

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

export async function publicAccount(account) {
  const now = Date.now();
  const status = computeAccountStatus(account);
  return {
    id: account.id,
    name: account.name,
    owner_name: account.owner_name,
    phone: account.phone ?? null,
    max_devices: account.max_devices,
    device_count: (await accountDevices(account.id)).length,
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
export async function deviceOverLimit(account, deviceId) {
  const rows = (await accountDevices(account.id)).map((s) => s.device_id);
  const idx = rows.indexOf(deviceId);
  return idx >= account.max_devices;
}

/**
 * Miroir compte → boutiques : shops.expiry_date / suspended_at recopient le compte.
 * Tout le code existant (listes triées par échéance, statuts, routes legacy, vieux
 * builds) continue de lire la fiche boutique sans savoir que la vérité a déménagé.
 */
export async function syncShopsFromAccount(accountId) {
  const account = await accountById(accountId);
  if (!account) return;
  await db.run(
    "UPDATE shops SET expiry_date = $1, suspended_at = $2, updated_at = $3 WHERE account_id = $4",
    account.expiry_date,
    account.suspended_at ?? null,
    Date.now(),
    accountId,
  );
}

/** Le compte appartient-il au périmètre du scope (projet des sessions dashboard) ? */
export function accountOriginOk(account, origin) {
  if (!origin) return Promise.resolve(true);
  return db
    .get("SELECT COUNT(*) AS c FROM shops WHERE account_id = $1 AND app_origin = $2", account.id, origin)
    .then((r) => r.c > 0);
}

/**
 * Migration initiale : chaque fiche sans compte rejoint le sien. Regroupement par
 * téléphone normalisé (fusion demandée) ; sans téléphone → compte individuel. Échéance
 * du groupe = la plus lointaine, suspension seulement si TOUTES les fiches l'étaient.
 * Palier initial couvrant le nombre d'appareils du groupe : ne jamais bloquer l'existant.
 */
export async function migrateShopsToAccounts() {
  const pending = await db.all(
    "SELECT * FROM shops WHERE account_id IS NULL ORDER BY registration_date ASC",
  );
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
    const existing = await resolveAccount(phone ? await accountByPhone(phone) : null);
    if (existing) {
      // Compte déjà créé pour ce téléphone plus tôt dans la boucle : simple rattachement.
      for (const s of shops)
        await db.run("UPDATE shops SET account_id = $1 WHERE id = $2", existing.id, s.id);
      continue;
    }
    const expiry = Math.max(...shops.map((s) => s.expiry_date));
    const allSuspended = shops.every((s) => s.suspended_at);
    const suspendedAt = allSuspended ? Math.min(...shops.map((s) => s.suspended_at)) : null;
    const tier = tierCoveringDevices(shops.length);
    const first = shops[0];
    const account = await createAccount({
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
      await db.run("UPDATE shops SET account_id = $1 WHERE id = $2", account.id, id);
    await db.run(
      `UPDATE payments SET account_id = $1 WHERE shop_id IN (${ids.map((_, i) => "$" + (i + 2)).join(",")}) AND account_id IS NULL`,
      account.id,
      ...ids,
    );
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
export async function attachAccountForLegacy(shop) {
  if (shop.account_id && (await accountById(shop.account_id))) return shop;
  const phone = normPhone(shop.phone ?? "");
  let account = await resolveAccount(phone ? await accountByPhone(phone) : null);
  // Regroupement par nom d'enseigne : sans identifiants présentés, une fiche rejoint
  // quand même le compte qui porte déjà ce nom de boutique — pas de compte individuel
  // par écran pour la même enseigne.
  if (!account) account = await mergeGroupForKey(normName(shop.store_name));
  if (!account) {
    const tier = tierCoveringDevices(1);
    account = await createAccount({
      name: shop.store_name || "Boutique",
      owner_name: shop.owner_name ?? "",
      phone: phone || null,
      password: randomBytes(8).toString("hex"),
      max_devices: tier.devices,
      expiry_date: shop.expiry_date,
      suspended_at: shop.suspended_at ?? null,
    });
  }
  await db.run("UPDATE shops SET account_id = $1 WHERE id = $2", account.id, shop.id);
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
  db.all("SELECT * FROM accounts WHERE merged_into IS NULL");

/**
 * Suit les redirections merged_into jusqu'au compte vivant. Garde-fou anti-cycle :
 * une chaîne bouclée s'arrête au premier élément déjà visité.
 */
export async function resolveAccount(account) {
  const seen = new Set();
  while (account?.merged_into && !seen.has(account.id)) {
    seen.add(account.id);
    account = await accountById(account.merged_into);
  }
  return account ?? undefined;
}

/** Bénédiction d'un appareil sur un compte (le propriétaire approuve). */
export const deviceBlessing = (deviceId, accountId, blessedBy) =>
  db.run(
    `INSERT INTO device_blessings (device_id, account_id, blessed_at, blessed_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT(device_id) DO UPDATE SET account_id = excluded.account_id, blessed_at = excluded.blessed_at, blessed_by = excluded.blessed_by`,
    deviceId,
    accountId,
    Date.now(),
    blessedBy,
  );
export const deviceBlessingByDevice = (deviceId) =>
  db.get("SELECT * FROM device_blessings WHERE device_id = $1", deviceId);
export const deviceBlessingsForAccount = (accountId) =>
  db.all("SELECT * FROM device_blessings WHERE account_id = $1", accountId);
/** Crée ou renouvelle le secret par-appareil ; retourne le mot de passe généré. */
export async function upsertDeviceCredential(deviceId, accountId) {
  const secret = randomBytes(16).toString("hex");
  const now = Date.now();
  await db.run(
    `INSERT INTO device_credentials (device_id, account_id, password, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT(device_id) DO UPDATE SET account_id = excluded.account_id, password = excluded.password, created_at = excluded.created_at`,
    deviceId,
    accountId,
    secret,
    now,
  );
  return secret;
}
export const deviceCredentialForDevice = (deviceId) =>
  db.get("SELECT * FROM device_credentials WHERE device_id = $1", deviceId);

/** Comptes vivants possédant au moins une fiche au nom normalisé donné. */
export async function accountsForNameKey(key) {
  if (!key) return [];
  const rows = await db.all("SELECT account_id, store_name FROM shops WHERE account_id IS NOT NULL");
  const ids = new Set();
  for (const s of rows) {
    if (normName(s.store_name) === key) ids.add(s.account_id);
  }
  const accounts = await Promise.all([...ids].map(accountById));
  return accounts.filter((a) => a && !a.merged_into);
}

export async function mergeAccountInto(merged, survivor) {
  const now = Date.now();
  await db.run("UPDATE shops SET account_id = $1, updated_at = $2 WHERE account_id = $3", survivor.id, now, merged.id);
  await db.run("UPDATE payments SET account_id = $1 WHERE account_id = $2", survivor.id, merged.id);
  // L'historique suit : commandes livrées comme en attente passent au survivant — une
  // suspension visant l'absorbé vise dès lors la même enseigne réunifiée.
  await db.run("UPDATE admin_commands SET account_id = $1 WHERE account_id = $2", survivor.id, merged.id);
  await db.run("UPDATE accounts SET merged_into = $1, updated_at = $2 WHERE id = $3", survivor.id, now, merged.id);
  await syncShopsFromAccount(survivor.id);
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
export async function mergeGroupForKey(key) {
  const group = await accountsForNameKey(key);
  if (group.length === 0) return null;
  if (group.length === 1) return group[0];
  const paymentCount = async (accountId) =>
    (await db.get("SELECT COUNT(*) AS c FROM payments WHERE account_id = $1", accountId)).c;
  const ranked = await Promise.all(
    group.map(async (x) => ({ x, payments: await paymentCount(x.id) })),
  );
  ranked.sort(
    (a, b) =>
      b.payments - a.payments ||
      b.x.expiry_date - a.x.expiry_date ||
      a.x.id - b.x.id,
  );
  const survivor = ranked[0].x;
  for (const { x } of ranked.slice(1)) await mergeAccountInto(x, survivor);
  return survivor;
}

/** Passe de démarrage : converge toutes les enseignes dupliquées (idempotent). */
export async function mergeAccountsByName() {
  const rows = await db.all("SELECT store_name FROM shops WHERE account_id IS NOT NULL");
  const keys = new Set(rows.map((r) => normName(r.store_name)).filter(Boolean));
  for (const key of keys) await mergeGroupForKey(key);
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
export async function createAccount({
  name,
  owner_name = "",
  phone = null,
  password,
  max_devices,
  expiry_date,
  suspended_at = null,
}) {
  const now = Date.now();
  const info = await db.get(
    `INSERT INTO accounts (name, owner_name, phone, password, keyword, max_devices, expiry_date, suspended_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9)
     RETURNING id`,
    name,
    owner_name,
    phone,
    await hashPassword(password),
    max_devices,
    expiry_date,
    suspended_at,
    now,
    now,
  );
  const account = await accountById(Number(info.id));
  await db.run("UPDATE accounts SET keyword = $1, updated_at = $2 WHERE id = $3", await generateKeyword(account), now, account.id);
  return accountById(Number(info.id));
}

/**
 * Prolongation d'un COMPTE par montant encaissé : palier déduit du montant, échéance
 * repoussée de 30 jours par palier, suspension levée, paiement tracé au niveau compte.
 * Partagée par la commande « Prolonger » du dashboard et la validation EN UN CLIC d'une
 * demande d'abonnement — un seul code, donc un seul comportement de facturation.
 * Renvoie { days, tier, new_end_date } ou null si le montant ne couvre aucun palier.
 */
export async function applyTierRenewal(account, amountFcfa, now) {
  const tier = tierForAmount(amountFcfa);
  if (!tier) return null;
  const days = Math.max(1, Math.round((amountFcfa / tier.price) * 30));
  const new_end_date = Math.max(now, account.expiry_date) + days * DAY_MS;
  await db.run(
    "UPDATE accounts SET suspended_at = NULL, expiry_date = $1, max_devices = $2, updated_at = $3 WHERE id = $4",
    new_end_date,
    tier.devices,
    now,
    account.id,
  );
  await syncShopsFromAccount(account.id);
  // Paiement rattaché au compte ; la colonne shop_id (NOT NULL, FK vers shops) porte
  // l'écran fondateur du compte — cf. commande « renew » pour le même choix.
  const anchor = await db.get(
    "SELECT id FROM shops WHERE account_id = $1 ORDER BY registration_date ASC, id ASC LIMIT 1",
    account.id,
  );
  if (anchor) {
    await db.run(
      "INSERT INTO payments (shop_id, account_id, amount, days_added, created_at) VALUES ($1, $2, $3, $4, $5)",
      anchor.id,
      account.id,
      amountFcfa,
      days,
      now,
    );
  }
  return { days, tier, new_end_date };
}

/** Upsert d'une boutique — partagé par l'inscription legacy et le handshake. */
export async function upsertShop(body) {
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
  const existing = await byDeviceId(device_id);
  if (existing) {
    await db.run(
      `UPDATE shops
       SET owner_name = $1, store_name = $2, phone = $3, location = $4,
           app_version_used = COALESCE($5, app_version_used),
           device_fingerprint = COALESCE($6, device_fingerprint),
           updated_at = $7
       WHERE id = $8`,
      owner_name,
      store_name,
      phone,
      location,
      app_version_used,
      device_fingerprint,
      now,
      existing.id,
    );
    return { shop: await byId(existing.id), status: 200 };
  }
  // Nouvelle boutique : vérifier l'unicité de l'empreinte numérique.
  if (device_fingerprint) {
    const clash = await db.get("SELECT device_id, store_name FROM shops WHERE device_fingerprint = $1", device_fingerprint);
    if (clash) {
      return {
        error: `Cet appareil est déjà enregistré sous la boutique « ${clash.store_name} » (${clash.device_id}). Un seul appareil physique par boutique.`,
        status: 409,
        code: "fingerprint_conflict",
        existing_device_id: clash.device_id,
      };
    }
  }
  await db.run(
    `INSERT INTO shops
       (device_id, owner_name, store_name, phone, location, registration_date,
        expiry_date, created_at, updated_at, app_version_used, device_fingerprint)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
  return { shop: await byDeviceId(device_id), status: 200 };
}

// ── Protocole v2 : stats réelles par projet (agrégées depuis sync_payloads) ───────
// Le dashboard affiche les données que les caisses déposent réellement. Chaque caisse
// envoie une fenêtre glissante de 7 j déjà cumulée : on ne retient donc que le DERNIER
// payload par caisse, puis on somme les totaux du projet. Top produits agrégés par nom.
// Jamais le brut : uniquement des totaux et des top produits.
export async function aggregateStats(shops) {
  const zero = { revenue: 0, profit: 0, sales: 0, items: 0, customers: 0 };
  if (shops.length === 0)
    return { generated_at: null, totals: zero, top_products: [], by_day: [], shops: [] };

  const ids = shops.map((s) => s.device_id);
  const rows = await db.all(
    `SELECT sp.device_id, sp.payload, sp.received_at
     FROM sync_payloads sp
     JOIN (SELECT device_id, MAX(received_at) AS m FROM sync_payloads GROUP BY device_id) t
       ON sp.device_id = t.device_id AND sp.received_at = t.m
     WHERE sp.device_id IN (${ids.map((_, i) => "$" + (i + 1)).join(",")})`,
    ...ids,
  );

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
export async function computeSubscriptions(accounts) {
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
    const devices = await accountDevices(account.id);
    if (devices.some((d) => d.last_sync_at && now - d.last_sync_at < ONLINE_WINDOW_MS))
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