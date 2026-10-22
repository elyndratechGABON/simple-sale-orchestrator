// L'instance locale doit : tirer le miroir, garder les opérations, et les rendre
// à la restauration. On teste avec un faux cloud (un serveur HTTP local qui répond
// comme le vrai miroir).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dossier = mkdtempSync(join(tmpdir(), "miroir-local-"));
process.env.LOCAL_DB = join(dossier, "miroir.sqlite");
process.env.ACCOUNT_PHONE = "07657843";
process.env.ACCOUNT_PASSWORD = "mot-de-passe-de-test";

let fauxCloud;
let portCloud;
/** Ce que le faux cloud a reçu en REMONTÉE (l'instance locale rend au cloud). */
const remises = { ops: [] };
/** La borne basse que le faux cloud annonce : tout ce qui est plus ancien a été purgé. */
let borneBasse = 3000;

const { creerServeur, miroir, remontee, synchroniser, fermer } = await import(
  "../../tools/local-orchestrator.mjs"
);

before(async () => {
  fauxCloud = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let corps = "";
    req.on("data", (m) => {
      corps += m;
    });
    req.on("end", () => {
      // Le faux cloud répond comme le vrai : POST, corps JSON.
      if (url.pathname === "/api/v1/mirror/ops") {
        const since = Number(JSON.parse(corps || "{}").since ?? 0);
        const ops =
          since === 0
            ? [
                {
                  id: "op-1",
                  shop_id: "shop-1",
                  device_id: "dev-1",
                  seq: 1,
                  type: "sale",
                  entity_id: "s1",
                  payload: { total: 100 },
                  created_at: 1000,
                  sig: "sig-1",
                },
                {
                  id: "op-2",
                  shop_id: "shop-1",
                  device_id: "dev-1",
                  seq: 2,
                  type: "product",
                  entity_id: "p1",
                  payload: { name: "Eau" },
                  created_at: 2000,
                  sig: "sig-2",
                },
              ]
            : [];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            account_id: 4,
            ops,
            since: since === 0 ? 2000 : since,
            has_more: false,
            oldest_created_at: borneBasse,
          }),
        );
        return;
      }
      // La REMONTÉE : le cloud reçoit ce que le local lui rend.
      if (url.pathname === "/api/v1/mirror/push") {
        const recu = JSON.parse(corps || "{}");
        remises.ops.push(...(recu.ops ?? []));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            acceptes: (recu.ops ?? []).length,
            refuses: 0,
            doublons: 0,
          }),
        );
        return;
      }
      res.writeHead(404).end("{}");
    });
  });
  await new Promise((r) => fauxCloud.listen(0, r));
  portCloud = fauxCloud.address().port;
  process.env.CLOUD_URL = `http://127.0.0.1:${portCloud}`;
});

after(() => {
  fauxCloud?.close();
  fermer();
  rmSync(dossier, { recursive: true, force: true });
});

test("le miroir tire les opérations du cloud et les garde en local", async () => {
  const r = await miroir();
  assert.equal(r.recues, 2);
  assert.equal(r.since, 2000);
});

test("un second miroir ne ramène pas ce qui est déjà là", async () => {
  const r = await miroir();
  assert.equal(r.recues, 0, "le curseur doit empêcher un doublon");
});

test("la REMONTÉE rend au cloud ce que la rétention a purgé", async () => {
  // Le cloud annonce une borne basse à 3000 : les ops de 1000 et 2000 sont
  // oubliées, il faut donc les lui rendre.
  remises.ops.length = 0;
  const r = await remontee();
  assert.equal(r.renvoyees, 2);
  assert.equal(remises.ops.length, 2);
  // Ce sont bien les ops PURGÉES, pas les récentes.
  assert.deepEqual(
    remises.ops.map((o) => o.id).sort(),
    ["op-1", "op-2"],
  );
  // Et elles gardent leur signature : le cloud vérifie, il ne fait pas confiance.
  assert.equal(remises.ops[0].sig, "sig-1");
  // La charge utile est relisible (déchiffrée).
  assert.equal(remises.ops.find((o) => o.id === "op-1").payload.total, 100);
});

test("la remontée ne renvoie rien quand le cloud n'a rien oublié", async () => {
  // Borne basse à 0 : le cloud a TOUT. (0 = « rien d'anciennement purgé ».)
  // Il faut un miroir pour que la nouvelle borne soit connue.
  borneBasse = 0;
  await miroir();
  remises.ops.length = 0;
  const r = await remontee();
  assert.equal(r.renvoyees, 0);
  assert.equal(remises.ops.length, 0);
  // On remet la borne pour les tests suivants.
  borneBasse = 3000;
  await miroir();
});

test("un cycle complet descend ET remonte", async () => {
  remises.ops.length = 0;
  borneBasse = 3000;
  const r = await synchroniser();
  assert.equal(r.recues, 0, "rien de nouveau à descendre");
  assert.equal(r.renvoyees, 2, "les ops purgées sont rendues");
});

test("la restauration est servie DEPUIS le local, avec les opérations archivées", async () => {
  const server = creerServeur();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    const demarrage = await fetch(`http://127.0.0.1:${port}/api/v1/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: "dev-1",
        shop_id: "shop-1",
        account_phone: "07657843",
        account_password: "mot-de-passe-de-test",
      }),
    });
    const d = await demarrage.json();
    assert.equal(d.status, "ready");
    assert.equal(d.total_ops, 2);

    const page = await fetch(`http://127.0.0.1:${port}/api/v1/restore/${d.job_id}?cursor=0`);
    const p = await page.json();
    assert.equal(p.ops.length, 2);
    assert.equal(p.ops[0].id, "op-1");
    assert.equal(p.ops[0].payload.total, 100, "la charge utile doit être lisible");
    assert.equal(p.has_more, false);
  } finally {
    server.close();
  }
});

test("l'archive du compte ne se sert QU'À son compte", async () => {
  const server = creerServeur();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    // Sans identifiants : refusé.
    const sans = await fetch(`http://127.0.0.1:${port}/api/v1/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "dev-1", shop_id: "shop-1" }),
    });
    assert.equal(sans.status, 401);

    // Mauvais mot de passe : refusé.
    const mauvais = await fetch(`http://127.0.0.1:${port}/api/v1/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: "dev-1",
        shop_id: "shop-1",
        account_phone: "07657843",
        account_password: "mauvais-mot-de-passe",
      }),
    });
    assert.equal(mauvais.status, 401);

    // Autre téléphone : refusé aussi (le compte est le même, le téléphone non).
    const autre = await fetch(`http://127.0.0.1:${port}/api/v1/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: "dev-1",
        shop_id: "shop-1",
        account_phone: "07000000",
        account_password: "mot-de-passe-de-test",
      }),
    });
    assert.equal(autre.status, 401);
  } finally {
    server.close();
  }
});

test("une restauration sans identifiants est refusée", async () => {
  const server = creerServeur();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "dev-1" }),
    });
    assert.equal(r.status, 400);
  } finally {
    server.close();
  }
});

test("le proxy ne relaie PAS le miroir (le verrou de débit du cloud serait contourné)", async () => {
  const server = creerServeur();
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/v1/mirror/ops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_phone: "07657843", account_password: "essai" }),
    });
    assert.equal(r.status, 403);
  } finally {
    server.close();
  }
});
