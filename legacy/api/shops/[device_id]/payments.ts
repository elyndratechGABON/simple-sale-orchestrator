// Paiements d'une boutique (admin) — sert le dashboard.
import { jsonError, kv, requireAdmin, type ApiRequest, type ApiResponse } from "../../_lib.js";

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "GET") {
    jsonError(res, 405, "Méthode non autorisée.");
    return;
  }
  if (!requireAdmin(req, res)) return;
  const deviceId = req.query?.device_id as string | undefined;
  if (!deviceId) {
    jsonError(res, 400, "device_id manquant.");
    return;
  }
  res.json({ payments: await kv.lrange(`payments:${deviceId}`, 0, -1) });
}
