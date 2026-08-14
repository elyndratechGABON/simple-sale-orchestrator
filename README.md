# Simple Sale — Orchestrateur

Orchestrateur (v2) du réseau de caisses POS. Serveur Express + `node:sqlite`,
dashboard d'administration Vite+React. **Le serveur ne pousse jamais** : les
caisses sonnent par handshake, appliquent les ordres, puis synchronisent si
autorisé.

## Lancer

```bash
npm run dev            # orchestrateur v2 (port 8787) — mot de passe affiché au démarrage ou ADMIN_PASSWORD
npm run dev:dashboard  # dashboard en dev (proxie /api vers le backend)
npm run build:dashboard  # dashboard statique servi par le backend à /
```

## Structure

| Chemin                     | Contenu                                               |
| -------------------------- | ----------------------------------------------------- |
| `backend/`                 | orchestrateur v2 Express + `node:sqlite`              |
| `dashboard/`               | app admin séparée (Vite+React+TS), servie par le backend |
| `orchestrator/data/`       | base SQLite live (gitignorée)                         |
| `docs/orchestrateur-flux.md` | flux v2 : handshake, ordres, sync, `app_origin`     |
| `legacy/`                  | v1 hors service (server.mjs, fonctions Vercel, …)     |
| `tools/orchestrateur-launcher/` | lanceur Windows de la console admin              |

## Configuration

- `ADMIN_PASSWORD` : mot de passe administrateur (sinon affiché au démarrage).
- `ORCHESTRATOR_DB` : pointe la base ailleurs (tests, déploiement) ; par défaut
  `orchestrator/data/orchestrator.db`.

Voir `AGENTS.md` pour les landmines.
