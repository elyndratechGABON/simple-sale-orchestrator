# Orchestrateur v2

Serveur d'orchestration des caisses POS. **Le serveur ne pousse jamais** : la
caisse sonne (handshake), applique les ordres, puis sync si `sync_allowed`. Une
caisse hors ligne reste verrouillée : le handshake applique suspend/renew côté
serveur à la réception. Ne pas écrire de logique « push » dans le backend.

## Commandes

| Commande               | Effet                                                         |
| ---------------------- | ------------------------------------------------------------- |
| `npm run dev`          | orchestrateur v2 (port 8787) — mot de passe affiché ou `ADMIN_PASSWORD` |
| `npm run dev:dashboard`| dashboard admin (dev, proxie `/api` vers le backend)          |
| `npm run build:dashboard` | dashboard statique servi par le backend à `/`             |

## Structure

| Chemin                     | Contenu                                               |
| -------------------------- | ----------------------------------------------------- |
| `backend/index.mjs`        | **orchestrateur v2** Express + `node:sqlite`          |
| `backend/migrations.sql`   | schéma SQLite                                          |
| `dashboard/`               | app admin Vite+React+TS, servie par le backend         |
| `orchestrator/data/`       | base SQLite live (`orchestrator.db`), gitignorée       |
| `docs/orchestrateur-flux.md` | flux v2 : handshake, ordres, sync, `app_origin`     |
| `legacy/`                  | v1 hors service — ne pas utiliser                      |
| `tools/orchestrateur-launcher/` | lanceur Windows de la console admin               |

## Landmines

- **Le serveur ne pousse jamais vers la caisse.** Tout passe par le handshake
  de la caisse. La suspension est un blocage dur côté caisse tant que le compte
  n'est pas relancé — c'est le handshake suivant qui applique la relance.
- **Chaque projet a son dashboard dédié.** Table `projects` ; une caisse
  appartient à un projet via `shops.app_origin`. `POST /api/login` sans
  `project` = administrateur (master), avec `project` + mot de passe du projet =
  scope limité à ses caisses (403 sinon). Un handshake avec un `app_origin`
  inconnu auto-crée le projet (mot de passe aléatoire, à sécuriser depuis le
  master). Projet de référence `'pos'` semé au démarrage avec le mot de passe
  admin. `ORCHESTRATOR_DB` permet de pointer la base ailleurs (tests,
  déploiement).
- **Ack implicite + idempotence.** `delivered_at` est posé au handshake suivant
  (`last_applied_command_id`) ; `superseded_at` rend le double clic sur
  Prolonger inoffensif.
- **Sync = profil + agrégats légers** (7 j, `computePeriodStats`), jamais les
  lignes de vente brutes. `sync_payloads` stocke le brut côté serveur, lisible
  seul par le backend.
- **Temps réel du dashboard = SSE, jamais de push vers la caisse.**
  `GET /api/events` (token en query : EventSource ne sait pas envoyer
  d'en-tête Authorization) diffuse chaque handshake via `broadcastStatus`. Une
  connexion scoped « projet » ne reçoit que les événements de SON projet.
- **`.gitignore` doit rester en UTF-8 sans BOM.** Une fois committé en UTF-16LE,
  git le traite en binaire et plus rien n'est ignoré (historique du repo POS).
- **Deux cibles de build distinctes.** `npm run build:dashboard` produit le
  statique servi par le backend à `/`. Le backend n'a pas de build : on le lance
  avec `node index.mjs`.
- **`/api/events` exige le token en query string**, jamais en en-tête.
- **`sync_payloads` contient des données brutes de vente** : lisible seulement
  par le backend, ne jamais l'exposer à la caisse ni au dashboard.
