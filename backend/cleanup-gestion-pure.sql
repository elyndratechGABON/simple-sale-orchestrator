-- ═════════════════════════════════════════════════════════════════════════════════
-- NETTOYAGE « GESTION PURE » — base `orchestrator` (Neon, production)
-- À exécuter UNE FOIS dans l'éditeur SQL de Neon (ou psql).
-- Date : 2026-10-28 — fait suite à la simplification de l'orchestrateur :
-- l'orchestrateur ne stocke plus les VENTES des clients (elles restent sur les
-- téléphones, partagées par le relais P2P) ; il ne gère plus que le parc et les
-- abonnements.
--
-- ⚠️ Cette base est celle de PRODUCTION (Vercel « simple-sale-orchestrator »).
--    Vérifier la connexion avant d'exécuter :
--      SELECT current_database();   -- doit renvoyer « orchestrator »
-- ═════════════════════════════════════════════════════════════════════════════════

-- ── 1. VIDER les tables de VENTES des clients ─────────────────────────────────────
-- daily_stats    : CA/profit/ventes quotidiens par caisse (analyse supprimée du dashboard).
-- sync_payloads  : payloads bruts déposés par les caisses au sync-data — l'écriture a été
--                  retirée du backend ; les données restent sur les téléphones.
-- TRUNCATE (et pas DROP) : le schéma reste, la table `shops.last_sync_at` et la page
-- Synchronisation continuent de fonctionner.
TRUNCATE TABLE daily_stats;
TRUNCATE TABLE sync_payloads;

-- ── 2. SUPPRIMER les tables MORTES (0 ligne, 0 référence dans le code) ────────────
-- ads                 : panneau publicitaire — jamais requêtée par le backend ni le dashboard.
-- news                : actualités — jamais requêtée.
-- notifications       : notifications ciblées — jamais requêtée ; la cloche de l'app
--                       cliente lit les admin_commands (broadcast_message), PAS cette table.
-- catalogue_requests  : trace des demandes d'import de stock (v22) — jamais requêtée.
DROP TABLE IF EXISTS catalogue_requests CASCADE;
DROP TABLE IF EXISTS notifications CASCADE;
DROP TABLE IF EXISTS news CASCADE;
DROP TABLE IF EXISTS ads CASCADE;

-- ── ⚠️ NE PAS SUPPRIMER `payment_requests` ────────────────────────────────────────
-- L'audit initial la disait « orpheline » : C'EST FAUX. L'application cliente y écrit
-- activement via POST /api/v1/subscriptions/request-payment
-- (simple-sale-system-main/src/features/settings/SubscriptionPaymentDialog.tsx:40 →
-- backend routes/entry.mjs). La table et ses routes restent en place.

-- ── ⚠️ NE PAS SUPPRIMER `sync_ops` / `restore_jobs` ───────────────────────────────
-- Ce n'est pas de l'analyse : c'est l'ARCHIVE chiffrée qui permet de restaurer la
-- boutique d'un client qui perd son téléphone (routes/restore.mjs, drainer.mjs).

-- ── 3. Nouvelle valeur de statut pour les SMS de paiement ────────────────────────
-- Le tableau de bord peut désormais REJETER un SMS (bouton « Rejeter ») : la ligne
-- sort de la file d'attente sans toucher à aucun abonnement. Le statut 'rejected'
-- n'existait pas dans la contrainte CHECK — on l'ajoute (idempotent).
ALTER TABLE sms_payments DROP CONSTRAINT IF EXISTS sms_payments_status_check;
ALTER TABLE sms_payments
  ADD CONSTRAINT sms_payments_status_check
  CHECK (status IN ('pending', 'matched', 'unmatched', 'duplicate', 'processed', 'rejected'));

-- ── 4. Vérification post-exécution ────────────────────────────────────────────────
-- Les 4 tables mortes ne doivent plus exister ; les 2 tables vidées doivent être à 0.
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name;
--   SELECT (SELECT COUNT(*) FROM daily_stats) AS daily,
--          (SELECT COUNT(*) FROM sync_payloads) AS payloads;
--   SELECT status, COUNT(*) FROM sms_payments GROUP BY status;
-- Résultat attendu : 19 tables, daily=0, payloads=0.
