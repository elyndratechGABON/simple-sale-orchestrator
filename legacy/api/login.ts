// Connexion du dashboard : renvoie un jeton signé, à passer en « Authorization: Bearer ».
import { signToken, jsonError, type ApiRequest, type ApiResponse } from "./_lib.js";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== "POST") {
    jsonError(res, 405, "Méthode non autorisée.");
    return;
  }
  const body = (req.body ?? {}) as { password?: unknown };
  if (!ADMIN_PASSWORD || body.password !== ADMIN_PASSWORD) {
    jsonError(res, 401, "Mot de passe incorrect.");
    return;
  }
  res.json({ token: signToken(Date.now() + TOKEN_TTL_MS) });
}
