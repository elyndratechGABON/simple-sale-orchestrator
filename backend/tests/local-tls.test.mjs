// L'instance locale doit être joignable par la CAISSE.
//
// L'application est servie en HTTPS : le navigateur REFUSE qu'une page HTTPS
// appelle une adresse HTTP (contenu mixte). L'instance doit donc pouvoir servir
// en HTTPS — sinon la restauration depuis chez le commerçant est IMPOSSIBLE, et
// l'utilisateur croirait l'instance éteinte alors qu'elle répond très bien.
//
// D'où les deux régimes : HTTPS avec certificat, HTTP sinon (le miroir, lui,
// fonctionne dans les deux cas).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dossier = mkdtempSync(join(tmpdir(), "miroir-tls-"));
process.env.LOCAL_DB = join(dossier, "miroir.sqlite");
process.env.ACCOUNT_PHONE = "07657843";
process.env.ACCOUNT_PASSWORD = "mot-de-passe-de-test";

const { creerServeur, fermer } = await import("../../tools/local-orchestrator.mjs");

before(() => {
  // Les variables sont lues À L'APPEL : les poser ici suffit.
  process.env.LOCAL_TLS_CERT = "";
  process.env.LOCAL_TLS_KEY = "";
});

after(() => {
  fermer();
  rmSync(dossier, { recursive: true, force: true });
});

test("sans certificat, l'instance démarre en HTTP et répond", async () => {
  process.env.LOCAL_TLS_CERT = "";
  process.env.LOCAL_TLS_KEY = "";
  const server = creerServeur();
  try {
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/local/mirror`, { method: "POST" });
    // 502 = le cloud est injoignable (attendu ici) mais le LOCAL, lui, a répondu.
    assert.notEqual(res.status, 404, "la route locale doit exister");
  } finally {
    server.close();
  }
});

test("un certificat INVALIDE est refusé, pas silencieusement ignoré", async () => {
  const { writeFileSync } = await import("node:fs");
  const cert = join(dossier, "cert.pem");
  const key = join(dossier, "key.pem");
  writeFileSync(cert, "-----BEGIN CERTIFICATE-----\nfactice\n-----END CERTIFICATE-----\n");
  writeFileSync(key, "-----BEGIN PRIVATE KEY-----\nfactice\n-----END PRIVATE KEY-----\n");

  process.env.LOCAL_TLS_CERT = cert;
  process.env.LOCAL_TLS_KEY = key;
  try {
    // Démarrer un serveur TLS avec un certificat faux laisserait croire que la
    // restauration fonctionnera alors que le TLS ne marchera jamais. Il vaut mieux
    // un échec franc AU DÉMARRAGE.
    assert.throws(() => creerServeur(), /PEM|b64|error|bad/i);
  } finally {
    process.env.LOCAL_TLS_CERT = "";
    process.env.LOCAL_TLS_KEY = "";
  }
});
