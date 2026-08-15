# Project Scanner

Analyse un repo d'application et génère son manifest pour l'orchestrateur
(`backend/manifests/<id>.json`). Le manifest décrit le type d'app, son tarif et ses KPI ;
c'est lui qui permet à l'orchestrateur de provisionner un projet correctement au premier
handshake (nom, type, tarif, essai) et de savoir quelles données agréger.

```bash
# Depuis tools/project-scanner/
node scan.mjs <chemin-du-repo> [--out <dossier-manifests>] [--price N] [--trial N] [--force]
```

- `--out` : dossier où écrire le manifest (défaut : `backend/manifests` de l'orchestrateur).
- `--price` / `--trial` : tarif mensuel FCFA et durée d'essai (défauts 10 000 / 30).
- `--force` : écrase un manifest existant **en préservant** nom, tarif, KPI et séries
  réglés à la main — seul le résultat de la détection (type, période, source) est rafraîchi.

## Ce qu'il détecte

| Élément | Source |
| --- | --- |
| `id` (app_origin) | `VITE_APP_ORIGIN` / `APP_ORIGIN` dans les sources |
| `type` | heuristique : schéma IndexedDB/Dexie avec `sales`+`price_at_sale` → `pos` ; contrat de sync → `sync-app` ; sinon `app` |
| KPI (`metrics`) | clés de l'objet `totals` du payload de sync |
| Série `by_day` | clés de l'objet retourné par le `map` de `by_day` |
| Série `top_products` | présence de `top_products` |
| Tables locales | déclarations `store(...)` / `.addTable(...)` dans `db.ts` |

Le manifest généré est un **point de départ à relire et valider** avant de le commiter.
Les labels, séries et tarifs restent ajustables à la main, ou depuis le dashboard master
(`POST /api/v1/admin/projects/:id/config`).
