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
  const [pathname, rest] = originalUrl.split("?");
  const qs = rest ? "?" + rest : "";

  let mapped;

  // Déjà un chemin /api/v1/* — on le passe tel quel au handler
  if (pathname.startsWith("/api/v1/")) {
    mapped = pathname;
  }
  // Health check
  else if (pathname === "/health") {
    mapped = "/health";
  }
  // Dashboard : /api/ops/dashboard ou /dashboard
  else if (pathname === "/api/ops/dashboard" || pathname === "/dashboard") {
    mapped = "/api/v1/dashboard";
  }
  // Endpoint ops racine
  else if (pathname === "/api/ops") {
    mapped = "/api/v1/ops";
  }
  // Sous-chemins /api/ops/* → /api/v1/*
  else if (pathname.startsWith("/api/ops/")) {
    mapped = "/api/v1" + pathname.slice("/api/ops".length);
  }
  // Racine "/" ou inconnu — le handler décide (dashboard pour "/")
  else {
    mapped = pathname;
  }

  req.url = mapped + qs;
  await handleRequest(req, res);
}