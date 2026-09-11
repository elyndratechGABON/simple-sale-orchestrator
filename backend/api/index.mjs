// ── Entrée serverless Vercel ────────────────────────────────────────────────────
// Vercel installe les dépendances du projet (express, pg), puis garde cette fonction
// comme seul point d'entrée : toute URL /api/* est routée vers l'app Express ci-dessous
// (voir vercel.json). Aucun listen : Vercel invoque l'app à la demande.
import { app } from "../app.mjs";

export default app;