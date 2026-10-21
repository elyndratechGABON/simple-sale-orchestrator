const BASE = "https://relay-eta-blue.vercel.app";
const res = await fetch(`${BASE}/api/v1/ops?shop_id=s_c47a24e9fcc8`);
console.log("GET ops :", res.status, res.headers.get("content-type"));
const data = await res.json();
const ops = data.ops ?? [];
console.log("ops reçues :", ops.length);
const deviceIds = [...new Set(ops.map((o) => String(o?.device_id ?? "")).filter(Boolean))];
console.log("device_ids :", deviceIds.join(", "));
await pool.end();
