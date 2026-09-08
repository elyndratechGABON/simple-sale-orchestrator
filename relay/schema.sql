-- ─────────────────────────────────────────────────────────────────────────────
-- RELAIS D'ÉCHANGE D'OPÉRATIONS (canal P2P entre caisses) — base Neon (PostgreSQL).
--
-- Rôle VOLONTAIREMENT MINIMAL : le relais est une « boîte aux lettres » muette.
-- Il stocke les opérations brutes par groupe (shop_id) et les rend telles quelles,
-- sans les lire, les agréger ni les interpréter. « Internet sert à se rencontrer,
-- pas à être la base de données » — la vérité reste dans le téléphone de chaque
-- caisse, qui filtre, trie (created_at, device_id, seq) et déduplique (processed_ops).
--
-- Exécuter ce script une fois sur la base Neon :
--   psql "$DATABASE_URL" -f relay/schema.sql
-- (ou via la console Neon / un client SQL).

-- Les opérations du journal. `id` est `${shortDeviceId}:${seq}` : stable, unique,
-- triable → idempotence du dépôt (un re-push après échec ne crée pas de doublon).
CREATE TABLE IF NOT EXISTS sync_ops (
  id         TEXT PRIMARY KEY,        -- `${shortDeviceId}:${seq}`
  shop_id    TEXT NOT NULL,           -- groupe de partage du compte (s_<hash>)
  device_id  TEXT NOT NULL,
  seq        BIGINT NOT NULL,
  type       TEXT NOT NULL,           -- sale.created, stock.adjusted, product.created, …
  entity_id  TEXT NOT NULL,
  payload    JSONB NOT NULL,          -- JSON-serialisable, jamais interprété ici
  created_at BIGINT NOT NULL,         -- horodatage d'émission (ms), servi au tri local
  status     TEXT NOT NULL DEFAULT 'synced',
  received_at BIGINT NOT NULL         -- moment du dépôt chez le relais
);

-- Index de restitution : un appareil tire TOUTES les ops de son groupe au pull.
CREATE INDEX IF NOT EXISTS idx_sync_ops_shop ON sync_ops (shop_id, received_at);

-- Table à part pour le GET sur un créneau (optionnel, si on veut borner le pull).
CREATE INDEX IF NOT EXISTS idx_sync_ops_shop_created ON sync_ops (shop_id, created_at);

-- Trace des pulls par APPAREIL : sert à la PURGE SÛRE. Le relais ne supprime une op que
-- lorsqu'elle a été TIRÉE par au moins un appareil du magasin ET par tous les appareils
-- encore PRÉSENTS (dernier pull < ABSENT_MS) — « tant que le propriétaire n'est pas à
-- jour, rien ne se supprime ». `last_created_at` = plus grande op tirée (monotone via
-- GREATEST), `last_pulled_at` = dernière apparition de l'appareil (cœur de « présent »).
CREATE TABLE IF NOT EXISTS device_pull (
  shop_id         TEXT NOT NULL,
  device_id       TEXT NOT NULL,
  last_created_at BIGINT NOT NULL DEFAULT 0,
  last_pulled_at  BIGINT NOT NULL,
  PRIMARY KEY (shop_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_device_pull_shop ON device_pull (shop_id, last_pulled_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- Invitations de partage : un appareil invité rejoint le groupe du propriétaire
-- via un jeton opaque à usage unique (TTL court, émis par le relais). Le relais
-- ne lit jamais les données du groupe — il stocke l'invitation et valide la
-- réclamation. La bénédiction du compte reste du ressort de l'orchestrateur.
CREATE TABLE IF NOT EXISTS share_tokens (
  token        TEXT PRIMARY KEY,          -- jeton opaque, usage unique
  shop_id      TEXT NOT NULL,             -- groupe de partage (s_<hash>)
  account_name TEXT NOT NULL,             -- nom du COMPTE (dérivé de l'enseigne)
  account_phone TEXT NOT NULL,            -- téléphone du compte (pour le handshake)
  pair_code    TEXT NOT NULL,             -- le 6-char de preuve (généré par le principal)
  created_at   BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL,           -- TTL court (≈10 min, aligné sur le code de paire)
  used_by      TEXT,                      -- device_id ayant réclamé
  used_at      BIGINT
);
