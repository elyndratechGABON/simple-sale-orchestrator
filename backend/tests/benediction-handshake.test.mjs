// Le chemin de la BÉNÉDICTION ne doit JAMAIS planter.
//
// Ce qu'il advient : le commit « retire upsertDeviceCredential (timeout argon2) » a
// supprimé l'IMPORT de la fonction mais laissé l'APPEL. Résultat : ReferenceError
// au handshake de tout écran béni — et, en Express 4, un rejet dans un handler async
// ne renvoie AUCUNE réponse : la requête restait ouverte jusqu'au timeout (60 s).
// Du côté de l'administrateur, l'écran restait « en attente de bénédiction » pour
// toujours — un poste fantôme qui compte comme employé.
//
// Ces tests verrouillent les deux morceaux : l'appel résolu, et le filet qui
// transforme une erreur en réponse au lieu d'un silence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.REQUIRE_SECRETS = "true";
process.env.ADMIN_PASSWORD ||= "mot-de-passe-de-test";
process.env.SMS_WEBHOOK_TOKEN ||= "jeton-webhook-de-test";
process.env.OPS_TOKEN ||= "jeton-relais-de-test";
process.env.BACKUP_KEY ||= "pepper-de-test-32-octets-minimum-ici";

const entry = readFileSync(new URL("../routes/entry.mjs", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.mjs", import.meta.url), "utf8");

test("le chemin de la bénédiction importe bien upsertDeviceCredential", () => {
  const importBlock = entry.slice(entry.indexOf('import {'), entry.indexOf('} from "../lib.mjs";'));
  assert.match(
    importBlock,
    /\bupsertDeviceCredential\b/,
    "upsertDeviceCredential est appelé sans être importé : ReferenceError au handshake",
  );
  assert.match(
    importBlock,
    /\bdeviceCredentialForDevice\b/,
    "deviceCredentialForDevice doit être importé (création unique du secret)",
  );
});

test("le secret par-appareil n'est créé qu'UNE fois (pas d'argon2 à chaque handshake)", () => {
  assert.match(
    entry,
    /if \(!\(await deviceCredentialForDevice\(device_id\)\)\) \{[\s\S]*?await upsertDeviceCredential\(device_id, account\.id\)/,
    "le secret ne doit être re-haché qu'à la création, pas à chaque handshake",
  );
});

test("une erreur dans un handler async ne laisse plus la requête ouverte", () => {
  // Express 4 n'attrape pas le rejet d'un handler async : sans ce filet, la requête
  // reste ouverte jusqu'au timeout de la plateforme (le client ne reçoit rien).
  assert.match(app, /function asyncSafe\(router\)/, "le filet asyncSafe est absent");
  assert.match(
    app,
    /out\.catch\(next\)/,
    "asyncSafe doit router les rejets vers le middleware d'erreur",
  );
  assert.match(
    app,
    /app\.use\(\(err, req, res, _next\) => \{[\s\S]*?res\.status\(500\)\.json\(/,
    "une erreur non rattrapée doit devenir une réponse 500 explicite",
  );
});
