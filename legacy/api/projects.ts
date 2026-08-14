// Projets de l'orchestrateur : chaque app déployée (Caisse POS, future app…) est un
// projet identifié par son domaine. Le dashboard en crée de nouveaux à la volée.
import {
  createProject,
  jsonError,
  listProjects,
  listShops,
  requireAdmin,
  type ApiRequest,
  type ApiResponse,
} from "./_lib.js";

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (!requireAdmin(req, res)) return;

  if (req.method === "GET") {
    const projects = await listProjects();
    const rows = await Promise.all(
      projects.map(async (project) => ({
        ...project,
        shops: await listShops(project.slug),
      })),
    );
    res.json({ projects: rows });
    return;
  }

  if (req.method === "POST") {
    const body = (req.body ?? {}) as {
      name?: unknown;
      domain?: unknown;
      price_per_month_fcfa?: unknown;
      trial_days?: unknown;
    };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const domain = typeof body.domain === "string" ? body.domain.trim() : "";
    const price = Number(body.price_per_month_fcfa);
    const trial = Number(body.trial_days);
    if (!name || !domain) {
      jsonError(res, 400, "Le nom et le domaine du projet sont requis.");
      return;
    }
    if (!Number.isFinite(price) || price <= 0) {
      jsonError(res, 400, "Prix mensuel invalide.");
      return;
    }
    if (!Number.isFinite(trial) || trial < 0) {
      jsonError(res, 400, "Durée d'essai invalide.");
      return;
    }
    const project = await createProject({
      name,
      domain,
      price_per_month_fcfa: Math.round(price),
      trial_days: Math.round(trial),
    });
    res.json({ project });
    return;
  }

  jsonError(res, 405, "Méthode non autorisée.");
}
