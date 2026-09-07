// ─── Drainer du relais ops ──────────────────────────────────────────────────────
// À chaque démarrage (+ périodiquement), l'orchestrateur COPE dans sa SQLite toutes
// les opérations du relais (boîte aux lettres Neon), boutique par boutique, puis
// demande une PURGE. La purge est régie par la fraîcheur des appareils CÔTÉ RELAIS :
// une op n'est libérée que si tous les appareils du magasin encore présents l'ont
// tirée — l'orchestrateur n'a rien à vérifier ici, il ne fait que copier puis réclamer.
//
// Boucle par boutique : GET (toutes les ops) → INSERT local idempotent → POST purge →
// on recommence tant que la purge a bien libéré quelque chose (sinon l'orchestrateur
// attendrait en boucle une place que la fraîcheur ne donne pas encore).
import { db, OPS_RELAY_URL, OPS_TOKEN } from "./config.mjs";

const REQ_TIMEOUT_MS = 10_000;
const OPS_HEADERS = OPS_TOKEN ? { "x-ops-token": OPS_TOKEN } : {};

export async function drainRelayFromOps() {
  const started = Date.now();
  let shops = [];
  try {
    const res = await fetch(`${OPS_RELAY_URL}/api/v1/ops/shops`, {
      headers: OPS_HEADERS,
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`liste boutique HTTP ${res.status}`);
    shops = ((await res.json())?.shops) ?? [];
  } catch (err) {
    console.error(`[drainer] relais injoignable (${OPS_RELAY_URL}) : ${err.message}`);
    return { ok: false, error: err.message };
  }

  let stored = 0;
  let purged = 0;
  const perShop = [];
  for (const shop of shops) {
    const r = await drainOne(shop.shop_id);
    stored += r.stored;
    purged += r.purged;
    perShop.push({ shop_id: shop.shop_id, ...r });
  }

  const info = {
    ok: true,
    relay: OPS_RELAY_URL,
    boutiques: shops.length,
    ops_copiees: stored,
    ops_purgees: purged,
    duree_ms: Date.now() - started,
    details: perShop,
  };
  console.log(`[drainer] ${new Date().toISOString()} — ${info.boutiques} boutique(s), ` +
    `${stored} op(s) copiées vers l'archive, ${purged} purgée(s) (${info.duree_ms} ms)`);
  return info;
}

async function drainOne(shopId) {
  let stored = 0;
  let purged = 0;
  let empty = false;
  let rounds = 0;
  while (!empty) {
    const ops = await pullShop(shopId);
    if (ops.length === 0) break;
    const ids = ops.map((o) => o.id);
    stored += archive(shopId, ops);
    const r = await purgeIds(ids);
    purged += r.purged ?? 0;
    rounds++;
    empty = (r.purged ?? 0) === 0 && (r.kept ?? ids.length) === ids.length;
  }
  return { stored, purged, rounds };
}

async function pullShop(shopId) {
  try {
    const res = await fetch(`${OPS_RELAY_URL}/api/v1/ops?shop_id=${encodeURIComponent(shopId)}`, {
      headers: OPS_HEADERS,
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const data = (await res.json().catch(() => null)) ?? null;
    return Array.isArray(data?.ops) ? data.ops : [];
  } catch (err) {
    console.error(`[drainer] pull ${shopId} : ${err.message}`);
    return [];
  }
}

/** Copie idempotente dans l'archive locale. Renvoie le nombre de lignes NOUVELLES. */
function archive(shopId, ops) {
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO sync_ops (id, shop_id, device_id, seq, type, entity_id, payload, created_at, drained_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  );
  let inserted = 0;
  db.exec("BEGIN");
  try {
    for (const op of ops) {
      const res = insert.run(
        String(op.id ?? ""),
        shopId,
        String(op.device_id ?? ""),
        Number(op.seq ?? 0) || 0,
        String(op.type ?? ""),
        String(op.entity_id ?? ""),
        JSON.stringify(op.payload ?? null),
        Number(op.created_at ?? now) || now,
        now,
      );
      inserted += res.changes;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return inserted;
}

async function purgeIds(ids) {
  if (ids.length === 0) return { purged: 0, kept: 0 };
  try {
    const res = await fetch(`${OPS_RELAY_URL}/api/v1/ops/purge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...OPS_HEADERS },
      body: JSON.stringify({ ids }),
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`purge HTTP ${res.status}`);
    return (await res.json()) ?? { purged: 0, kept: ids.length };
  } catch (err) {
    console.error(`[drainer] purge : ${err.message}`);
    return { purged: 0, kept: ids.length };
  }
}