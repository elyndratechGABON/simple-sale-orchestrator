// La session admin doit être SANS ÉTAT : en serverless, chaque requête peut atterrir
// sur une instance différente — une session tenue en mémoire disparaît au premier
// changement d'instance, et le dashboard se déconnecte tout seul (aléatoirement).
//
// Le jeton est donc auto-porteur : portée + échéance + signature HMAC.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.REQUIRE_SECRETS = "true";
process.env.ADMIN_PASSWORD ||= "mot-de-passe-de-test";
process.env.SMS_WEBHOOK_TOKEN ||= "jeton-webhook-de-test";
process.env.OPS_TOKEN ||= "jeton-relais-de-test";
process.env.BACKUP_KEY ||= "pepper-de-test-32-octets-minimum-ici";

const auth = await import("../routes/auth.mjs");

test("un jeton signé se vérifie partout, sans mémoire partagée", () => {
  const token = auth.signSession({ scope: "master" });
  const session = auth.verifySessionToken(token);
  assert.ok(session, "le jeton doit se vérifier");
  assert.equal(session.scope, "master");
  assert.ok(session.expires > Date.now(), "la session doit avoir une échéance");
});

test("un jeton forgé est refusé", () => {
  const token = auth.signSession({ scope: "master" });
  // On modifie le corps (portée passée en master) sans resigner.
  const [body, sig] = token.split(".");
  const forged = Buffer.from(
    JSON.stringify({
      scope: "master",
      project: null,
      name: null,
      exp: Date.now() + 1000,
    }),
    "utf8",
  ).toString("base64url");
  assert.equal(auth.verifySessionToken(`${forged}.${sig}`), null, "un corps modifié doit être refusé");
  assert.equal(auth.verifySessionToken(`${body}.${sig.slice(0, -2)}xx`), null, "une signature fausse doit être refusée");
  assert.equal(auth.verifySessionToken("pas-un-jeton"), null);
});

test("un jeton expiré est refusé", () => {
  const token = auth.signSession({ scope: "master", expires: Date.now() - 1000 });
  assert.equal(auth.verifySessionToken(token), null, "un jeton expiré ne donne aucune session");
});

test("la portée projet est portée par le jeton", () => {
  const token = auth.signSession({ scope: "project", project: "pos", name: "Caisse" });
  const session = auth.verifySessionToken(token);
  assert.equal(session.scope, "project");
  assert.equal(session.project, "pos");
});
