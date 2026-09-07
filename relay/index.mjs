// Serveur HTTP autonome du relais ops — réutilise la logique de handler.mjs.
// `npm start` → node index.mjs  (déploiement Node/Fly/Render/Railway/VPS)
import { createServer } from "node:http";
import { handleRequest } from "./handler.mjs";

const PORT = Number(process.env.PORT ?? 8080);

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

const server = createServer((req, res) => {
  handleRequest(req, res).catch(() => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "erreur relais" }));
  });
});

server.listen(PORT, () => {
  console.log(`Relais ops prêt : http://localhost:${PORT}`);
  console.log(process.env.DATABASE_URL ? "Stockage Neon (PostgreSQL) configuré." : "DATABASE_URL manquant — les requêtes répondront 500.");
});