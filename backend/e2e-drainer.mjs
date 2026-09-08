process.env.ORCHESTRATOR_DB = "C:/Users/ADMINI~1/AppData/Local/Temp/opencode/drainer-accept.db";
process.env.OPS_RELAY_URL = "http://127.0.0.1:8080";
process.env.OPS_TOKEN = "";

const BASE = "http://127.0.0.1:8080";
const s = "s_drain_accept";
const at = Date.now();
const ops = [0, 1, 2].map((i) => ({
  id: `drainacc:${i + 1}`,
  device_id: "dev-acc",
  seq: i + 1,
  type: "sale.created",
  entity_id: "p_" + i,
  payload: { n: i },
  created_at: at + i * 1000,
}));
const jpost = (p, b) => fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const jget = (p) => fetch(BASE + p).then((r) => r.json());

// 1) 3 ops poussées, le téléphone du propriétaire les a tirées (fraîcheur OK → purge possible).
console.log("push:", JSON.stringify(await jpost("/api/v1/ops", { shop_id: s, ops })));
await jget(`/api/v1/ops?shop_id=${s}&device_id=dev-acc`);

// 2) Le drainer (DB jetable) : liste → pull sans device → copie archive → purge.
const { drainRelayFromOps } = await import("../backend/drainer.mjs");
const info = await drainRelayFromOps();
console.log("drain:", JSON.stringify(info, null, 1));

// 3) Vérifs : relais vidé (purge passée) + 3 ops dans l'archive SQLite.
const shops = await jget("/api/v1/ops/shops");
console.log("shops relais:", JSON.stringify(shops.shops));

const { db } = await import("../backend/config.mjs");
const archivedAll = db.prepare("SELECT id, shop_id, seq, type FROM sync_ops ORDER BY shop_id, seq").all();
const archived = archivedAll.filter((r) => r.shop_id === s);
console.log("archive sqlite (toutes):", JSON.stringify(archivedAll));

let ok = true;
const eq = (n, g, w) => { const p = JSON.stringify(g) === JSON.stringify(w); console.log(`${p ? "PASS" : "FAIL"} ${n}`); ok = ok && p; };
eq("relais purgé", shops.shops.filter((x) => x.shop_id === s).length, 0);
eq("archive contient les 3 ops du shop", archived.length, 3);
eq("première op archivée", archived[0]?.id, "drainacc:1");
eq("drain : 3 copiées", info.ops_copiees, 3);
eq("drain : 3 purgées", info.ops_purgees, 3);
console.log(ok ? "\nDRAINER ACCEPTÉ" : "\nÉCHEC DRAINER");
process.exit(ok ? 0 : 1);