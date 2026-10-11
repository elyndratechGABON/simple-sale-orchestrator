=== ÉTAT FINAL — tout terminé ===
Appareil de test du relais (relais = ou tout passe) : OK
Orchestrateur : / (200) / /api/v1/handshake (200 avec auth) / /api/v1/admin/shop (3 locales)
Caisse : /pos (200, bundle avec VITE_OPS_URL + VITE_ORCHESTRATOR_URL + VITE_OPS_TOKEN) OK
Cron : /api/v1/drain -> 202 OK (horloge horaire 0 * * * *)
Neon : 12 boutiques / 18 comptes / 250 archive (production / orchestrate)
Git : commit 5611e7ba + 490695b poussés
Jeton GitHub : classique, contenus, stocké dans Credential Manager
.ENV : DATABASE_URL (Neon prod) + ADMIN_PASSWORD + ... en place
Start-local : corrigé le port 8787 -> 7788
Rapports : rappels d'actifs marqués (calendrier + liste) avec 8 tests
Produit : prix d'achat editable, pas d'écrasement du prix d'actif
Import de stock (ScanAnimation) : supprimé (code mort)
hasTablesOptional : retiré du type + hook
.gitattributes : .env* ignoré, LF établi
Processus local : doit être démarrer (node --env-file-if-exists=.env index.mjs)
