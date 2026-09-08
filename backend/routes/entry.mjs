// Protocole v3 — routes face à la CAISSE : handshake, sync-data, demandes d'abonnement,
// webhook SMS (TextBee → auto-renouvellement). Aucune authentification dashboard ici.
import { Router } from "express";
import { randomBytes, randomUUID } from "node:crypto";
import {
  db,
  projectById,
  projectConfig,
  manifests,
  PRICE_TIERS,
  PRICE_PER_MONTH_FCFA,
  TRIAL_DAYS,
  GRACE_PERIOD_MS,
  DAY_MS,
  SMS_WEBHOOK_TOKEN,
} from "../config.mjs";
import {
  str,
  optStr,
  normPhone,
  byDeviceId,
  byId,
  accountByPhone,
  accountByKeyword,
  createAccount,
  resolveAccount,
  attachAccountForLegacy,
  mergeGroupForKey,
  normName,
  computeAccountStatus,
  deviceOverLimit,
  syncShopsFromAccount,
  publicShop,
  publicAccount,
  accountById,
  applyTierRenewal,
  tierForAmount,
  deviceBlessing,
  deviceBlessingByDevice,
  deviceBlessingsForAccount,
  upsertDeviceCredential,
} from "../lib.mjs";
import { broadcastStatus, broadcastRequest } from "./auth.mjs";
import { parseSms } from "../sms-parser.mjs";

const router = Router();

// ── Protocole v3 : handshake ───────────────────────────────────────────────────────
// Comme le v2 (« principe du tourniquet »), mais l'abonnement vit sur le COMPTE :
// plusieurs écrans partagent une même échéance et un quota de places. La caisse présente
// ses identifiants de compte (téléphone + mot de passe) ; le serveur rattache l'écran,
// calcule le statut du compte et bloque l'écran s'il dépasse les places du palier.
router.post("/api/v1/handshake", (req, res) => {
  const body = req.body ?? {};
  const device_id = str(body.device_id);
  if (!device_id) return res.status(400).json({ error: "device_id requis." });
  const now = Date.now();

  // 1. Résolution du compte. Identifiants absents (vieux build) → le compte issu de la
  //    migration est repris tel quel. Téléphone inconnu → création avec essai et plus
  //    petit palier. Mot de passe erroné → refus net : mieux vaut une erreur claire que
  //    de rattacher l'écran au compte de quelqu'un d'autre.
  const accPhone = normPhone(body.account_phone);
  const accPassword = str(body.account_password);
   let account = null;
   let accountCreated = false;
   let pendingBlessing = false;
   if (accPhone && accPassword) {
    const existing = accountByPhone(accPhone);
    if (!existing) {
      // Comptes créés hors ligne puis réconciliés ici : le premier écran à joindre le
      // serveur enregistre le compte, les suivants se rattachent avec les mêmes infos.
      const tier = PRICE_TIERS[0] ?? { price: PRICE_PER_MONTH_FCFA, devices: 1 };
      account = createAccount({
        name: optStr(body.account_name) ?? optStr(body.store_name) ?? "Boutique",
        owner_name: optStr(body.owner_name) ?? "",
        phone: accPhone,
        password: accPassword,
        max_devices: tier.devices,
        expiry_date: now + TRIAL_DAYS * DAY_MS,
      });
      accountCreated = true;
      console.log(
        `[${new Date().toISOString()}] COMPTE créé "${account.name}" (${accPhone}) par handshake — essai ${TRIAL_DAYS} j, ${tier.devices} place(s), mot clé généré`,
      );
    } else if (existing.password !== accPassword) {
      // Réclamation d'identifiants : l'écran présenté est DÉJÀ rattaché à ce compte
      // (rattachement hérité de la migration ou d'une fusion, dont le mot de passe
      // aléatoire ne connaît que le serveur). Il prouve son appartenance par son
      // device_id connu : il peut re-keyer le compte avec les identifiants choisis.
      // Tout autre écran reste refusé net — on ne rattache pas au compte du voisin.
      const memberAccount = resolveAccount(existing);
      const ownShop = byDeviceId(device_id);
      if (memberAccount && ownShop && ownShop.account_id === memberAccount.id) {
        db.prepare("UPDATE accounts SET password = ?, updated_at = ? WHERE id = ?").run(
          accPassword,
          now,
          memberAccount.id,
        );
        console.log(
          `[${new Date().toISOString()}] COMPTE re-keyé « ${memberAccount.name} » (${accPhone}) par l'écran ${device_id}`,
        );
        account = memberAccount;
      } else {
        return res.status(403).json({ error: "Mot de passe du compte incorrect.", code: "account_password" });
      }
    } else {
      // Le mot de passe se valide sur le compte présenté (la redirection garde ses
      // identifiants d'origine), puis la requête suit merged_into vers le survivant.
      account = resolveAccount(existing);
    }
  }

  // 1 bis. Résolution par MOT CLÉ de récupération : identifiants téléphone/mdp absents ou
  // hors sujet, un nouvel écran (téléphone perdu) se reconnecte avec son mot clé. Le mot
  // clé EST la clé de résolution — inconnu → rejet net `keyword_invalid` (pas de création
  // automatique, pas de fuite du champ fautif : enseigne, propriétaire et mot clé sont
  // vérifiés discrètement). Le serveur ne dévoile jamais le mot clé ensuite.
  const accKeyword = str(body.account_keyword);
  if (!account && accKeyword) {
    const existing = accountByKeyword(accKeyword);
    if (!existing) {
      return res.status(403).json({
        error:
          "Mot clé invalide : aucun compte ne correspond à ces informations. Vérifiez le nom de la boutique, le propriétaire et le mot clé.",
        code: "keyword_invalid",
      });
    }
    account = resolveAccount(existing);
    console.log(
      `[${new Date().toISOString()}] MOT CLÉ accepté : écran ${device_id} rattaché au compte « ${account.name} » (#${account.id})`,
    );
  }

  // 1 ter. Résolution par LIEN de partage (jeton relay + bénédiction propriétaire) :
  // l'écran invité présente account_phone SANS mot de passe. S'il a déjà été
  // bénédictionné, on authentifie et on génère un secret par-appareil. Sinon on
  // marque le lien en attente (pending_blessing) — aucun compte hérité n'est créé.
  if (!account && accPhone && !accPassword) {
    const blessing = deviceBlessingByDevice(device_id);
    if (blessing) {
      const ownerAcc = accountById(blessing.account_id);
      if (ownerAcc) {
        account = resolveAccount(ownerAcc);
        const secret = upsertDeviceCredential(device_id, account.id);
        // les handshakes suivants s'authentifient via ce secret
        pendingBlessing = false;
        console.log(
          `[${new Date().toISOString()}] LIEN accepté : écran ${device_id} rattaché au compte « ${account.name} » (#${account.id})`,
        );
      }
    } else {
      pendingBlessing = true;
    }
  }

  // 2. Fiche boutique : mise à jour douce des champs fournis, création si inconnue
  //    (jamais d'erreur bloquante) — inchangé depuis le v2.
  const app_version_used = optStr(body.app_version);
  const app_origin = str(body.app_origin) || "pos";
  const device_fingerprint = optStr(body.device_fingerprint);

  // Le projet cible est créé s'il n'existe pas : une caisse qui arrive avec un
  // app_origin inconnu est rattachée à un projet auto-créé (mot de passe aléatoire),
  // que l'administrateur reprend ensuite dans son dashboard master. Si un manifest
  // existe pour cet app_origin, il fixe d'emblée nom, type et tarif du projet.
  if (!projectById(app_origin)) {
    const m = manifests.get(app_origin);
    db.prepare(
      `INSERT INTO projects (id, name, password, created_at, type, price_per_month_fcfa, trial_days)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      app_origin,
      m?.name ?? app_origin,
      randomBytes(8).toString("hex"),
      now,
      m?.type ?? null,
      m?.pricing?.price_per_month_fcfa ?? null,
      m?.pricing?.trial_days ?? null,
    );
    console.log(
      `[${new Date().toISOString()}] PROJET auto-créé "${app_origin}"${m ? ` (manifest « ${m.name} »)` : ""} (mot de passe aléatoire) — à sécuriser depuis le dashboard master`,
    );
  }

  const projectCfg = projectConfig(app_origin);

  let shop = byDeviceId(device_id);
  if (shop) {
    db.prepare(
      `UPDATE shops SET
         owner_name     = COALESCE(?, owner_name),
         store_name     = COALESCE(?, store_name),
         phone          = COALESCE(?, phone),
         location       = COALESCE(?, location),
         app_version_used = COALESCE(?, app_version_used),
         device_fingerprint = COALESCE(?, device_fingerprint),
         app_origin     = ?,
         updated_at     = ?
       WHERE id = ?`,
    ).run(
      optStr(body.owner_name),
      optStr(body.store_name),
      optStr(body.phone),
      optStr(body.location),
      app_version_used,
      device_fingerprint,
      app_origin,
      now,
      shop.id,
    );
    shop = byId(shop.id);
  } else {
    // Vérification de l'empreinte : un appareil physique ne peut créer qu'une seule boutique.
    if (device_fingerprint) {
      const clash = db.prepare("SELECT device_id, store_name FROM shops WHERE device_fingerprint = ?").get(device_fingerprint);
      if (clash) {
        return res.status(409).json({
          error: `Cet appareil est déjà enregistré sous la boutique « ${clash.store_name} » (${clash.device_id}). Un seul appareil physique par boutique.`,
          code: "fingerprint_conflict",
          existing_device_id: clash.device_id,
        });
      }
    }
    db.prepare(
      `INSERT INTO shops
         (device_id, owner_name, store_name, phone, location, registration_date,
          expiry_date, created_at, updated_at, app_version_used, app_origin, device_fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      device_id,
      optStr(body.owner_name) ?? "",
      optStr(body.store_name) ?? "Boutique",
      optStr(body.phone),
      optStr(body.location),
      now,
      now + projectCfg.trial_days * DAY_MS,
      now,
      now,
      app_version_used,
      app_origin,
      device_fingerprint,
    );
    shop = byDeviceId(device_id);
  }

  // 3. Rattachement au compte. Sans identifiants ni compte migré, un compte individuel
  //    est créé dans la foulée ; l'échéance d'essai de la fiche devient celle du compte.
  if (account && shop.account_id !== account.id) {
    db.prepare("UPDATE shops SET account_id = ? WHERE id = ?").run(account.id, shop.id);
    shop = byId(shop.id);
  }
  if (!account) {
    if (pendingBlessing) {
      // Pas de compte hérité : l'écran attend la bénédiction du propriétaire.
    } else if (!shop.account_id || !accountById(shop.account_id)) {
      account = attachAccountForLegacy(shop);
    } else {
      account = accountById(shop.account_id);
    }
  }

  // 3 bis. Convergence par nom d'enseigne : si d'autres comptes portent des boutiques
   // du même nom, tout le monde rejoint le compte le plus ancien — un seul
   // abonnement par enseigne, quota compté sur le survivant, écrans en trop coupés.
   // (Le démarrage fait la même passe pour toute la base ; ici on rattrape le cas
   // venant de naître, ex. deux téléphones différents pour la même boutique.)
   const nameKey = normName(shop.store_name);
   if (nameKey) {
     const survivor = mergeGroupForKey(nameKey);
     if (survivor && survivor.id !== shop.account_id) {
       db.prepare("UPDATE shops SET account_id = ? WHERE id = ?").run(survivor.id, shop.id);
     }
     if (survivor) {
       account = survivor;
       shop = byId(shop.id);
     }
   }

   // Si l'appareil est en attente de bénédiction : pas de compte, pas de
   // création héritée — l'écran reste fonctionnel (données locales + pull
   // du groupe) mais le handshake échoue avec pending_blessing jusqu'à
   // ce que le propriétaire l'ait validé (POST /api/v1/account/bless).
   if (pendingBlessing) {
     return res.json({ status: "pending_blessing", pending_blessing: true, commands: [] });
   }

   // 4. Accusé de réception implicite — mécanique v2 étendue aux commandes adressées au
  //    compte : tout ce qui précède le dernier ordre appliqué est marqué livré.
  const lastId = str(body.last_applied_command_id);
  if (lastId) {
    const last = db.prepare("SELECT created_at FROM admin_commands WHERE id = ?").get(lastId);
    if (last) {
      db.prepare(
        `UPDATE admin_commands SET delivered_at = ?
         WHERE delivered_at IS NULL AND created_at <= ?
           AND (device_id = ? OR (account_id IS NOT NULL AND account_id = ?))`,
      ).run(now, last.created_at, device_id, shop.account_id);
    }
  }

  // 5. Statut du COMPTE + quota de places. L'écran en trop est traité comme suspendu :
  //    pas de sync, verrou côté caisse, raison explicite pour l'écran de blocage.
  const st = computeAccountStatus(account);
  const overLimit = deviceOverLimit(account, device_id);
  const effective = overLimit ? "suspended" : st;

  // 6. Miroir : la fiche boutique reflète le compte (routes legacy et vieux builds).
  if (
    shop.expiry_date !== account.expiry_date ||
    (shop.suspended_at ?? null) !== (account.suspended_at ?? null)
  ) {
    syncShopsFromAccount(account.id);
    shop = byId(shop.id);
  }

  // Temps réel : chaque tableau de bord connecté (SSE) voit ce client arriver,
  // dans son projet si sa session y est limitée.
  broadcastStatus(device_id, now);

  // Statut de la dernière demande d'abonnement du compte : la caisse l'affiche dans
  // Paramètres (« en attente de validation », « validée le … »). Absent s'il n'y en a
  // jamais eu — un serveur plus ancien n'expose pas ce champ non plus.
  const lastRequest = shop.account_id
    ? db
        .prepare(
          `SELECT status, plan_price, plan_devices, reference, created_at, decided_at
           FROM subscription_requests WHERE account_id = ? AND status != 'superseded'
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(shop.account_id)
    : null;

  const commands = db
    .prepare(
      `SELECT id, action_type, payload, expires_at, created_at
       FROM admin_commands
       WHERE (device_id = ? OR account_id = ?)
         AND delivered_at IS NULL AND superseded_at IS NULL AND expires_at > ?
       ORDER BY created_at ASC`,
    )
    .all(device_id, shop.account_id, now)
    .map((c) => ({ ...c, payload: JSON.parse(c.payload) }));

  res.json({
    status: effective,
    sync_allowed: effective === "active" || effective === "grace",
    over_limit: overLimit,
    ...(overLimit ? { reason: "device_limit" } : {}),
    // Le mot clé de récupération n'est renvoyé QU'AU MOMENT DE LA CRÉATION : l'écran qui
    // vient d'inscrire le compte est le seul qui le voit — il doit le conserver. Les
    // handshakes suivants ne le redonnent jamais.
    ...(accountCreated ? { keyword: account.keyword } : {}),
    // Grace period : le compte a expiré mais bénéficie encore de 2 jours de tolérance.
    // L'application reste 100% fonctionnelle — pas de blocage, pas de restriction.
    ...(effective === "grace"
      ? { grace_period: true, grace_ends_at: account.expiry_date + GRACE_PERIOD_MS }
      : {}),
    commands,
    ...(lastRequest ? { subscription_request: lastRequest } : {}),
    shop: {
      ...publicShop(shop),
      // L'échéance qui fait foi est celle du COMPTE : les clients v2 comme v3 s'y calent.
      subscription_end_date: account.expiry_date,
      expiry_date: account.expiry_date,
    },
    account: publicAccount(account),
  });
});

// ── Protocole v3 : sync-data (stockage brut, gated sur le statut du compte) ────────
router.post("/api/v1/sync-data", (req, res) => {
  const body = req.body ?? {};
  const device_id = str(body.device_id);
  if (!device_id || body.data_payload === undefined)
    return res.status(400).json({ error: "device_id et data_payload requis." });

  const shop = byDeviceId(device_id);
  const account = shop?.account_id ? accountById(shop.account_id) : null;
  // 403 SANS rien écrire : une caisse suspendue, expirée (hors grace) ou en dépassement
  // de quota ne dépose aucune donnée. Les comptes en grace period restent fonctionnels.
  const accountStatus = account ? computeAccountStatus(account) : "unknown";
  if (
    !shop ||
    !account ||
    (accountStatus !== "active" && accountStatus !== "grace") ||
    deviceOverLimit(account, device_id)
  ) {
    return res.status(403).json({ error: "Compte suspendu ou expiré.", status: "blocked" });
  }

  const origin = typeof body.app_origin === "string" && body.app_origin.trim() ? body.app_origin.trim() : "pos";
  const now = Date.now();
  db.prepare(
    "INSERT INTO sync_payloads (device_id, app_origin, payload, received_at) VALUES (?, ?, ?, ?)",
  ).run(device_id, origin, JSON.stringify(body.data_payload), now);
  db.prepare("UPDATE shops SET last_sync_at = ?, updated_at = ? WHERE id = ?").run(now, now, shop.id);

  // Accumulation du CA par jour : la fenêtre glissante de 7 j permet de reconstituer le
  // CA mensuel de chaque caisse sans rien demander de plus à l'app. On écrase la valeur
  // du jour à chaque sync (idempotent) ; `day` est le minuit LOCAL de l'appareil, en ms.
  const by_day = Array.isArray(body.data_payload?.by_day) ? body.data_payload.by_day : [];
  for (const d of by_day) {
    const day = Math.round(Number(d?.day));
    if (!Number.isFinite(day) || day <= 0) continue;
    db.prepare(
      `INSERT INTO daily_stats (device_id, day, revenue, profit, sales, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id, day) DO UPDATE SET
         revenue = excluded.revenue,
         profit  = excluded.profit,
         sales   = excluded.sales,
         updated_at = excluded.updated_at`,
    ).run(device_id, day, Number(d.revenue) || 0, Number(d.profit) || 0, Number(d.sales) || 0, now);
  }

  res.json({ ok: true, received_at: now, status: "active" });
});

// ── Demandes d'abonnement (dépôt public par la caisse) ─────────────────────────────
// La caisse vient de payer par mobile money : elle dépose le palier choisi + la
// référence de transaction. Le serveur résout le COMPTE via l'écran (device_id →
// shops.account_id) — aucun identifiant de compte requis, une caisse en essai ou
// rattachée par migration peut donc demander tout autant. Le dashboard valide ensuite
// EN UN CLIC (POST /api/v1/admin/requests/:id/approve), ce qui applique exactement
// une « Prolongation par montant » au compte.
router.post("/api/v1/requests", (req, res) => {
  const body = req.body ?? {};
  const device_id = str(body.device_id);
  const plan_price = Math.round(Number(body.plan_price));
  const plan_devices = Math.round(Number(body.plan_devices));
  if (!device_id) return res.status(400).json({ error: "device_id requis." });
  if (!Number.isFinite(plan_price) || plan_price <= 0)
    return res.status(400).json({ error: "plan_price invalide." });

  const shop = byDeviceId(device_id);
  if (!shop)
    return res.status(404).json({ error: "Écran inconnu du serveur — effectuez d'abord un handshake." });
  // Rattrapage legacy : garantit que la fiche a un compte avant de créer la demande.
  const account = accountById(attachAccountForLegacy(shop).account_id);
  if (!account) return res.status(409).json({ error: "Cette boutique n'a pas encore de compte." });

  const now = Date.now();
  // Une seule demande pending par compte : une nouvelle demande remplace l'ancienne
  // (le marchand a changé de palier entre-temps), l'historique reste intact.
  db.prepare(
    "UPDATE subscription_requests SET status = 'superseded' WHERE account_id = ? AND status = 'pending'",
  ).run(account.id);
  const info = db
    .prepare(
      `INSERT INTO subscription_requests
         (account_id, device_id, store_name, owner_name, plan_name, plan_price, plan_devices, reference, note, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(
      account.id,
      device_id,
      shop.store_name ?? "",
      shop.owner_name ?? "",
      str(body.plan_name),
      plan_price,
      Number.isFinite(plan_devices) && plan_devices > 0 ? plan_devices : 0,
      str(body.reference),
      String(body.note ?? "").slice(0, 500),
      now,
    );
  const request = db
    .prepare("SELECT * FROM subscription_requests WHERE id = ?")
    .get(Number(info.lastInsertRowid));
  console.log(
    `[${new Date().toISOString()}] DEMANDE #${request.id} « ${shop.store_name} » (${account.name}) — ${plan_price.toLocaleString("fr-FR")} F, réf. ${str(body.reference) || "—"}`,
  );
  broadcastRequest(request);
  res.status(201).json({
    ok: true,
    request: { id: request.id, status: request.status, created_at: request.created_at },
  });
});

// ── Webhook SMS (TextBee → auto-renouvellement d'abonnement) ─────────────────────
// TextBee forward chaque SMS reçu sur l'appareil vers cette URL. Le serveur :
//   1. vérifie le token secret (?token=),
//   2. parse le SMS (montant, téléphone, nom, TID),
//   3. l'inclut dans sms_payments (TID UNIQUE = 1 traitement par transaction),
//   4. match le téléphone → compte, et le montant → palier,
//   5. si tout correspond → applyTierRenewal() = ABONNEMENT RENOUVELÉ automatiquement.
// Réponse 200 TOUJOURS après insertion : TextBee cesse ses retries. Un SMS non
// conforme est stocké en 'unmatched' pour révision admin, jamais perdu.
router.post("/api/v1/webhook/sms", (req, res) => {
  if (str(req.query.token) !== SMS_WEBHOOK_TOKEN) {
    return res.status(401).json({ error: "Token webhook invalide." });
  }
  const body = req.body ?? {};
  // Formes acceptées (selon le payload TextBee) : { sms }, { message }, { text }, { body }.
  const raw = [body.sms ?? body.message ?? body.text ?? body.body ?? body.content]
    .flat()
    .find((s) => typeof s === "string" && s.trim().length > 0);
  if (!raw) return res.status(400).json({ error: "Aucun SMS reçu." });

  const parsed = parseSms(raw);
  if (!parsed) {
    // SMS non-paiement (marketing, OTP…) : on accuse réception sans le stocker.
    return res.json({ ok: true, ignored: "not_a_payment_sms" });
  }

  const now = Date.now();
  const received_at = Number(body.received_at ?? body.timestamp ?? body.receivedAt) || now;

  // Idempotence : l'insertion échoue si le TID existe déjà (UNIQUE). On bascule alors
  // la ligne existante en 'duplicate' et on arrête — jamais de double renouvellement.
  let info;
  try {
    info = db
      .prepare(
        `INSERT INTO sms_payments (raw_sms, phone, name, amount_fcfa, tid, status, received_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      )
      .run(raw.slice(0, 500), parsed.phone, parsed.name, parsed.amount, parsed.tid, received_at, now);
  } catch (e) {
    if (String(e?.code ?? e?.message).includes("UNIQUE")) {
      db.prepare(
        "UPDATE sms_payments SET processed_at = ?, error = 'transaction déjà reçue' WHERE tid = ? AND status = 'pending'",
      ).run(now, parsed.tid);
      return res.json({ ok: true, duplicate: true, tid: parsed.tid });
    }
    throw e;
  }
  const paymentId = Number(info.lastInsertRowid);

  // ── Matching automatique ────────────────────────────────────────────────────────
  // Téléphone exact d'abord ; sinon essai sans l'indicatif local (0 suivi d'un 9xx).
  let account = accountByPhone(parsed.phone);
  if (!account && /^0\d{8,9}$/.test(parsed.phone)) account = accountByPhone(parsed.phone.slice(1));
  const tier = tierForAmount(parsed.amount);

  if (account && tier) {
    applyTierRenewal(account, parsed.amount, now);
    db.prepare(
      "UPDATE sms_payments SET status = 'processed', matched_account_id = ?, matched_tier_price = ?, processed_at = ? WHERE id = ?",
    ).run(account.id, tier.price, now, paymentId);
    console.log(
      `[${new Date().toISOString()}] SMS #${paymentId} AUTO-RENOUVELLEMENT « ${account.name} » (${parsed.phone}) — ${parsed.amount.toLocaleString("fr-FR")} F, TID ${parsed.tid}`,
    );
    return res.json({ ok: true, status: "processed", account_id: account.id, payment_id: paymentId });
  }

  const errorReason = !account
    ? "téléphone inconnu — aucun compte associé"
    : "montant ne correspond à aucun palier (10 000 / 25 000 / 50 000 F)";
  db.prepare(
    "UPDATE sms_payments SET status = 'unmatched', error = ?, processed_at = ? WHERE id = ?",
  ).run(errorReason, now, paymentId);
  console.log(
    `[${new Date().toISOString()}] SMS #${paymentId} NON MATCHÉ (${errorReason}) — « ${parsed.name} » (${parsed.phone}) ${parsed.amount} F, TID ${parsed.tid}`,
  );
  return res.json({ ok: true, status: "unmatched", payment_id: paymentId, error: errorReason });
});

// ── Protocole : bénédiction d'un appareil invité ───────────────────────────
// Le propriétaire authentifie sa caisse (téléphone + mot de passe du
// compte) et désigne l'appareil cible (device_id de l'employé). Le serveur
// rattache la fiche de l'employé au compte et la marque bénissionée.
router.post("/api/v1/account/bless", (req, res) => {
  const ownerPhone = normPhone(str(req.body?.account_phone));
  const ownerPassword = str(req.body?.account_password);
  const targetDeviceId = str(req.body?.target_device_id);
  if (!ownerPhone || !ownerPassword || !targetDeviceId)
    return res.status(400).json({ error: "account_phone, account_password, target_device_id requis." });
  const existing = accountByPhone(ownerPhone);
  if (!existing || existing.password !== ownerPassword)
    return res.status(403).json({ error: "Identifiants du compte incorrects." });
  const account = resolveAccount(existing);
  if (!account) return res.status(404).json({ error: "Compte introuvable." });
  // la caisse bénédictionne est déjà membre du compte (owner)
  const ownerShop = byDeviceId(targetDeviceId);
  // target_device_id doit être un appareil existant (l'employé a déjà fait un handshake)
  if (!ownerShop) return res.status(404).json({ error: "Appareil cible inconnu — l'employé doit d'abord se présenter." });
  deviceBlessing(targetDeviceId, account.id, ownerShop.device_id);
  console.log(`[${new Date().toISOString()}] BÉNISSION : appareil ${targetDeviceId} → compte "${account.name}" (#${account.id}) par ${ownerShop.device_id}`);
  res.json({ status: "blessed", account_id: account.id, account_name: account.name });
});

export default router;
