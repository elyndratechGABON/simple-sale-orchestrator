// Temps réel de l'orchestrateur : flux SSE que la console maintient ouverte.
//
// La console ne poll plus. Chaque écriture (inscription, prolongation, nouveau projet)
// publie un signal sur `CHANGES_CHANNEL` ; ce handler y est abonné côté serveur et relaie
// les événements au navigateur, qui recharge `/api/projects` — authentifié comme d'habitude.
// Le flux ne transporte AUCUNE donnée : juste « quelque chose a changé ».
//
// Les fonctions Vercel sont tuées à `maxDuration` (300 s sur Hobby) : le navigateur
// rouvre le flux à chaque fermeture, c'est le mécanisme de reconnexion voulu.
import type { IncomingMessage, ServerResponse } from "node:http";
import { kv, requireAdmin, CHANGES_CHANNEL, type ApiRequest, type ApiResponse } from "./_lib.js";

const HEARTBEAT_MS = 25_000;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!requireAdmin(req as unknown as ApiRequest, res as unknown as ApiResponse)) return;

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  res.write('data: {"event":"connected"}\n\n');

  const subscriber = kv.subscribe<{ event?: string }>(CHANGES_CHANNEL);
  subscriber.on("message", (data) => {
    const event = typeof data?.message?.event === "string" ? data.message.event : "change";
    res.write(`data: ${JSON.stringify({ event })}\n\n`);
  });

  // Garde le flux vivant côté proxy ; nettoyage à la déconnexion du navigateur.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  req.on("close", () => {
    clearInterval(heartbeat);
    subscriber.removeAllListeners();
    subscriber.unsubscribe([CHANGES_CHANNEL]).catch(() => {});
  });
}
