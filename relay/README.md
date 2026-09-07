# Relais d'échange d'opérations (canal P2P) — Neon

Boîte aux lettres **muette** qui fait converger les caisses ELYNDRA (proprio + employés)
sans dépendre d'une machine locale : il stocke les opérations brutes par compte et les
rend telles quelles. « Internet sert à se rencontrer, pas à être la base de données ».

La caisse y accède via `VITE_OPS_URL`, **découplé** de l'orchestrateur (abonnements,
handshake, dashboard restent sur l'orchestrateur).

## Schéma
La base PostgreSQL (Neon) a besoin d'une table `sync_ops`.
Table : `sync_ops(id, shop_id, device_id, seq, type, entity_id, payload jsonb, created_at, status, received_at)`.
Idempotence au dépôt par `ON CONFLICT (id) DO NOTHING`.

## 1. Créer la base & appliquer le schéma
Depuis le dossier `relay/` :
```bash
npm install
DATABASE_URL="postgresql://…@…neon.tech/neondb?sslmode=require" npm run schema
```

## 2. Brancher la caisse
Dans le build de la caisse (SPA) :
```bash
VITE_OPS_URL="https://votre-relais.example.com" npm run build:static
```
- Si `VITE_OPS_URL` est absent → repli sur l'orchestrateur (`VITE_ORCHESTRATOR_URL`),
  donc compatibilité arrière totale.
- Le canal handshake/abonnements reste sur l'orchestrateur ; seul le canal ops
  (ventes/stocks/produits) part vers le relais Neon.

## 3. Déployer sur Vercel (serverless)
Le relais est un service HTTP : la **base reste Neon** (réseau serveurless), on n'héberge
rien d'autre — uniquement le petit serveur qui lit/écrit dedans.

- `api/ops.js` devient `POST/GET /api/ops`.
- Déclarer `DATABASE_URL` (chaîne Neon) dans les variables d'environnement.
- La caisse pointe `VITE_OPS_URL="https://<projet>.vercel.app"`.
  Le relais accepte aussi `/api/v1/ops` (via vercel.json) ou directement `/api/ops`.

En local (dev), un hôte Node suffit — plus besoin d'un VPS/Render en production :
```bash
npm install
DATABASE_URL="postgresql://…" PORT=8080 npm start
```
```
POST /api/v1/ops  { shop_id, ops:[…] }   → { stored }
GET  /api/v1/ops?shop_id=s_…            → { ops:[…] }
GET  /health                             → { ok:true }
```

## Contrat caisse
Le payload exact des ops vit dans
`simple-sale-system-main/src/lib/syncengine/types.ts` (`SyncOp`). Le relais ne les lit
jamais : il les stocke en JSONB et les restitue sans les trier — chaque caisse applique
l'ordre déterministe (`created_at, device_id, seq`) et la déduplication (`processed_ops`).
