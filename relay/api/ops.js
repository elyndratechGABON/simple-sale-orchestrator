// ─────────────────────────────────────────────────────────────────────────────
// Adaptateur Vercel (serverless) du relais ops.
// Le micro-service « relay/ » peut être déployé tel quel sur Vercel : ce fichier
// devient la route /api/ops, et vercel.json aiguille vers la bonne fonction selon
// le préfixe. La logique (stockage Neon via pg) est partagée avec le serveur
// standalone (handler.mjs).
//
//   POST {origin}/api/v1/ops       →  { shop_id, ops } (dépôt idempotent)
//   GET  {origin}/api/v1/ops?shop_id=…[&device_id=…] →  { ops } (tiré + compte le pull)
//   POST {origin}/api/v1/ops/purge →  { ids } : purge SÛRE (fraîcheur appareils)
//   GET  {origin}/api/v1/ops/shops →  { shops } : ids opaques pour le drainer
//   GET  {origin}/api/v1/overview  →  vue d'ensemble du site relais (token optionnel)
//
// La caisse pointe alors VITE_OPS_URL={origin} (/api/v1/ops) et le drainer
// orchestrateur utilise /api/v1/ops/shops + /api/v1/ops/purge.
// ─────────────────────────────────────────────────────────────────────────────
import { handleRequest } from "../handler.mjs";

export default async function handler(req, res) {
  const originalUrl = req.url ?? "/";
  const pathname = originalUrl.split("?")[0];

  let mapped;
  if (pathname === "/api/ops/dashboard") {
    mapped = "/api/v1/dashboard";
  } else if (pathname === "/" || pathname === "/api/ops") {
    mapped = "/api/v1/ops";
  } else if (pathname.startsWith("/api/ops/")) {
    mapped = "/api/v1" + pathname.slice("/api/ops".length);
  } else {
    res.status(404).json({ error: "introuvable" });
    return;
  }
  req.url = mapped + (originalUrl.includes("?") ? "?" + originalUrl.split("?")[1] : "");
  await handleRequest(req, res);
}