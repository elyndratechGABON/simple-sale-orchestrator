// La réattribution d'une fiche par son APPAREIL PHYSIQUE.
//
// Le cas : l'application est réinstallée, ou sa fiche locale est purgée. Son
// identifiant d'écran change, mais son EMPREINTE (matérielle) reste la sienne. Le
// serveur ne doit pas :
//  - refuser l'écran (mur sur sa propre boutique) ;
//  - créer un écran fantôme (deux lignes pour un téléphone, une place occupée en
//    double pour toujours).
//
// Il doit le laisser RÉATTRIBUER sa fiche : même compte, même empreinte, même
// téléphone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.REQUIRE_SECRETS = "true";
process.env.ADMIN_PASSWORD ||= "mot-de-passe-de-test";
process.env.SMS_WEBHOOK_TOKEN ||= "jeton-webhook-de-test";
process.env.OPS_TOKEN ||= "jeton-relais-de-test";
process.env.BACKUP_KEY ||= "pepper-de-test-32-octets-minimum-ici";

const entry = readFileSync(new URL("../routes/entry.mjs", import.meta.url), "utf8");

test("le même commerce, la même empreinte : l'écran réattribue sa fiche", () => {
  const start = entry.indexOf("const fingerprintBlock");
  assert.ok(start > 0, "blocage d'empreinte introuvable");
  const block = entry.slice(start, entry.indexOf("\n  };", start));

  // Le cas REATTRIBUE (le même compte) : le device_id de la fiche est remplacé.
  assert.match(
    block,
    /if \(presentedAccount && clash\.account_id === presentedAccount\.id\) \{[\s\S]*?UPDATE shops SET device_id = \$1[\s\S]*?WHERE device_id = \$3/,
    "le même compte doit réattribuer la fiche à l'écran qui réapparaît",
  );
  // Et la fiche garde son compte et son historique : on ne touche qu'à l'identifiant.
  assert.ok(
    !/UPDATE shops SET device_id = \$1[^;]*account_id/.test(block),
    "la réattribution ne doit pas changer le compte de la fiche",
  );
});

test("l'empreinte d'un AUTRE commerce reste protégée (le mur du fondateur)", () => {
  const start = entry.indexOf("const fingerprintBlock");
  const block = entry.slice(start, entry.indexOf("\n  };", start));
  // Un compte DIFFÉRENT : le mur reste (le fondateur ne se dérobe pas à un autre
  // commerce) — sauf si sa fiche n'est pas celle du fondateur.
  assert.match(block, /const anchor = await db\.get\(/);
  assert.match(block, /anchor && anchor\.device_id !== clash\.device_id/);
  // Le mur renvoie bien un 409.
  assert.match(block, /status: 409/);
});
