-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION 1er octobre 2026 — signature des opérations (colonne `sig`)
--
-- Les caisses signent désormais chaque op (ECDSA P-256, cf. `signOp` côté caisse) et
-- REFUSENT à l'application toute op dont la signature ne se vérifie pas. Le relais doit
-- donc PERSISTER `sig` : sans la colonne, le pull rendrait des ops sans signature et
-- chaque appareil écarterait le journal entier de ses pairs.
--
-- CE QUE CE SCRIPT NE FAIT PAS, et c'est volontaire : il ne supprime rien. Les ops déjà
-- présentes restent, simplement sans `sig` — donc refusées à la réception. Elles
-- disparaîtront par la purge de fraîcheur normale du relais, au fil des tirages.
--
-- Idempotent : rejouable sans risque.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Colonne manquante sur une base déjà en service.
ALTER TABLE sync_ops ADD COLUMN IF NOT EXISTS sig TEXT;

-- Filtres du drainer et du balai : ils recopient les lignes op par op. Aucune colonne
-- sélectionnée explicitement ici, donc pas d'adaptation nécessaire.

-- Vérification (facultative, lecture seule) :
--   SELECT count(*) FILTER (WHERE sig IS NOT NULL) AS signees,
--          count(*) FILTER (WHERE sig IS NULL)     AS sans_signature
--   FROM sync_ops;
-- Tant que `sans_signature` > 0, des pairs ne sont pas encore à jour.
