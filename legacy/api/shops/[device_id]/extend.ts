// Prolongation d'abonnement (admin) : le dashboard indique un montant en FCFA, l'API
// ajoute les jours selon le prix mensuel du projet de la boutique.
import {
  extendShop,
  getProject,
  jsonError,
  kv,
  requireAdmin,
  type ApiRequest,
  type ApiResponse,
} from "../../_lib.js";

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "POST") {
    jsonError(res, 405, "Méthode non autorisée.");
    return;
  }
  if (!requireAdmin(req, res)) return;
  const deviceId = req.query?.device_id as string | undefined;
  if (!deviceId) {
    jsonError(res, 400, "device_id manquant.");
    return;
  }
  const amount = Math.round(Number((req.body as { amount_fcfa?: unknown })?.amount_fcfa));
  if (!Number.isFinite(amount) || amount <= 0) {
    jsonError(res, 400, "Montant invalide.");
    return;
  }
  const shop = await kv.get<{ project_slug: string }>(`shop:${deviceId}`);
  if (!shop) {
    jsonError(res, 404, "Boutique introuvable.");
    return;
  }
  const project = await getProject(shop.project_slug);
  if (!project) {
    jsonError(res, 404, "Projet introuvable.");
    return;
  }
  const updated = await extendShop(deviceId, amount, project);
  res.json({ shop: updated });
}
