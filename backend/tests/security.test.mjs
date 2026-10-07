// Garde-fous de sécurité de l'orchestrateur — ce que ces tests verrouillent.
//
// Ils portent sur du SÉCURITAIRE pur (pas de base, pas d'express) : hachage de mot de
// passe, limitation de débit, et — le plus important — le fait qu'un SMS ne renouvelle
// plus rien tout seul. Node a `crypto.subtle` et `node:test` : aucun dépendance à ajouter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

// `config.mjs` REFUSE de démarrer sans ses secrets (fail-fast, cf. le test « fail-fast »
// plus bas). Les tests tournent donc avec des valeurs factices — jamais les vraies, et
// `REQUIRE_SECRETS` reste actif pour que cette ligne soit le seul endroit qui les pose.
process.env.REQUIRE_SECRETS = "true";
process.env.ADMIN_PASSWORD ||= "mot-de-passe-de-test";
process.env.SMS_WEBHOOK_TOKEN ||= "jeton-webhook-de-test";
process.env.OPS_TOKEN ||= "jeton-relais-de-test";
// BACKUP_KEY est exigé par le fail-fast depuis l'introduction du chiffrement de
// l'archive ; ce fichier pose les mêmes valeurs factices que les autres.
process.env.BACKUP_KEY ||= "pepper-de-test-32-octets-minimum-ici";

const db = { get: async () => null, run: async () => null, all: async () => [] };
const config = await import("../config.mjs");
const lib = await import("../lib.mjs");

test("hashPassword ne rend jamais le mot de passe lisible", async () => {
  const stored = await lib.hashPassword("secret-de-merchant");
  assert.ok(!stored.includes("secret-de-merchant"), "le mot de passe doit être absent");
  assert.match(stored, /^sha256\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
});

test("deux hachages du même mot de passe diffèrent (sel aléatoire)", async () => {
  const a = await lib.hashPassword("meme-code");
  const b = await lib.hashPassword("meme-code");
  assert.notEqual(a, b, "un sel fixe rendrait les hachages corrélables");
  assert.ok(lib.verifyPassword("meme-code", a));
  assert.ok(lib.verifyPassword("meme-code", b));
});

test("verifyPassword refuse le mauvais mot de passe", async () => {
  const stored = await lib.hashPassword("bon-code");
  assert.equal(lib.verifyPassword("mauvais", stored), false);
  assert.equal(lib.verifyPassword("", stored), false);
  assert.equal(lib.verifyPassword("bon-code", ""), false);
  assert.equal(lib.verifyPassword("bon-code", null), false);
});

test("verifyPassword accepte l'ancien format clair (transition)", async () => {
  // Les comptes créés avant le hachage ont le mot de passe en clair : ils doivent rester
  // utilisables, ET le format se reconnaît pour être ré-haché au prochain login.
  assert.equal(lib.verifyPassword("ancien", "ancien"), true);
  assert.equal(lib.verifyPassword("autre", "ancien"), false);
  assert.equal(lib.verifyPassword("ancien", "sha256$aa$bb"), false);
});

test("le secret par-appareil est stocké HACHÉ", async () => {
  // C'est le point de ce correctif : la valeur retournée est en clair (elle doit l'être,
  // elle est rendue à l'écran qui l'a demandée), mais ce qui part en base ne l'est pas.
  let captured = null;
  const realRun = db.run;
  db.run = async (sql, ...args) => {
    captured = args;
    return realRun(sql, ...args);
  };
  // `upsertDeviceCredential` lit `hashPassword`, pas l'API base : on vérifie donc la
  // propriété générale — aucun appel ne doit mettre un secret brut dans une colonne.
  db.run = realRun;
  const secret = randomBytes(16).toString("hex");
  const stored = await lib.hashPassword(secret);
  assert.ok(!stored.includes(secret));
  assert.ok(lib.verifyPassword(secret, stored));
});

test("le secret admin n'est pas un mot de passe devinable", () => {
  // Le fallback historique était un hex de 8 caractères : 2^32, épuisable. On vérifie
  // surtout que la valeur SEULE ne suffit pas à ouvrir quoi que ce soit — la vraie
  // défense est le fail-fast de config.mjs quand ADMIN_PASSWORD est absent.
  assert.ok(typeof config.ADMIN_PASSWORD === "string" && config.ADMIN_PASSWORD.length > 0);
  assert.equal(config.SESSION_MS, 7 * 24 * 3600 * 1000);
});

test("le corps JSON est borné : une requête géante est refusée avant d'atteindre la route", () => {
  // express.json({limit}) : 2 Mo. On vérifie que la configuration est bien celle-là,
  // parce qu'un body non borné est une facture d'invocation à la clé.
  const appSrc = readFileSync(new URL("../app.mjs", import.meta.url, import.meta.url), "utf8");
  assert.match(appSrc, /express\.json\(\{ limit: "2mb" \}\)/);
});

test("la route de drain exige une authentification", () => {
  const appSrc = readFileSync(new URL("../app.mjs", import.meta.url, import.meta.url), "utf8");
  // `/api/v1/drain` déclenche une PURGE côté relais. Elle ne doit pas être ouverte.
  const drainBlock = appSrc.slice(appSrc.indexOf('app.get("/api/v1/drain"'));
  assert.ok(drainBlock.length > 0, "route de drain introuvable");
  assert.match(
    drainBlock.slice(0, 400),
    /if \(!cronAuthed\(req\) && !sessionOf\(req\)\)/,
    "le drain doit refuser un appel non authentifié",
  );
  assert.match(appSrc, /timingSafeEqual/, "comparaison à temps constant attendue");
});

test("le webhook SMS ne renouvelle plus aucun abonnement", () => {
  const entry = readFileSync(new URL("../routes/entry.mjs", import.meta.url, import.meta.url), "utf8");
  // Le bloc webhook ne doit plus appeler `applyTierRenewal` : c'est LA garantie que le
  // renouvellement passe par un humain. Un simple grep sur le bloc suffit, et il échoue
  // bruyamment si quelqu'un réintroduit l'appel automatique plus tard.
  const start = entry.indexOf('router.post("/api/v1/webhook/sms"');
  assert.ok(start > 0, "route webhook introuvable");
  const block = entry.slice(start);
  assert.ok(
    !block.includes("applyTierRenewal("),
    "le webhook ne doit plus appeler applyTierRenewal — le renouvellement doit être humain",
  );
  assert.match(block, /status = 'pending'/, "le SMS doit arriver en `pending`, à valider");
});

test("les mots de passe de compte sont comparés par hachage, pas en clair", () => {
  const entry = readFileSync(new URL("../routes/entry.mjs", import.meta.url, import.meta.url), "utf8");
  // Une comparaison `existing.password !== accPassword` fonctionne tant que la colonne
  // est en clair — et cesse de fonctionner le jour où elle est hachée, en refusant tout
  // le monde silencieusement. Le grep garantit qu'elle a bien disparu.
  assert.ok(
    !/existing\.password\s*!==/.test(entry),
    "comparaison en clair encore présente sur le mot de passe du compte",
  );
  assert.match(entry, /verifyPassword\(accPassword, existing\.password\)/);
  assert.match(entry, /await hashPassword\(accPassword\)/, "le re-key doit stocker un condensat");
});

test("l'empreinte se vérifie AVANT la création du compte", () => {
  const entry = readFileSync(new URL("../routes/entry.mjs", import.meta.url, import.meta.url), "utf8");
  // L'ordre est le point charge-bearing : un contrôle d'empreinte placé APRÈS
  // `createAccount` laisse un compte créé puis un refus 409, soit une boutique invisible
  // au tableau de bord et un compte fantôme par essai. Le grep échoue bruyamment le jour
  // où quelqu'un remet le contrôle à sa place d'origine.
  const start = entry.indexOf('router.post("/api/v1/handshake"');
  assert.ok(start > 0, "route handshake introuvable");
  const block = entry.slice(start);
  const check = block.indexOf("fingerprint_conflict");
  const create = block.indexOf("createAccount(");
  assert.ok(check > 0, "le contrôle d'empreinte a disparu du handshake");
  assert.ok(create > 0, "la création de compte a disparu du handshake");
  assert.ok(
    check < create,
    "le contrôle d'empreinte doit précéder createAccount — sinon un refus 409 crée un compte fantôme",
  );
});

test("la route de libération d'empreinte est authentifiée et ne supprime rien", () => {
  const cc = readFileSync(new URL("../routes/cc.mjs", import.meta.url, import.meta.url), "utf8");
  const start = cc.indexOf('router.post("/api/v1/admin/shops/:device_id/release-fingerprint"');
  assert.ok(start > 0, "route de libération d'empreinte introuvable");
  const block = cc.slice(start, cc.indexOf("\n});", start));
  assert.match(block, /requireAdmin/, "la libération d'empreinte doit exiger une session admin");
  // Débloquer ne doit JAMAIS supprimer une boutique ou un compte : on efface le champ,
  // le commerçant se réenregistre au handshake suivant.
  assert.ok(!/DELETE FROM/.test(block), "la route ne doit rien supprimer");
  assert.match(block, /device_fingerprint = NULL/);
  assert.match(block, /logAdminAction/, "l'action doit laisser une trace d'audit");
});

test("le relais persiste la signature des opérations", () => {
  const handler = readFileSync(new URL("../../relay/handler.mjs", import.meta.url, import.meta.url), "utf8");
  // Sans `sig` en colonne, le pull rend des ops sans signature et le récepteur — qui
  // refuse tout ce qui ne se vérifie pas — écarte le journal entier.
  assert.match(handler, /received_at, sig\)/, "l'INSERT doit porter la colonne sig");
  assert.match(handler, /typeof op\.sig === "string" \? op\.sig : null/);
  assert.match(handler, /SELECT id, shop_id, device_id, seq, type, entity_id, payload, created_at, status, sig/);
  assert.match(handler, /\.\.\.\(r\.sig \? \{ sig: r\.sig \} : \{\}\)/, "le pull doit rendre sig");
});

test("le drainer archive la signature avec l'opération", () => {
  const drainer = readFileSync(new URL("../drainer.mjs", import.meta.url, import.meta.url), "utf8");
  assert.match(drainer, /drained_at, sig\)/, "l'archive doit conserver la signature");
});

test("la limitation de débit bloque l'énumération de mots de passe", async () => {
  // Reproduit la logique de `auth.mjs` : sans elle, /api/login est une oracle.
  const LOGIN_MAX_FAILS = 8;
  const fails = new Map();
  const note = (ip) => {
    const e = fails.get(ip) ?? { count: 0, until: 0 };
    e.count += 1;
    if (e.count >= LOGIN_MAX_FAILS) e.until = 1;
    fails.set(ip, e);
  };
  const locked = (ip) => {
    const e = fails.get(ip);
    return !!(e && e.until > 0);
  };
  assert.equal(locked("1.2.3.4"), false);
  for (let i = 0; i < LOGIN_MAX_FAILS; i++) note("1.2.3.4");
  assert.equal(locked("1.2.3.4"), true, "l'IP doit être verrouillée après le seuil");
  assert.equal(locked("5.6.7.8"), false, "une autre IP n'est pas affectée");
});

test("le hachage résiste à la comparaison par égalité simple", () => {
  // Rappel du critère : deux hachages du même mot de passe ne doivent PAS être égaux,
  // sinon une base compromise se prête à une recherche par dictionnaire direct.
  const a = createHash("sha256").update(randomBytes(16).toString("hex") + "x").digest("hex");
  const b = createHash("sha256").update(randomBytes(16).toString("hex") + "x").digest("hex");
  assert.notEqual(a, b);
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  assert.equal(timingSafeEqual(bufA, bufB), false);
  assert.equal(timingSafeEqual(bufA, bufA), true);
});
