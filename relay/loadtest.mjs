// ─────────────────────────────────────────────────────────────────────────────
// Test de charge du relais ops — convergence propriétaire ↔ employés en masse.
// Simule une flotte de boutiques : chaque boutique « pousse » un lot d'opérations
// (un employé encaisse) pendant qu'une autre tire (le propriétaire converge), le
// tout en parallèle pour mesurer la montée en charge — nombre de requêtes
// simultanées, latences, erreurs, et surtout : aucune opération perdue ni dupliquée.
//
//   DATABASE_URL=… RELAY_URL=http://localhost:8080 node loadtest.mjs
//
// Paramètres (env) : SHOP_COUNT (50), OPS_PER_SHOP (30), CONCURRENCY (25),
//   MAX_PULL (5000, miroir du relais).
// Les shops de test sont préfixés loadtest_<ts>_ et purgés à la fin.
// ─────────────────────────────────────────────────────────────────────────────
import { Pool } from "pg";

const BASE = process.env.RELAY_URL ?? "http://localhost:8080";
const SHOPS = Number(process.env.SHOP_COUNT ?? 50);
const OPS_PER_SHOP = Number(process.env.OPS_PER_SHOP ?? 30);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 25);
const MAX_PULL = Number(process.env.MAX_PULL ?? 5000);
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const shopPrefix = `loadtest_${Date.now()}_`;
const shops = Array.from({ length: SHOPS }, (_, i) => shopPrefix + i);

const rnd = () => Math.floor(Math.random() * 1e9);
const makeOps = (shopId, n) =>
  Array.from({ length: n }, () => ({
    id: crypto.randomUUID(),
    device_id: shopId + "_employee",
    seq: rnd(),
    type: Math.random() < 0.5 ? "sale" : "inventory",
    entity_id: crypto.randomUUID(),
    payload: { note: "loadtest", qty: 1, rand: rnd() },
    created_at: Date.now(),
  }));

async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function get(url) {
  const res = await fetch(url);
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Exécute `tasks` avec au plus `limit` en parallèle ; chronomètre chaque exécution. */
async function fanout(tasks, limit) {
  const queue = tasks.map((job, idx) => ({ job, idx }));
  const results = [];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const { job, idx } = queue.shift();
      const t0 = performance.now();
      let out, err;
      try {
        out = await job();
      } catch (e) {
        err = e;
      }
      results[idx] = { ms: performance.now() - t0, out, err };
    }
  });
  await Promise.all(workers);
  return results;
}

const pct = (arr, p) => {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const line = (label, lat, failures) =>
  console.log(
    `  ${label.padEnd(14)} avg=${lat.reduce((a, b) => a + b, 0) / Math.max(1, lat.length) | 0} ms  ` +
      `p50=${pct(lat, 50) | 0} ms  p95=${pct(lat, 95) | 0} ms  p99=${pct(lat, 99) | 0} ms  max=${Math.max(...lat) | 0} ms  ` +
      `${lat.length} req  ${failures.length ? failures.length + " ÉCHECS" : "0 échec"}`,
  );

async function main() {
  if (!DATABASE_URL) throw new Error("DATABASE_URL manquant");

  // 1) Push : chaque boutique pousse OPS_PER_SHOP ops (concurrent).
  const buffers = shops.map((s) => makeOps(s, OPS_PER_SHOP));
  console.log(`\nPush ${SHOPS} boutiques × ${OPS_PER_SHOP} ops (conc. ${CONCURRENCY})…`);
  const pushes = shops.map((s, i) => () =>
    post(`${BASE}/api/v1/ops`, { shop_id: s, ops: buffers[i] }).then((r) => ({ shop: s, ...r })),
  );
  const pushRes = await fanout(pushes, CONCURRENCY);
  const pushFail = pushRes.filter((r) => r.err || r.out?.status !== 200 || r.out?.json?.stored !== OPS_PER_SHOP);
  line("PUSH", pushRes.map((r) => r.ms), pushFail);
  if (pushFail.length) throw new Error(pushFail.length + " pushes en échec — arrêt avant vérification.");

  // 2) Pull : chaque propriétaire tire ses ops, en parallèle.
  console.log(`Pull ${SHOPS} boutiques (conc. ${CONCURRENCY})…`);
  const pulls = shops.map((s) => () => get(`${BASE}/api/v1/ops?shop_id=${encodeURIComponent(s)}`));
  const pullRes = await fanout(pulls, CONCURRENCY);
  const pullFail = pullRes.filter((r) => r.err || r.out?.status !== 200 || !Array.isArray(r.out?.json?.ops));
  line("PULL", pullRes.map((r) => r.ms), pullFail);

  // 3) Vérifications de convergence.
  let ok = 0, lost = 0, cross = 0;
  pullRes.forEach((r, i) => {
    if (r.err || r.out?.status !== 200) return;
    const got = new Set(r.out.json.ops.map((o) => o.id));
    const want = new Set(buffers[i].map((o) => o.id));
    for (const id of got) if (!want.has(id)) cross++;
    for (const id of want) if (!got.has(id)) lost++;
    if (got.size === want.size) ok++;
  });
  console.log(`  Convergence : ${ok}/${SHOPS} boutiques complètes | ops perdues ${lost} | ops étrangères ${cross}`);

  // 4) Idempotence : re-push strictement identique → 0 inséré attendu.
  console.log(`Re-push idempotent (conc. ${CONCURRENCY})…`);
  const repush = shops.map((s, i) => () =>
    post(`${BASE}/api/v1/ops`, { shop_id: s, ops: buffers[i] }).then((r) => ({ shop: s, ...r })),
  );
  const repushRes = await fanout(repush, CONCURRENCY);
  const dupes = repushRes.filter((r) => r.out?.json?.stored !== 0);
  line("RE-PUSH", repushRes.map((r) => r.ms), dupes);
  console.log(`  Doublons détectés : ${dupes.length ? dupes.map((r) => r.shop + ":" + r.out?.json?.stored).join(", ") : "0 (idempotence parfaite)"}`);

  // 4 bis) Taille maximale : vérifier qu'un pull ne dépasse jamais MAX_PULL.
  for (const r of pullRes) {
    const n = r.out?.json?.ops?.length ?? 0;
    if (n > MAX_PULL) { cross++; console.log(`  ⚠ pull de ${n} ops > MAX_PULL (${MAX_PULL})`); }
  }

  // 5) Nettoyage.
  const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
  const del = await pool.query(`DELETE FROM sync_ops WHERE shop_id LIKE $1`, [shopPrefix + "%"]);
  console.log(`\nNettoyage : ${del.rowCount} ops de test supprimées de Neon.\n`);
  await pool.end();
}

main().catch((e) => {
  console.error("ERREUR :", e.message);
  process.exit(1);
});