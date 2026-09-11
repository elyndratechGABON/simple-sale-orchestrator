// ── Orchestrateur v3 — serveur local ────────────────────────────────────────────
// Importe l'app Express partagée (app.mjs), écoute sur PORT et fait tourner le drainer
// par minuteur. La variante serverless (Vercel) importe la même app sans écouter.
import { createServer } from "node:http";
import { app } from "./app.mjs";
import { PORT, PRICE_TIERS, TRIAL_DAYS, EXPLICIT, ADMIN_PASSWORD, OPS_DRAIN_INTERVAL_MS } from "./config.mjs";
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
setImmediate(() => {
  drainRelayFromOps().catch((err) => console.error("[drainer] échec de démarrage :", err));
});
setInterval(() => {
  drainRelayFromOps().catch((err) => console.error("[drainer] échec :", err));
}, OPS_DRAIN_INTERVAL_MS).unref();