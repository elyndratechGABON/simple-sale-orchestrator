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
  OPS_RELAY_URL,
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
  hashPassword,
  verifyPassword,
  deviceBlessing,
  deviceBlessingByDevice,
  deviceBlessingsForAccount,
  upsertDeviceCredential,
  deviceCredentialForDevice,
  canReleaseSeat,
  releaseShopSeat,
  accountAnchorDevice,
  maintenanceState,
  signableProofBody,
  verifyProofSignature,
} from "../lib.mjs";
import { broadcastStatus, broadcastRequest } from "./auth.mjs";
import { parseSms } from "../sms-parser.mjs";

const router = Router();

// ── Protocole v3 : handshake ───────────────────────────────────────────────────────
// Comme le v2 (« principe du tourniquet »), mais l'abonnement vit sur le COMPTE :
// plusieurs écrans partagent une même échéance et un quota de places. La caisse présente
// ses identifiants de compte (téléphone + mot de passe) ; le serveur rattache l'écran,
// calcule le statut du compte et bloque l'écran s'il dépasse les places du palier.
router.post("/api/v1/handshake", async (req, res) => {
  const body = req.body ?? {};
  const device_id = str(body.device_id);
  if (!device_id) return res.status(400).json({ error: "device_id requis." });
  const now = Date.now();

  // 0. Empreinte de l'appareil — « un appareil physique = une boutique » est une règle
  //    d'ACCÈS, pas une étape de la création du compte : chaque chemin de résolution
  //    l'applique AVANT d'écrire (création de compte, fiche boutique), pour qu'un refus
  //    ne laisse ni compte fantôme ni fiche orpheline. La règle distingue les deux
  //    cas légitimes de réclamation d'une empreinte déjà posée :
  //    — l'écran revient au COMPTE de la fiche contradictoire (réinstallation, même
  //      équipe) : passe ;
  //    — la fiche contradictoire est un EMPLOYÉ (non fondateur de son compte) : son
  //      poste d'empreinte est libéré (device_fingerprint NULL) et la réclamation
  //      passe — réinstaller doit permettre de rejoindre une autre boutique, pas
  //      rester muré pour toujours sur son ancien poste.
  //    Seul le FONDATEUR (écran le plus ancien du compte) fait mur d'un compte rival :
  //    refus 409 net, rien d'écrit.
  const device_fingerprint = optStr(body.device_fingerprint);
  const fingerprintBlock = async (deviceId, fingerprint, presentedAccount) => {
    if (!fingerprint) return null;
    const known = await byDeviceId(deviceId);
    if (known) return null;
    const clash = await db.get(
      "SELECT device_id, store_name, account_id FROM shops WHERE device_fingerprint = $1",
      fingerprint,
    );
    if (!clash) return null;
    // Un compte présenté (mot de passe ou mot clé validé) réclame l'empreinte :
    // fiche migrée (account_id NULL — l'équipe d'origine est perdue) → rattachée
    // au compte présenté, son poste d'empreinte libéré ; même équipe (réinstalla-
    // tion) → passe. Les fiches au compte différent restent soumises à la règle
    // du fondateur (cf. « 0. ») : un mur correct n'est pas un mur systématique.
    if (presentedAccount && !clash.account_id) {
      // Fiche SANS compte (l'équipe d'origine est perdue) : l'écran qui réclame
      // l'empreinte la RÉCUPÈRE — on l'attache au compte présenté, on prend son
      // device_id ET on la RÉACTIVE si elle avait été libérée. Libérer l'empreinte
      // et laisser la fiche derrière créait un trou : l'écran revenait dans une
      // NOUVELLE fiche et l'ancienne restait orpheline pour toujours.
      await db.run(
        "UPDATE shops SET account_id = $1, device_id = $2, released_at = NULL, updated_at = $3 WHERE device_id = $4",
        presentedAccount.id,
        deviceId,
        Date.now(),
        clash.device_id,
      );
      return null;
    }
    if (presentedAccount && clash.account_id === presentedAccount.id) {
      // MÊME commerce, MÊME appareil physique : l'empreinte est la sienne, il
      // RÉATTRIBUE sa fiche — et la RÉACTIVE si elle avait été LIBÉRÉE (il revient :
      // sa place lui revient, pas de nouvelle fiche, pas de trou).
      await db.run(
        "UPDATE shops SET device_id = $1, released_at = NULL, updated_at = $2 WHERE device_id = $3",
        deviceId,
        Date.now(),
        clash.device_id,
      );
      return null;
    }
    if (clash.account_id) {
      const anchor = await db.get(
        "SELECT device_id FROM shops WHERE account_id = $1 ORDER BY registration_date ASC LIMIT 1",
        clash.account_id,
      );
      if (anchor && anchor.device_id !== clash.device_id) {
        await db.run(
          "UPDATE shops SET device_fingerprint = NULL, updated_at = $1 WHERE device_id = $2",
          Date.now(),
          clash.device_id,
        );
        return null;
      }
    }
    console.warn(
      `[${new Date().toISOString()}] EMPREINTE refusée : ${deviceId} (${fingerprint.slice(0, 12)}…) ` +
        `correspond à « ${clash.store_name} » (${clash.device_id}) — aucun compte créé`,
    );
    return {
      status: 409,
      payload: {
        error: `Cet appareil est déjà enregistré sous la boutique « ${clash.store_name} » (${clash.device_id}). Un seul appareil physique par boutique.`,
        code: "fingerprint_conflict",
        existing_device_id: clash.device_id,
      },
    };
  };

  let shop = await byDeviceId(device_id);

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
    const existing = await accountByPhone(accPhone);
    if (!existing) {
      // Le contrôle d'empreinte PRÉCÈDE la création : un refus 409 ne laisse aucun
      // compte fantôme (aucune boutique, invisible au tableau de bord).
      const blocked = await fingerprintBlock(device_id, device_fingerprint, null);
      if (blocked) return res.status(blocked.status).json(blocked.payload);
      // Même relecture après le contrôle : si l'empreinte a été réattribuée, la
      // fiche existe désormais pour cet écran (sinon l'INSERT violerait l'index UNIQUE).
      shop = await byDeviceId(device_id);
      // Comptes créés hors ligne puis réconciliés ici : le premier écran à joindre le
      // serveur enregistre le compte, les suivants se rattachent avec les mêmes infos.
      const tier = PRICE_TIERS[0] ?? { price: PRICE_PER_MONTH_FCFA, devices: 1 };
      account = await createAccount({
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
    } else if (!verifyPassword(accPassword, existing.password)) {
      // Réclamation d'identifiants : l'écran présenté est DÉJÀ rattaché à ce compte
      // (rattachement hérité de la migration ou d'une fusion, dont le mot de passe
      // aléatoire ne connaît que le serveur). Il prouve son appartenance par son
      // device_id connu : il peut re-keyer le compte avec les identifiants choisis.
      // Tout autre écran reste refusé net — on ne rattache pas au compte du voisin.
      const memberAccount = await resolveAccount(existing);
      const ownShop = await byDeviceId(device_id);
      if (memberAccount && ownShop && ownShop.account_id === memberAccount.id) {
        // HACHÉ, jamais en clair : la colonne ne doit contenir qu'un condensat. Un
        // `SELECT *` sur la base ne doit jamais rendre un mot de passe lisible.
        await db.run(
          "UPDATE accounts SET password = $1, updated_at = $2 WHERE id = $3",
          await hashPassword(accPassword),
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
      account = await resolveAccount(existing);
    }
  }

  // 1 bis. Résolution par MOT CLÉ de récupération : identifiants téléphone/mdp absents ou
  // hors sujet, un nouvel écran (téléphone perdu) se reconnecte avec son mot clé. Le mot
  // clé EST la clé de résolution — inconnu → rejet net `keyword_invalid` (pas de création
  // automatique, pas de fuite du champ fautif : enseigne, propriétaire et mot clé sont
  // vérifiés discrètement). Le serveur ne dévoile jamais le mot clé ensuite.
  const accKeyword = str(body.account_keyword);
  if (!account && accKeyword) {
    const existing = await accountByKeyword(accKeyword);
    if (!existing) {
      return res.status(403).json({
        error:
          "Mot clé invalide : aucun compte ne correspond à ces informations. Vérifiez le nom de la boutique, le propriétaire et le mot clé.",
        code: "keyword_invalid",
      });
    }
    account = await resolveAccount(existing);
    console.log(
      `[${new Date().toISOString()}] MOT CLÉ accepté : écran ${device_id} rattaché au compte « ${account.name} » (#${account.id})`,
    );
  }

  // 1 ter. Résolution par LIEN de partage (jeton relay + bénédiction propriétaire) :
  // l'écran invité présente account_phone SANS mot de passe. S'il a déjà été
  // bénédictionné, on authentifie et on génère un secret par-appareil. Sinon, il
  // attend l'approbation manuelle du propriétaire (POST /api/v1/account/bless) —
  // un code déclaré ne bénit JAMAIS seul : la preuve d'appartenance reste le geste
  // du propriétaire, pas un champ que n'importe qui peut recopier.
  if (!account && accPhone && !accPassword) {
    // 1. Bénédiction existante pour cet appareil ?
    const blessing = await deviceBlessingByDevice(device_id);
    if (blessing) {
      const ownerAcc = await accountById(blessing.account_id);
      if (ownerAcc) {
        account = await resolveAccount(ownerAcc);
        // Le secret par-appareil n'est CRÉÉ qu'une fois. Le re-hacher à chaque
        // handshake coûtait un argon2 (timeout côté plateforme) ; et l'appel était
        // resté ici sans son import — ReferenceError, donc AUCUNE réponse au
        // handshake : l'écran restait bloqué « en attente de bénédiction » pour
        // toujours, et le patron le voyait comme un poste fantôme.
        if (!(await deviceCredentialForDevice(device_id))) {
          await upsertDeviceCredential(device_id, account.id);
        }
        pendingBlessing = false;
        console.log(
          `[${new Date().toISOString()}] LIEN accepté : écran ${device_id} rattaché au compte « ${account.name} » (#${account.id})`,
        );
      }
    } else {
      pendingBlessing = true;
    }
  }

  // 1 quater. Empreinte appliquée pour les chemins déjà résolus (mdp valide, mot clé,
  //    bénédiction, héritage) — la création par identifiants inconnus l'a fait en
  //    ligne (cf. branche de création). Le compte présenté, s'il existe, autorise le
  //    retour de l'écran dans SA propre équipe (réinstallation). Une attente de
  //    bénédiction n'a RIEN écrit encore : le mur ne la frappe pas — l'écran invité
  //    attend la décision du propriétaire, la fiche en attente est créée sans posé
  //    d'empreinte disputée, et le conflit sera tranché au geste du propriétaire.
  if (!pendingBlessing) {
    const blocked = await fingerprintBlock(device_id, device_fingerprint, account);
    if (blocked) return res.status(blocked.status).json(blocked.payload);
    // La réattribution vient peut-être de faire de cette fiche CELLE de cet écran
    // (l'empreinte a été récupérée). `shop` a été lu AVANT : sans cette relecture,
    // le code partait en INSERT et violait l'index UNIQUE sur device_id.
    shop = await byDeviceId(device_id);
  }

  // 2. Fiche boutique : mise à jour douce des champs fournis, création si inconnue
  //    (jamais d'erreur bloquante) — inchangé depuis le v2. L'empreinte a déjà été
  //    contrôlée (cf. « 0. » et « 1 quater. ») : ici, un `device_id` inconnu qui passe
  //    la porte est forcément un appareil inédit.
  const app_version_used = optStr(body.app_version);
  const app_origin = str(body.app_origin) || "pos";

  // Le projet cible est créé s'il n'existe pas : une caisse qui arrive avec un
  // app_origin inconnu est rattachée à un projet auto-créé (mot de passe aléatoire),
  // que l'administrateur reprend ensuite dans son dashboard master. Si un manifest
  // existe pour cet app_origin, il fixe d'emblée nom, type et tarif du projet.
  if (!(await projectById(app_origin))) {
    const m = manifests.get(app_origin);
    await db.run(
      `INSERT INTO projects (id, name, password, created_at, type, price_per_month_fcfa, trial_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
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

  const projectCfg = await projectConfig(app_origin);

  // L'empreinte qu'on va écrire ne doit pas être déjà portée par une AUTRE fiche
  // (index UNIQUE) : l'écrire quand même ferait échouer le handshake en 500, et un
  // écran qui ne peut plus se présenter apparaît comme un poste MORT dans la console.
  // On la laisse donc de côté : l'empreinte sert à reconnaître le matériel, pas à
  // faire échouer la synchronisation.
  let fingerprintAWrite = pendingBlessing ? null : device_fingerprint;
  if (fingerprintAWrite) {
    const dejaPortee = await db.get(
      "SELECT device_id FROM shops WHERE device_fingerprint = $1 AND device_id <> $2",
      fingerprintAWrite,
      device_id,
    );
    if (dejaPortee) {
      console.warn(
        `[${new Date().toISOString()}] EMPREINTE déjà portée par ${dejaPortee.device_id} — on ne la réécrit pas sur ${device_id}`,
      );
      fingerprintAWrite = null;
    }
  }

  if (shop) {
    await db.run(
      `UPDATE shops SET
         owner_name     = COALESCE($1, owner_name),
         store_name     = COALESCE($2, store_name),
         phone          = COALESCE($3, phone),
         location       = COALESCE($4, location),
         app_version_used = COALESCE($5, app_version_used),
          device_fingerprint = COALESCE($6, device_fingerprint),
          app_origin     = $7,
          updated_at     = $8,
          public_key    = COALESCE($10, public_key),
          -- Le NOM et le NUMÉRO de l'écran (l'employé qui a scanné le QR du patron).
          -- COALESCE : une saisie VIDE ne remplace pas un nom déjà connu — seule une
          -- valeur non vide met à jour la fiche.
          employee_name  = COALESCE($11, employee_name),
          employee_phone = COALESCE($12, employee_phone)
       WHERE id = $9`,
      optStr(body.owner_name),
      optStr(body.store_name),
      optStr(body.phone),
      optStr(body.location),
      app_version_used,
      // COALESCE : une attente de bénédiction ne pose pas d'empreinte disputée
      // (cf. INSERT ci-dessous) — la fiche existante garde la sienne. Et si l'empreinte
      // est déjà portée ailleurs, on ne l'écrit pas (cf. `fingerprintAWrite`).
      fingerprintAWrite,
      app_origin,
      now,
      shop.id,
      // La clé PUBLIQUE de l'appareil : c'est elle qui permet au serveur de vérifier
      // ce que l'écran lui envoie (une preuve de paiement signée, par exemple). Elle
      // est VOLONTAIREMENT écrite à chaque handshake : une rotation de clé ne doit pas
      // laisser l'écran incapable de prouver quoi que ce soit.
      optStr(body.device_public_key),
      // Le nom et le numéro de l'écran : transmis par la caisse au handshake
      // (l'employé les saisit au scan du QR). Vides si l'écran ne les a jamais saisis.
      optStr(body.employee_name),
      optStr(body.employee_phone),
    );
    shop = await byId(shop.id);
  } else {
    // Un écran qui se présente en ATTENTE DE BÉNÉDICTION (ni mot de passe, ni bénédiction
    // connue) laisse une fiche sans empreinte. Si la MÊME boutique a déjà une telle
    // fiche en attente, c'est le même écran qui se ré-annonce après une réinitialisation
    // d'identité : on libère l'ancienne. Sans cela, chaque réinitialisation laissait
    // un écran fantôme compter comme employé et occuper une place pendant 7 jours.
    if (pendingBlessing) {
      const twins = await db.all(
        `SELECT id, device_id FROM shops
          WHERE released_at IS NULL
            AND device_fingerprint IS NULL
            AND coalesce(employee_name, '') = ''
            AND coalesce(owner_name, '') = ''
            AND lower(trim(coalesce(store_name, ''))) = lower(trim($1))
            AND coalesce(phone, '') = coalesce($2, '')`,
        optStr(body.store_name) ?? "",
        optStr(body.phone),
      );
      for (const t of twins) {
        await db.run(`UPDATE shops SET released_at = $1 WHERE id = $2`, now, t.id);
        console.log(
          `[${new Date().toISOString()}] DOUBLON D'APPAIRAGE : libération de l'attente de bénédiction ${t.device_id} (supersédée par ${device_id})`,
        );
      }
    }
    await db.run(
      `INSERT INTO shops
         (device_id, owner_name, store_name, phone, location, registration_date,
          expiry_date, created_at, updated_at, app_version_used, app_origin, device_fingerprint, public_key,
          employee_name, employee_phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
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
      // Une fiche en attente de bénédiction ne prend pas d'empreinte disputée :
      // l'index UNIQUE rendrait l'insertion impossible (500) — l'empreinte
      // sera posée au prochain handshake APRÈS la bénédiction, au moment où
      // le mur tranche le conflit via le compte désormais résolu.
      fingerprintAWrite,
      // La clé publique de l'appareil (voir l'UPDATE ci-dessus).
      optStr(body.device_public_key),
      // Le nom et le numéro de l'écran : saisis par l'employé au scan du QR et
      // transmis au handshake. Vides s'il ne les a pas saisis.
      optStr(body.employee_name),
      optStr(body.employee_phone),
    );
    shop = await byDeviceId(device_id);
  }

  // 3. Rattachement au compte. Sans identifiants ni compte migré, un compte individuel
  //    est créé dans la foulée ; l'échéance d'essai de la fiche devient celle du compte.
  if (account && shop.account_id !== account.id) {
    await db.run("UPDATE shops SET account_id = $1 WHERE id = $2", account.id, shop.id);
    shop = await byId(shop.id);
  }
  if (!account) {
    // NOUVEAU : si le handshake fournit un account_phone et qu'un compte existe déjà,
    // on rattache l'appareil à ce compte existant au lieu d'en créer un nouveau.
    // Cela garantit qu'un employé qui scanne un QR de propriétaire rejoint le bon
    // compte et n'est pas créé comme propriétaire d'une boutique isolée.
    if (body.account_phone) {
      const phoneMatch = await accountByPhone(normPhone(body.account_phone));
      if (phoneMatch) {
        const resolved = await resolveAccount(phoneMatch);
        if (resolved) {
          await db.run("UPDATE shops SET account_id = $1 WHERE id = $2", resolved.id, shop.id);
          shop = await byId(shop.id);
          account = resolved;
        }
      }
    }
    // FIN NOUVEAU
    if (!account) {
      if (pendingBlessing) {
        // Pas de compte hérité : l'écran attend la bénédiction du propriétaire.
      } else if (!shop.account_id || !(await accountById(shop.account_id))) {
        account = await attachAccountForLegacy(shop);
      } else {
        account = await accountById(shop.account_id);
      }
    }
  }

  // 3 bis. Convergence par nom d'enseigne : si d'autres comptes portent des boutiques
  // du même nom, tout le monde rejoint le compte le plus ancien — un seul
  // abonnement par enseigne, quota compté sur le survivant, écrans en trop coupés.
  // (Le démarrage fait la même passe pour toute la base ; ici on rattrape le cas
  // venant de naître, ex. deux téléphones différents pour la même boutique.)
  const nameKey = normName(shop.store_name);
  if (nameKey) {
    const survivor = await mergeGroupForKey(nameKey);
    if (survivor && survivor.id !== shop.account_id) {
      await db.run("UPDATE shops SET account_id = $1 WHERE id = $2", survivor.id, shop.id);
    }
    if (survivor) {
      account = survivor;
      shop = await byId(shop.id);
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
  // compte : tout ce qui précède le dernier ordre appliqué est marqué livré.
  const lastId = str(body.last_applied_command_id);
  if (lastId) {
    const last = await db.get("SELECT created_at FROM admin_commands WHERE id = $1", lastId);
    if (last) {
      await db.run(
        `UPDATE admin_commands SET delivered_at = $1
         WHERE delivered_at IS NULL AND created_at <= $2
           AND (device_id = $3 OR (account_id IS NOT NULL AND account_id = $4))`,
        now,
        last.created_at,
        device_id,
        shop.account_id,
      );
    }
  }

  // 5. Statut du COMPTE + quota de places. L'écran en trop est traité comme suspendu :
  //    pas de sync, verrou côté caisse, raison explicite pour l'écran de blocage.
  const st = computeAccountStatus(account);
  const overLimit = await deviceOverLimit(account, device_id);
  const effective = overLimit ? "suspended" : st;

  // Auto-cleanup : libérer les anciens appareils "ghost" qui n'ont pas donné signe de vie
  // depuis plus de 7 jours. Cela débloque les nouveaux appareils quand un ancien employé
  // est parti sans libérer la place (network error, etc.).
  const GHOST_DEVICE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  // Un écran JAMAIS CONFIRMÉ (ni béni, donc sans empreinte, et sans nom déclaré) n'a
  // jamais prouvé qu'il existe : c'est une TENTATIVE d'appairage restée en attente du
  // propriétaire — souvent l'écran qui s'est ré-annoncé après une réinitialisation
  // d'identité, ce qui créait un doublon fantôme. On le libère au bout d'une heure au lieu
  // de sept jours : sinon il comptait comme employé et occupait une place.
  const PENDING_DEVICE_TTL_MS = 60 * 60 * 1000;
  const ghostDevices = await db.all(
    `SELECT id, device_id, registration_date, last_sync_at, device_fingerprint,
            employee_name, owner_name
       FROM shops WHERE account_id = $1 AND released_at IS NULL`,
    account.id,
  );
  for (const d of ghostDevices) {
    // Considérer un appareil "ghost" s'il n'a pas de last_sync_at récent (> 7 jours)
    // ou s'il n'a jamais syncé (last_sync_at undefined).
    const lastSync = d.last_sync_at ?? d.registration_date;
    const jamaisConfirme = !d.device_fingerprint && !d.employee_name && !d.owner_name;
    const ttl = jamaisConfirme ? PENDING_DEVICE_TTL_MS : GHOST_DEVICE_TTL_MS;
    if (now - lastSync > ttl) {
      await db.run(
        `UPDATE shops SET released_at = $1 WHERE id = $2`,
        now,
        d.id,
      );
      console.log(
        `[${new Date().toISOString()}] AUTO-CLEANUP : libération ${jamaisConfirme ? "écran jamais confirmé" : "ghost device"} ${d.device_id} du compte #${account.id} (inactif depuis ${((now - lastSync) / (60 * 1000)).toFixed(0)} min)`,
      );
    }
  }

  // 6. Miroir : la fiche boutique reflète le compte (routes legacy et vieux builds).
  if (
    shop.expiry_date !== account.expiry_date ||
    (shop.suspended_at ?? null) !== (account.suspended_at ?? null)
  ) {
    await syncShopsFromAccount(account.id);
    shop = await byId(shop.id);
  }

  // Temps réel : chaque tableau de bord connecté (SSE) voit ce client arriver,
  // dans son projet si sa session y est limitée.
  await broadcastStatus(device_id, now);

  // Statut de la dernière demande d'abonnement du compte : la caisse l'affiche dans
  // Paramètres (« en attente de validation », « validée le … »). Absent s'il n'y en a
  // jamais eu — un serveur plus ancien n'expose pas ce champ non plus.
  const lastRequest = shop.account_id
    ? await db.get(
        `SELECT status, plan_price, plan_devices, reference, created_at, decided_at
         FROM subscription_requests WHERE account_id = $1 AND status != 'superseded'
         ORDER BY created_at DESC LIMIT 1`,
        shop.account_id,
      )
    : null;

  const commands = (await db.all(
    `SELECT id, action_type, payload, expires_at, created_at
     FROM admin_commands
     WHERE (device_id = $1 OR account_id = $2)
       AND delivered_at IS NULL AND superseded_at IS NULL AND expires_at > $3
     ORDER BY created_at ASC`,
    device_id,
    shop.account_id,
    now,
  )).map((c) => ({ ...c, payload: JSON.parse(c.payload) }));

  res.json({
    status: effective,
    sync_allowed: effective === "active" || effective === "grace",
    over_limit: overLimit,
    ...(overLimit ? { reason: "device_limit" } : {}),
    // Le MODE MAINTENANCE est annoncé ici : c'est le handshake qui passe toutes les
    // minutes, donc c'est lui qui l'apprend à la caisse. Elle cesse alors de
    // synchroniser (elle encaisse toujours — hors ligne d'abord).
    maintenance: await maintenanceState(),
    // URL du relais P2P (ops) — le client s'en sert pour push/pull les ops (stock, ventes).
    ops_relay_url: OPS_RELAY_URL,
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
    account: await publicAccount(account),
  });
});

// ── Protocole v3 : sync-data (stockage brut, gated sur le statut du compte) ────────
router.post("/api/v1/sync-data", async (req, res) => {
  const body = req.body ?? {};
  const device_id = str(body.device_id);
  if (!device_id || body.data_payload === undefined)
    return res.status(400).json({ error: "device_id et data_payload requis." });

  const shop = await byDeviceId(device_id);
  const account = shop?.account_id ? await accountById(shop.account_id) : null;
  // 403 SANS rien écrire : une caisse suspendue, expirée (hors grace) ou en dépassement
  // de quota ne dépose aucune donnée. Les comptes en grace period restent fonctionnels.
  const accountStatus = account ? computeAccountStatus(account) : "unknown";
  if (
    !shop ||
    !account ||
    (accountStatus !== "active" && accountStatus !== "grace") ||
    (await deviceOverLimit(account, device_id))
  ) {
    return res.status(403).json({ error: "Compte suspendu ou expiré.", status: "blocked" });
  }

  const now = Date.now();
  // L'orchestrateur ne STOCKE PLUS les ventes (elles restent sur les téléphones,
  // partagées par le relais P2P) : plus d'INSERT dans sync_payloads ni daily_stats.
  // On se contente de dater la synchronisation — c'est ce que lit la console
  // (« en ligne / hors ligne », « dernière sync »).
  await db.run("UPDATE shops SET last_sync_at = $1, updated_at = $2 WHERE id = $3", now, now, shop.id);

  res.json({ ok: true, received_at: now, status: "active" });
});

// ── Demandes d'abonnement (dépôt public par la caisse) ─────────────────────────────
// La caisse vient de payer par mobile money : elle dépose le palier choisi + la
// référence de transaction. Le serveur résout le COMPTE via l'écran (device_id →
// shops.account_id) — aucun identifiant de compte requis, une caisse en essai ou
// rattachée par migration peut donc demander tout autant. Le dashboard valide ensuite
// EN UN CLIC (POST /api/v1/admin/requests/:id/approve), ce qui applique exactement
// une « Prolongation par montant » au compte.
router.post("/api/v1/requests", async (req, res) => {
  const body = req.body ?? {};
  const device_id = str(body.device_id);
  const plan_price = Math.round(Number(body.plan_price));
  const plan_devices = Math.round(Number(body.plan_devices));
  if (!device_id) return res.status(400).json({ error: "device_id requis." });
  if (!Number.isFinite(plan_price) || plan_price <= 0)
    return res.status(400).json({ error: "plan_price invalide." });

  const shop = await byDeviceId(device_id);
  if (!shop)
    return res.status(404).json({ error: "Écran inconnu du serveur — effectuez d'abord un handshake." });
  // Rattrapage legacy : garantit que la fiche a un compte avant de créer la demande.
  const account = await accountById((await attachAccountForLegacy(shop)).account_id);
  if (!account) return res.status(409).json({ error: "Cette boutique n'a pas encore de compte." });

  const now = Date.now();
  // Une seule demande pending par compte : une nouvelle demande remplace l'ancienne
  // (le marchand a changé de palier entre-temps), l'historique reste intact.
  await db.run(
    "UPDATE subscription_requests SET status = 'superseded' WHERE account_id = $1 AND status = 'pending'",
    account.id,
  );
  const info = await db.get(
    `INSERT INTO subscription_requests
       (account_id, device_id, store_name, owner_name, plan_name, plan_price, plan_devices, reference, note, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10)
     RETURNING id`,
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
  const request = await db.get("SELECT * FROM subscription_requests WHERE id = $1", Number(info.id));
  console.log(
    `[${new Date().toISOString()}] DEMANDE #${request.id} « ${shop.store_name} » (${account.name}) — ${plan_price.toLocaleString("fr-FR")} F, réf. ${str(body.reference) || "—"}`,
  );
  await broadcastRequest(request);
  res.status(201).json({
    ok: true,
    request: { id: request.id, status: request.status, created_at: request.created_at },
  });
});

// ── Demande d'abonnement par proof SMS (depuis la caisse) ────────────────────────
// La caisse envoie { shop_id, sms_text, plan } après un paiement mobile money.
// Le serveur crée une demande en statut 'pending' que l'admin validera ensuite.
// Contrairement au flux webhook complet, ici la validation est manuelle via le dashboard.
router.post("/api/v1/subscriptions/request-payment", async (req, res) => {
  const body = req.body ?? {};
  const shop_id = Math.round(Number(body.shop_id));
  const sms_text = str(body.sms_text);
  const plan = str(body.plan);
  if (!Number.isFinite(shop_id) || shop_id <= 0)
    return res.status(400).json({ error: "shop_id requis et valide." });
  if (!sms_text) return res.status(400).json({ error: "sms_text requis." });
  if (!plan) return res.status(400).json({ error: "plan requis." });

  const shop = await byId(shop_id);
  if (!shop) return res.status(404).json({ error: "Boutique introuvable." });

  const account = shop.account_id ? await accountById(shop.account_id) : null;
  if (!account) return res.status(409).json({ error: "Cette boutique n'a pas encore de compte." });

  const nowTimestamp = Date.now();
  // Idempotence : si une demande pending existe deja pour ce shop, on la supersede.
  await db.run(
    "UPDATE payment_requests SET status = 'superseded' WHERE shop_id = $1 AND status = 'pending'",
    shop_id,
  );
  const info = await db.get(
    `INSERT INTO payment_requests
       (shop_id, sms_text, plan, status, created_at)
    VALUES ($1, $2, $3, 'pending', $4)
    RETURNING id`,
    shop_id,
    sms_text,
    plan,
    nowTimestamp,
  );
  const request = await db.get("SELECT * FROM payment_requests WHERE id = $1", Number(info.id));
  console.log(
    `[${new Date().toISOString()}] DEMANDE ABONNEMENT #${request.id} shop_id=${shop_id} plan="${plan}" — status: pending`,
  );
  res.status(201).json({
    ok: true,
    request: { id: request.id, status: request.status, created_at: request.created_at, shop_id },
  });
});

// ── Enregistrement d'un SMS de paiement ───────────────────────────────────────────
// Corps COMMUN du webhook et de la preuve signée envoyée par l'application : le
// parsing, l'anti-double (TID unique), le rapprochement téléphone + palier, et la
// MÊME prudence — rien n'est renouvelé automatiquement, la validation reste humaine.
//
// `source` dit QUI a brought le SMS : la passerelle (TextBee) ou l'application du
// marchand elle-même (auto-hébergé). La suite est identique : le client ne gagne
// aucun pouvoir, il gagne seulement de ne plus dépendre d'un service payant.
async function recordPaymentSms({ raw, receivedAt, source }) {
  const parsed = parseSms(raw);
  if (!parsed) {
    // SMS non-paiement (marketing, OTP…) : on accuse réception sans le stocker.
    return { ok: true, ignored: "not_a_payment_sms" };
  }

  const now = Date.now();
  const received_at = receivedAt || now;

  // Idempotence : l'insertion échoue si le TID existe déjà (UNIQUE). On horodate alors
  // la ligne existante et on arrête — jamais de double traitement.
  let info;
  try {
    info = await db.get(
      `INSERT INTO sms_payments (raw_sms, phone, name, amount_fcfa, tid, status, received_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7)
       RETURNING id`,
      raw.slice(0, 500),
      parsed.phone,
      parsed.name,
      parsed.amount,
      parsed.tid,
      received_at,
      now,
    );
  } catch (e) {
    if (String(e?.code ?? e?.message).includes("23505") || String(e?.code ?? e?.message).toLowerCase().includes("unique")) {
      await db.run(
        "UPDATE sms_payments SET processed_at = $1, error = 'transaction déjà reçue' WHERE tid = $2 AND status = 'pending'",
        now,
        parsed.tid,
      );
      return { ok: true, duplicate: true, tid: parsed.tid };
    }
    throw e;
  }
  const paymentId = Number(info.id);
  // La ligne naît `pending` : l'état d'arrivée d'un SMS est « à lire », jamais « payé ».
  // Avant, elle basculait en `processed` dans la MÊME requête, si vite que le Control
  // Center n'avait rien à valider.

  // ── Matching automatique ────────────────────────────────────────────────────────
  // Téléphone exact d'abord ; sinon essai sans l'indicatif local (0 suivi d'un 9xx).
  let account = await accountByPhone(parsed.phone);
  if (!account && /^0\d{8,9}$/.test(parsed.phone)) account = await accountByPhone(parsed.phone.slice(1));
  const tier = tierForAmount(parsed.amount);

  // ── AUCUN RENOUVELLEMENT AUTOMATIQUE ─────────────────────────────────────────
  // Le SMS est une REQUÊTE, pas une preuve. Rien n'est prolongé ici : le paiement part
  // en validation dans le Control Center (`POST /api/v1/admin/sms-payments/:id/process`,
  // côté master), et c'est l'administrateur qui tranche.
  //
  // Pourquoi ce changement : le webhook n'authentifie que l'EXPÉDITEUR du SMS
  // (TextBee), et `parseSms` est une regex. Or le numéro du marchand est PUBLIC — il
  // figure dans le handshake que la caisse envoie périodiquement. Un attaquant qui
  // intercepte un seul handshake connaît donc la cible, et n'a plus qu'à forger un SMS
  // au bon montant pour renouveler un abonnement sans payer. Le matching téléphone +
  // palier ne protégeait de rien : ce sont précisément les deux données connues.
  //
  // Le TID unique reste en place : il empêche qu'un même SMS soit traité deux fois, y
  // compris par un humain qui recliquerait.
  if (account && tier) {
    await db.run(
      "UPDATE sms_payments SET status = 'pending', matched_account_id = $1, matched_tier_price = $2, error = $3, processed_at = $4 WHERE id = $5",
      account.id,
      tier.price,
      "à valider dans le Control Center",
      now,
      paymentId,
    );
    console.log(
      `[${new Date().toISOString()}] SMS #${paymentId} EN ATTENTE « ${account.name} » (${parsed.phone}) — ${parsed.amount.toLocaleString("fr-FR")} F, TID ${parsed.tid} — validation admin requise (source: ${source})`,
    );
    // 202 : la requête est ACCUSÉE, pas exécutée. TextBee cesse ses retries, et le
    // front distingue ainsi « à valider » d'un simple rejet.
    return {
      ok: true,
      status: "pending",
      account_id: account.id,
      payment_id: paymentId,
    };
  }

  const errorReason = !account
    ? "téléphone inconnu — aucun compte associé"
    : "montant ne correspond à aucun palier (10 000 / 25 000 / 50 000 F)";
  // Statut SIMPLIFIÉ : 'pending' | 'processed' | 'rejected'. Un SMS qui ne trouve pas
  // son compte reste donc EN ATTENTE (c'est lui que l'administrateur doit trancher) :
  // la raison est dans `error`, et c'est `matched_account_id` (vide) qui dit qu'il
  // reste à relier à un compte.
  await db.run(
    "UPDATE sms_payments SET status = 'pending', error = $1, processed_at = $2 WHERE id = $3",
    errorReason,
    now,
    paymentId,
  );
  console.log(
    `[${new Date().toISOString()}] SMS #${paymentId} À RELIER (${errorReason}) — « ${parsed.name} » (${parsed.phone}) ${parsed.amount} F, TID ${parsed.tid}`,
  );
  return { ok: true, status: "pending", payment_id: paymentId, error: errorReason };
}

// ── Webhook SMS (TextBee → demande de renouvellement d'abonnement) ───────────────
// TextBee forward chaque SMS reçu sur l'appareil vers cette URL. Le serveur :
//   1. vérifie le token secret (?token=),
//   2. parse le SMS (montant, téléphone, nom, TID),
//   3. l'inclut dans sms_payments (TID UNIQUE = 1 traitement par transaction),
//   4. match le téléphone → compte, et le montant → palier,
//   5. le paiement part en VALIDATION HUMAINE (Control Center) — jamais de
//      renouvellement automatique.
// Réponse 200 TOUJOURS après insertion : TextBee cesse ses retries. Un SMS non
// conforme est stocké en attente ('pending') pour révision admin, jamais perdu.
//
// Le MÊME traitement sert la preuve signée envoyée par l'application du marchand
// (auto-hébergé) : voir `recordPaymentSms`.
router.post("/api/v1/webhook/sms", async (req, res) => {
  if (str(req.query.token) !== SMS_WEBHOOK_TOKEN) {
    return res.status(401).json({ error: "Token webhook invalide." });
  }
  const body = req.body ?? {};
  // Formes acceptées (selon le payload TextBee) : { sms }, { message }, { text }, { body }.
  const raw = [body.sms ?? body.message ?? body.text ?? body.body ?? body.content]
    .flat()
    .find((s) => typeof s === "string" && s.trim().length > 0);
  if (!raw) return res.status(400).json({ error: "Aucun SMS reçu." });

  const received_at = Number(body.received_at ?? body.timestamp ?? body.receivedAt) || Date.now();
  const result = await recordPaymentSms({ raw, receivedAt: received_at, source: "passerelle" });
  res.json(result);
});

// ── Preuve de paiement SIGNÉE par l'application (auto-hébergé) ─────────────────────
// Le SMS de paiement peut être apporté par l'APPLICATION DU MARCHAND elle-même
// (elle lit le SMS reçu et le transmet) : plus de dépendance à une passerelle
// payante, et le serveur n'a plus qu'une seule porte.
//
// La preuve est SIGNÉE avec la clé de l'appareil (ECDSA P-256, la même que le canal
// P2P) : le serveur sait que c'est CET appareil, et pas un tiers qui usurpe un
// numéro de téléphone. La signature ne remplace PAS la validation humaine (un
// marchand peut signer un faux SMS) — elle remplace le secret partagé de la
// passerelle.
router.post("/api/v1/payments/proof", async (req, res) => {
  const body = req.body ?? {};
  const device_id = str(body.device_id);
  const sms = str(body.sms);
  if (!device_id || !sms) return res.status(400).json({ error: "device_id et sms requis." });

  const shop = await byDeviceId(device_id);
  if (!shop) return res.status(404).json({ error: "Appareil inconnu." });
  const publicKey = shop.public_key;
  if (!publicKey) {
    return res.status(409).json({
      error: "Cet écran n'a pas encore de clé : rechargez l'application, puis réessayez.",
    });
  }

  const signed = {
    device_id,
    sms,
    from: str(body.from),
    received_at: Number(body.received_at) || Date.now(),
  };
  const attendu = signableProofBody(signed);
  const valide = await verifyProofSignature(attendu, str(body.sig), publicKey);
  if (!valide) {
    // Journalé : une signature refusée est une tentative, pas un aléa.
    console.warn(
      `[${new Date().toISOString()}] PREUVE DE PAIEMENT REFUSÉE : signature invalide (${device_id})`,
    );
    return res.status(401).json({ error: "Signature invalide." });
  }

  const result = await recordPaymentSms({
    raw: sms,
    receivedAt: signed.received_at,
    source: "application",
  });
  res.json(result);
});

// ── Protocole : bénédiction d'un appareil invité ───────────────────────────
// Le propriétaire authentifie sa caisse (téléphone + mot de passe du
// compte) et désigne l'appareil cible (device_id de l'employé). Le serveur
// rattache la fiche de l'employé au compte et la marque bénissionée.
router.post("/api/v1/account/bless", async (req, res) => {
  const ownerPhone = normPhone(str(req.body?.account_phone));
  const ownerPassword = str(req.body?.account_password);
  const targetDeviceId = str(req.body?.target_device_id);
  if (!ownerPhone || !ownerPassword || !targetDeviceId)
    return res.status(400).json({ error: "account_phone, account_password, target_device_id requis." });
  const existing = await accountByPhone(ownerPhone);
  if (!existing || !verifyPassword(ownerPassword, existing.password))
    return res.status(403).json({ error: "Identifiants du compte incorrects." });
  const account = await resolveAccount(existing);
  if (!account) return res.status(404).json({ error: "Compte introuvable." });
  // la caisse bénédictionne est déjà membre du compte (owner)
  const ownerShop = await byDeviceId(targetDeviceId);
  // target_device_id doit être un appareil existant (l'employé a déjà fait un handshake)
  if (!ownerShop) return res.status(404).json({ error: "Appareil cible inconnu — l'employé doit d'abord se présenter." });
  await deviceBlessing(targetDeviceId, account.id, ownerShop.device_id);
  console.log(`[${new Date().toISOString()}] BÉNISSION : appareil ${targetDeviceId} → compte "${account.name}" (#${account.id}) par ${ownerShop.device_id}`);
  res.json({ status: "blessed", account_id: account.id, account_name: account.name });
});

// ── Protocole : libération d'appareil (place + empreinte) ─────────────────────
// Un écran qui quitte le commerce (démission, suppression de boutique) rend sa
// PLACE. Il rend aussi son EMPREINTE : sans cela, le serveur garde l'appareil lié
// à l'ancienne boutique pour toujours, et le téléphone se voit refuser toute
// nouvelle inscription (« Cet appareil est déjà enregistré… ») alors qu'il a été
// remis à zéro.
//
// Deux preuves acceptées :
//  - le DÉTENTEUR DU COMPTE (téléphone + mot de passe) — c'est le patron qui libère
//    la place d'un employé, y compris hors ligne (l'op de départ part par le relais,
//    la libération suit au prochain échange) ;
//  - l'ÉCRAN LUI-MÊME (device_id + nom de boutique, la preuve déjà en usage pour la
//    suppression) — c'est la démission depuis l'écran qui part.
//
// La place FONDATRICE (le plus ancien écran du compte) ne se rend pas sur une
// simple auto-déclaration : seul le détenteur du compte peut en décider.
const releaseDevice = async (req, res) => {
  const device_id = str(req.body?.device_id);
  const store_name = str(req.body?.store_name);
  const fingerprint = optStr(req.body?.fingerprint);
  if (!device_id && !fingerprint) {
    return res.status(400).json({ error: "device_id ou fingerprint requis." });
  }

  // Preuve du COMPTE, évaluée pour un compte donné : téléphone + mot de passe.
  const accPhone = normPhone(str(req.body?.account_phone));
  const accPassword = str(req.body?.account_password);
  const accountProofFor = async (accountId) => {
    if (!accountId || !accPhone || !accPassword) return false;
    const presented = await accountByPhone(accPhone);
    if (!presented) return false;
    const resolved = await resolveAccount(presented);
    return (
      Boolean(resolved) &&
      resolved.id === accountId &&
      verifyPassword(accPassword, presented.password)
    );
  };

  // 1. L'EMPREINTE, même quand l'identifiant d'appareil a changé (réinstallation :
  //    l'application a été supprimée, la nouvelle identité a un autre device_id).
  //    Sans cela, le téléphone garde son mur « appareil déjà enregistré » alors que
  //    l'utilisateur a tout effacé.
  let fingerprintReleased = false;
  if (fingerprint) {
    const holder = await db.get(
      "SELECT device_id, store_name, account_id FROM shops WHERE device_fingerprint = $1",
      fingerprint,
    );
    if (holder) {
      // L'EMPREINTE est la signature MATÉRIELLE de l'appareil : l'appareil qui la
      // présente se détache lui-même, sans avoir autre chose à prouver. (Un employé
      // qui a rejoint par QR n'a pas le mot de passe du compte ; un téléphone
      // réinstallé n'a plus d'identifiant d'écran — dans les deux cas, sa place
      // matérielle doit pouvoir être rendue.)
      //
      // La PLACE, elle, garde sa preuve stricte : un compte ne se vide pas sur une
      // empreinte, seulement sur des identifiants de compte ou la déclaration de
      // l'écran concerné.
      await db.run(
        "UPDATE shops SET device_fingerprint = NULL, updated_at = $1 WHERE device_id = $2",
        Date.now(),
        holder.device_id,
      );
      fingerprintReleased = true;
      console.log(
        `[${new Date().toISOString()}] EMPREINTE LIBÉRÉE : ${fingerprint.slice(0, 12)}… ` +
          `détachée de « ${holder.store_name} » (${holder.device_id})`,
      );
    }
  }

  // 2. L'écran visé : sa place est rendue (la fiche reste, pour l'historique).
  let released = false;
  let refused = false;
  const target = device_id ? await byDeviceId(device_id) : null;
  if (target && !target.released_at) {
    const account = target.account_id
      ? await resolveAccount(await accountById(target.account_id))
      : null;
    const accountProof = await accountProofFor(account?.id);
    // Preuve de soi : l'écran connaît son identifiant ET son nom de boutique.
    // L'enseigne présentée peut être celle du commerce (le QR recopie le nom du patron
    // dans la fiche locale) : les deux sont acceptées.
    const presentedName = normName(store_name);
    const selfProof = Boolean(
      presentedName &&
        (presentedName === normName(target.store_name) ||
          (account && presentedName === normName(account.name))),
    );
    const anchor = account ? await accountAnchorDevice(account.id) : null;
    const isAnchor = Boolean(anchor && anchor.device_id === target.device_id);

    if (canReleaseSeat({ accountProof, selfProof, isAnchor })) {
      await releaseShopSeat(device_id);
      await db.run("DELETE FROM device_credentials WHERE device_id = $1", [device_id]);
      released = true;
      console.log(
        `[${new Date().toISOString()}] PLACE LIBÉRÉE : écran ${device_id} (${target.store_name}) ` +
          `quitte le compte #${target.account_id ?? "—"} — preuve : ${accountProof ? "compte" : "auto-déclaration"}`,
      );
    } else {
      refused = true;
    }
  }

  // Refus franc quand RIEN n'a pu être libéré : le client doit le savoir.
  if (refused && !fingerprintReleased) {
    return res.status(403).json({ error: "Preuve insuffisante pour libérer cet appareil." });
  }
  res.json({ ok: true, released, fingerprint_released: fingerprintReleased, device_id });
};

// Deux noms, un seul geste : `/api/v1/devices/release` (nom explicite) et
// `/api/v1/entry/release` (chemin du protocole caisse, conservé pour les caisse
// déjà déployées).
router.post("/api/v1/devices/release", releaseDevice);
router.post("/api/v1/entry/release", releaseDevice);

export default router;
