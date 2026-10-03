// ── Orchestrateur v3 — serveur local ────────────────────────────────────────────
// Importe l'app Express partagée (app.mjs), écoute sur PORT et fait tourner le drainer
// par minuteur. La variante serverless (Vercel) importe la même app sans écouter.
import { createServer } from "node:http";
import { app } from "./app.mjs";
import { PORT, PRICE_TIERS, TRIAL_DAYS, EXPLICIT, ADMIN_PASSWORD, OPS_DRAIN_INTERVAL_MS, OPS_DRAIN_ENABLED, OPS_RELAY_URL } from "./config.mjs";
import { drainRelayFromOps } from "./drainer.mjs";

const server = createServer(app);
server.listen(PORT, () => {
  console.log(`Orchestrateur v3 prêt : http://localhost:${PORT}`);
  console.log(
    `Paliers : ${PRICE_TIERS.map((t) => `${t.price.toLocaleString("fr-FR")} F = ${t.devices} appareils`).join(" · ")} · Essai ${TRIAL_DAYS} jours`,
  );
  if (!EXPLICIT) console.log(`Mot de passe du dashboard (défaut généré) : ${ADMIN_PASSWORD}`);
});

// ── Drainer du relais ops ────────────────────────────────────────────────────────
// Copie à la mise en service, puis toutes les OPS_DRAIN_INTERVAL_MS : les ops posées
// pendant la coupure chez le relais (Neon, toujours allumé) entrent dans l'archive
// et la place est libérée quand tous les appareils ont tiré (fraîcheur relais).
//
// Désactivé par défaut (cf. OPS_DRAIN_ENABLED). Le drainer est la SEULE chose qui
// archive et qui purge : le laisser tourner sur un poste de développement, avec un
// OPS_TOKEN recopié depuis la plateforme, déplacerait la copie d'archivage de la
// production vers ce poste. Aucune perte de donnée — le relais garde sa règle de
// fraîcheur — mais le poste de dévolppement deviendrait le détenteur de l'archive.
if (!OPS_DRAIN_ENABLED) {
  console.log(
    "[drainer] DÉSACTIVÉ (OPS_DRAIN_ENABLED absent). Rien n'est lu sur " +
      `${OPS_RELAY_URL}, aucune donnée de boutique n'est archivée ici.`,
  );
  console.log(
    "[drainer] Pour activer : OPS_DRAIN_ENABLED=true ET OPS_TOKEN identique à celui du relais.",
  );
} else {
  setImmediate(() => {
    drainRelayFromOps().catch((err) => console.error("[drainer] échec de démarrage :", err));
  });
  setInterval(() => {
    drainRelayFromOps().catch((err) => console.error("[drainer] échec :", err));
  }, OPS_DRAIN_INTERVAL_MS).unref();
}