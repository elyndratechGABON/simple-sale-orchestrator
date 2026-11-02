// Le rate-limiter : 429 au-delà du plafond, remise à zéro à la fenêtre suivante,
// et OPTIONS (préflight) exempté — sinon certains navigateurs bloquent le CORS
// de tout le domaine dès qu'une caisse dépasse le plafond de POST.
import { test } from "node:test";
import assert from "node:assert/strict";
import { rateLimit, clientIp } from "../rate-limit.mjs";

function blagueRes() {
  const res = {
    headers: {},
    statusCode: null,
    body: null,
    set(k, v) {
      this.headers[k] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  return res;
}

function requete(ip, method = "POST") {
  return {
    method,
    headers: ip ? { "x-forwarded-for": ip } : {},
    socket: { remoteAddress: ip ?? "inconnu" },
  };
}

test("sous le plafond : la requête passe (next appelé)", () => {
  const mw = rateLimit({ max: 3, windowMs: 60_000 });
  for (let i = 0; i < 3; i++) {
    let nextAppelé = false;
    mw(requete("1.1.1.1"), blagueRes(), () => {
      nextAppelé = true;
    });
    assert.equal(nextAppelé, true, `requête ${i + 1} devrait passer`);
  }
});

test("au-delà du plafond : 429 avec Retry-After, même IP", () => {
  const mw = rateLimit({ max: 3, windowMs: 60_000 });
  for (let i = 0; i < 3; i++) mw(requete("2.2.2.2"), blagueRes(), () => {});
  const res = blagueRes();
  let nextAppelé = false;
  mw(requete("2.2.2.2"), res, () => {
    nextAppelé = true;
  });
  assert.equal(nextAppelé, false);
  assert.equal(res.statusCode, 429);
  assert.ok(String(res.headers["Retry-After"]).length > 0);
  assert.match(res.body.error, /Trop de requêtes/);
});

test("les autres IP ne sont pas touchées (compteur PAR IP)", () => {
  const mw = rateLimit({ max: 2, windowMs: 60_000 });
  for (let i = 0; i < 5; i++) mw(requete("3.3.3.3"), blagueRes(), () => {});
  const res = blagueRes();
  let nextAppelé = false;
  mw(requete("4.4.4.4"), res, () => {
    nextAppelé = true;
  });
  assert.equal(nextAppelé, true);
  assert.equal(res.statusCode, null);
});

test("la fenêtre se rouvre après expiration", async () => {
  const mw = rateLimit({ max: 1, windowMs: 40 });
  const res1 = blagueRes();
  mw(requete("5.5.5.5"), res1, () => {});
  const res2 = blagueRes();
  mw(requete("5.5.5.5"), res2, () => {});
  assert.equal(res2.statusCode, 429);
  await new Promise((r) => setTimeout(r, 60));
  const res3 = blagueRes();
  let nextAppelé = false;
  mw(requete("5.5.5.5"), res3, () => {
    nextAppelé = true;
  });
  assert.equal(nextAppelé, true);
  assert.equal(res3.statusCode, null);
});

test("OPTIONS (préflight) : jamais limité", () => {
  const mw = rateLimit({ max: 1, windowMs: 60_000 });
  mw(requete("6.6.6.6", "OPTIONS"), blagueRes(), () => {});
  for (let i = 0; i < 10; i++) {
    const res = blagueRes();
    let nextAppelé = false;
    mw(requete("6.6.6.6", "OPTIONS"), res, () => {
      nextAppelé = true;
    });
    assert.equal(nextAppelé, true);
    assert.equal(res.statusCode, null);
  }
});

test("clientIp : x-forwarded-for d'abord, socket ensuite", () => {
  assert.equal(clientIp(requete("9.9.9.9")), "9.9.9.9");
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: "10.0.0.1" } }), "10.0.0.1");
  assert.equal(clientIp({ headers: {}, socket: {} }), "inconnu");
});
