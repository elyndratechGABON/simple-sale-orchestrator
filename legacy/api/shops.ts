// Boutiques : l'inscription d'une caisse (publique, c'est le principe du système) et la
// liste admin (protégée, sert le dashboard).
import {
  getProjectByDomain,
  jsonError,
  listShops,
  normalizeDomain,
  requireAdmin,
  upsertShop,
  type ApiRequest,
  type ApiResponse,
} from "./_lib.js";

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method === "POST") {
    const body = (req.body ?? {}) as {
      device_id?: unknown;
      owner_name?: unknown;
      store_name?: unknown;
      phone?: unknown;
      location?: unknown;
      registered_at?: unknown;
      project_domain?: unknown;
    };
    const device_id = typeof body.device_id === "string" ? body.device_id.trim() : "";
    const owner_name = typeof body.owner_name === "string" ? body.owner_name.trim() : "";
    const store_name = typeof body.store_name === "string" ? body.store_name.trim() : "";
    // `owner_name` est facultatif : l'app crée la fiche dès le premier accès avec le nom
    // de la boutique, le propriétaire se complète ensuite dans Paramètres (même appareil,
    // même `device_id`, upsert sans doublon).
    if (!device_id || !store_name) {
      jsonError(res, 400, "device_id et store_name sont requis.");
      return;
    }
    const project = await getProjectByDomain(
      typeof body.project_domain === "string" ? body.project_domain : "",
    );
    if (!project) {
      jsonError(
        res,
        404,
        `Domaine non enregistré chez l'orchestrateur : ${normalizeDomain(
          typeof body.project_domain === "string" ? body.project_domain : "",
        )}.`,
      );
      return;
    }
    const registered_at =
      typeof body.registered_at === "number" && Number.isFinite(body.registered_at)
        ? body.registered_at
        : Date.now();
    const shop = await upsertShop(
      {
        device_id,
        owner_name,
        store_name,
        phone: typeof body.phone === "string" ? body.phone : undefined,
        location: typeof body.location === "string" ? body.location : undefined,
        registered_at,
      },
      project,
    );
    // L'échéance renvoyée fait foi : l'app s'y aligne (cf. sync.ts côté app).
    res.json({ shop });
    return;
  }

  if (req.method === "GET") {
    if (!requireAdmin(req, res)) return;
    const project = (req.query?.project as string | undefined) ?? undefined;
    res.json({ shops: await listShops(project) });
    return;
  }

  jsonError(res, 405, "Méthode non autorisée.");
}
