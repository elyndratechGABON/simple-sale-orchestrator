-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION 2 novembre 2026 — API Presence + TTL 7 jours (mission 3 niveaux)
--
-- (1) La colonne `expires_at` : chaque op poussée au relais vaut `received_at + 7 j`.
--     Le balai TTL supprime les ops expirées, même si le patron n'est jamais venu
--     PULL — c'est la coupure de fil volontaire du scénario 3 : l'employé repassera
--     ses ops `sent` en `pending` et renverra à la reconnexion du patron.
--
-- (2) index partiel du balai.
--
-- Idempotent : rejouable sans risque.
-- ═══════════════════════════════════════════════════════════════════════════════

-- Colonne (ms, comme received_at/created_at : les ops comparaissent en BIGINT).
ALTER TABLE sync_ops ADD COLUMN IF NOT EXISTS expires_at BIGINT;

-- Rampe de départ : les ops déjà déposées vivent une semaine de plus à compter de
-- maintenant, sur la même promesse. ON CONFLICT sans `received_at` nul : toutes les
-- lignes le portent NOT NULL.
UPDATE sync_ops
   SET expires_at = received_at + 7 * 86400000
 WHERE expires_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sync_ops_expires ON sync_ops (expires_at) WHERE expires_at IS NOT NULL;

-- Vérification (facultative, lecture seule) :
--   SELECT count(*) FROM sync_ops WHERE expires_at < (extract(epoch from now()) * 1000)::bigint;
