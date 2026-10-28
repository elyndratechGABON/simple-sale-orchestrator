// La RÉUTILISATION d'une fiche d'écran par son APPAREIL PHYSIQUE.
//
// Le cas : un écran revient après avoir été LIBÉRÉ (place rendue, patron parti),
// ou après une réinstallation. Son identifiant d'écran peut avoir changé, mais son
// EMPREINTE (matérielle) reste la sienne. Le serveur ne doit pas :
//  - créer une NOUVELLE fiche (deux lignes pour un téléphone, une place fantôme) ;
//  - laisser la fiche LIBÉRÉE (l'écran working mais sans sa place, son quota faux).
//
// Il doit RÉATTRIBUER sa fiche ET la RÉACTIVER : sa place lui revient.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.REQUIRE_SECRETS = "true";
process.env.ADMIN_PASSWORD ||= "mot-de-passe-de-test";
process.env.SMS_WEBHOOK_TOKEN ||= "jeton-webhook-de-test";
process.env.OPS_TOKEN ||= "jeton-relais-de-test";
process.env.BACKUP_KEY ||= "pepper-de-test-32-octets-minimum-ici";

const entry = readFileSync(new URL("../routes/entry.mjs", import.meta.url), "utf8");
const bloc = () => {
  const start = entry.indexOf("const fingerprintBlock");
  assert.ok(start > 0, "blocage d'empreinte introuvable");
  return entry.slice(start, entry.indexOf("\n  };", start));
};

test("même commerce, même empreinte : la fiche est réattribuée ET réactivée", () => {
  const block = bloc();
  // La réattribution porte bien `released_at = NULL` : l'écran qui revient retrouve
  // sa place. Sans ça, la fiche restait libérée et le quota du compte mentait.
  assert.match(
    block,
    /if \(presentedAccount && clash\.account_id === presentedAccount\.id\) \{[\s\S]*?UPDATE shops SET device_id = \$1, released_at = NULL, updated_at = \$2 WHERE device_id = \$3/,
    "la réattribution doit réactiver la fiche (released_at = NULL)",
  );
});

test("une fiche sans compte est reprise (pas de trou laissé derrière)", () => {
  const block = bloc();
  assert.match(
    block,
    /if \(presentedAccount && !clash\.account_id\) \{[\s\S]*?UPDATE shops SET account_id = \$1, device_id = \$2, released_at = NULL, updated_at = \$3 WHERE device_id = \$4/,
    "la fiche orpheline doit être reprise et réactivée",
  );
  // Dans CETTE branche, l'empreinte n'est plus LIBÉRÉE (ce qui laissait la fiche
  // derrière, orpheline). La libération d'empreinte reste légitime dans l'autre
  // branche (le fondateur) : on ne vérifie donc que celle-ci.
  const branche = block.slice(
    block.indexOf("if (presentedAccount && !clash.account_id)"),
    block.indexOf("if (presentedAccount && clash.account_id === presentedAccount.id)"),
  );
  assert.ok(
    !branche.includes("device_fingerprint = NULL"),
    "l'empreinte ne doit pas être libérée dans cette branche : la fiche est reprise",
  );
});

test("une empreinte déjà portée par une autre fiche n'est jamais réécrite", () => {
  // Un écran dont l'empreinte est déjà prise ailleurs : réécrire l'empreinte violerait
  // l'index UNIQUE et le handshake échouerait en 500 — l'écran paraîtrait mort.
  assert.match(
    entry,
    /const dejaPortee = await db\.get\([\s\S]*?device_fingerprint = \$1 AND device_id <> \$2/,
    "le contrôle d'empreinte déjà portée doit exister",
  );
  assert.match(
    entry,
    /if \(dejaPortee\) \{[\s\S]*?fingerprintAWrite = null/,
    "une empreinte déjà portée ne doit pas être réécrite",
  );
  assert.ok(
    !/pendingBlessing \? null : device_fingerprint,\s*\n\s*\/\/ La clé PUBLIQUE/.test(entry),
    "l'INSERT doit utiliser la valeur gardée, pas l'empreinte brute",
  );
});

test("un appairage jamais confirmé est libéré vite et ne compte pas comme employé", () => {
  // L'écran fantôme : une attente de bénédiction restée sans suite. Elle ne doit pas
  // compter comme employé (la console le disait) ni tenir une place 7 jours.
  assert.match(
    entry,
    /const PENDING_DEVICE_TTL_MS = 60 \* 60 \* 1000/,
    "un écran jamais confirmé doit être libéré au bout d'une heure",
  );
  assert.match(
    entry,
    /const jamaisConfirme = !d\.device_fingerprint && !d\.employee_name && !d\.owner_name/,
    "un écran jamais confirmé doit être détecté comme tel",
  );
  const cc = readFileSync(new URL("../routes/cc.mjs", import.meta.url), "utf8");
  assert.match(
    cc,
    /confirme: !!\(d\.device_fingerprint \|\| d\.employee_name \|\| d\.owner_name\)/,
    "la console doit distinguer les écrans confirmés",
  );
  assert.match(
    cc,
    /nombre_employes: confirmes\.length/,
    "seuls les écrans confirmés comptent comme employés",
  );
});
