-- Orchestrateur v3 — schéma POSTGRES (Neon/local). Traduction de migrations.sql
-- + de toutes les colonnes/tables ajoutées en runtime sous SQLite (config.mjs).
--
-- Création idempotente : CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.
-- Aucune migration par PRAGMA sous Postgres : le schéma complet est défini ici,
-- étiqueté une fois pour toutes.

CREATE TABLE IF NOT EXISTS shops (
  id                 BIGSERIAL PRIMARY KEY,
  device_id          TEXT NOT NULL UNIQUE,
  owner_name         TEXT NOT NULL,
  store_name         TEXT NOT NULL,
  phone              TEXT,
  location           TEXT,
  registration_date  BIGINT NOT NULL,
  expiry_date        BIGINT NOT NULL,
  created_at         BIGINT NOT NULL,
  updated_at         BIGINT NOT NULL,
  suspended_at       BIGINT,
  app_version_used   TEXT,
  last_sync_at       BIGINT,
  app_origin         TEXT NOT NULL DEFAULT 'pos',
  account_id         BIGINT,
  device_fingerprint TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_fingerprint ON shops (device_fingerprint) WHERE device_fingerprint IS NOT NULL;

CREATE TABLE IF NOT EXISTS payments (
  id         BIGSERIAL PRIMARY KEY,
  shop_id    BIGINT NOT NULL REFERENCES shops(id),
  account_id BIGINT,
  amount     BIGINT NOT NULL,
  days_added BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);

-- La boîte aux lettres : les ordres que le client récupère au handshake.
--  - id UUID, unique par commande : l'idempotence du client repose dessus.
--  - delivered_at  : null tant que le client n'a pas accusé réception.
--  - superseded_at : posé quand l'admin a envoyé une commande de même action avant la
--    livraison de la précédente (ex. « Prolonger » cliqué deux fois) — seule la
--    dernière compte.
--  - expires_at    : passé ce délai, le serveur ne renvoie plus l'ordre ; le dashboard
--    signale « non délivré (expiré) ».
CREATE TABLE IF NOT EXISTS admin_commands (
  id            TEXT PRIMARY KEY,
  device_id     TEXT NOT NULL,
  account_id    BIGINT,
  action_type   TEXT NOT NULL CHECK (action_type IN ('suspend', 'renew', 'broadcast_message', 'delete_account_request')),
  payload       TEXT NOT NULL,
  expires_at    BIGINT NOT NULL,
  delivered_at  BIGINT,
  superseded_at BIGINT,
  created_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_commands_device ON admin_commands (device_id);
CREATE INDEX IF NOT EXISTS idx_admin_commands_pending ON admin_commands (device_id, delivered_at, superseded_at);

CREATE TABLE IF NOT EXISTS sync_payloads (
  id          BIGSERIAL PRIMARY KEY,
  device_id   TEXT NOT NULL,
  app_origin  TEXT NOT NULL DEFAULT 'pos',
  payload     TEXT NOT NULL,
  received_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_payloads_device ON sync_payloads (device_id, received_at);

-- Historique par jour du CA des caisses : `day` = minuit LOCAL de l'appareil, en ms.
CREATE TABLE IF NOT EXISTS daily_stats (
  device_id  TEXT NOT NULL,
  day        BIGINT NOT NULL,
  revenue    BIGINT NOT NULL DEFAULT 0,
  profit     BIGINT NOT NULL DEFAULT 0,
  sales      BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (device_id, day)
);
CREATE INDEX IF NOT EXISTS idx_daily_stats_day ON daily_stats (day);

CREATE TABLE IF NOT EXISTS projects (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  password             TEXT NOT NULL,
  created_at           BIGINT NOT NULL,
  type                 TEXT,
  price_per_month_fcfa BIGINT,
  trial_days           BIGINT
);

-- Les COMPTES marchands : l'abonnement vit ici, pas sur la fiche boutique.
CREATE TABLE IF NOT EXISTS accounts (
  id                   BIGSERIAL PRIMARY KEY,
  name                 TEXT NOT NULL,
  owner_name           TEXT NOT NULL DEFAULT '',
  phone                TEXT UNIQUE,
  password             TEXT NOT NULL,
  max_devices          BIGINT NOT NULL DEFAULT 2,
  expiry_date          BIGINT NOT NULL,
  suspended_at         BIGINT,
  created_at           BIGINT NOT NULL,
  updated_at           BIGINT NOT NULL,
  merged_into          BIGINT,
  keyword              TEXT,
  employee_count       BIGINT NOT NULL DEFAULT 0,
  quarter              TEXT,
  subscription_price   BIGINT NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_keyword ON accounts (keyword) WHERE keyword IS NOT NULL;

CREATE TABLE IF NOT EXISTS subscription_requests (
  id           BIGSERIAL PRIMARY KEY,
  account_id   BIGINT NOT NULL REFERENCES accounts(id),
  device_id    TEXT NOT NULL,
  store_name   TEXT NOT NULL DEFAULT '',
  owner_name   TEXT NOT NULL DEFAULT '',
  plan_name    TEXT NOT NULL DEFAULT '',
  plan_price   BIGINT NOT NULL,
  plan_devices BIGINT NOT NULL,
  reference    TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  created_at   BIGINT NOT NULL,
  decided_at   BIGINT,
  decided_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_subscription_requests_account ON subscription_requests (account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_subscription_requests_pending ON subscription_requests (status, created_at);

CREATE TABLE IF NOT EXISTS delete_requests (
  id          BIGSERIAL PRIMARY KEY,
  device_id   TEXT NOT NULL,
  store_name  TEXT NOT NULL DEFAULT '',
  reason      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  created_at  BIGINT NOT NULL,
  decided_at  BIGINT,
  decided_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_delete_requests_device ON delete_requests (device_id, created_at);
CREATE INDEX IF NOT EXISTS idx_delete_requests_pending ON delete_requests (status, created_at);

-- Panneau publicitaire
CREATE TABLE IF NOT EXISTS ads (
  id          BIGSERIAL PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('image', 'video', 'text')),
  title       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  url         TEXT,
  image_url   TEXT,
  video_url   TEXT,
  active      BIGINT NOT NULL DEFAULT 1,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
);

-- Actualités du Gabon
CREATE TABLE IF NOT EXISTS news (
  id          BIGSERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT '',
  image_url   TEXT,
  video_url   TEXT,
  active      BIGINT NOT NULL DEFAULT 1,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL
);

-- Notifications ciblées
CREATE TABLE IF NOT EXISTS notifications (
  id          BIGSERIAL PRIMARY KEY,
  account_id  BIGINT REFERENCES accounts(id),
  type        TEXT NOT NULL CHECK (type IN ('text', 'image', 'video')),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  image_url   TEXT,
  video_url   TEXT,
  is_global   BIGINT NOT NULL DEFAULT 0,
  sent_at     BIGINT,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_account ON notifications (account_id);

CREATE TABLE IF NOT EXISTS admin_actions (
  id          BIGSERIAL PRIMARY KEY,
  admin_id    TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('account', 'shop', 'project', 'request', 'sms_payment', 'system')),
  target_id   TEXT NOT NULL,
  action      TEXT NOT NULL,
  reason      TEXT,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_actions_target ON admin_actions (target_type, target_id);

CREATE TABLE IF NOT EXISTS activity_events (
  id         BIGSERIAL PRIMARY KEY,
  level      TEXT NOT NULL CHECK (level IN ('info', 'success', 'warn', 'error')),
  category   TEXT NOT NULL,
  title      TEXT NOT NULL,
  detail     TEXT,
  data       TEXT,
  shop_id    BIGINT REFERENCES shops(id),
  account_id BIGINT REFERENCES accounts(id),
  project_id TEXT REFERENCES projects(id),
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_category ON activity_events (category, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_events (
  id           BIGSERIAL PRIMARY KEY,
  account_id   BIGINT NOT NULL REFERENCES accounts(id),
  shop_id      BIGINT REFERENCES shops(id),
  device_id    TEXT,
  amount       BIGINT NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'XAF',
  provider     TEXT NOT NULL DEFAULT 'manual',
  reference    TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'duplicate', 'expired')) DEFAULT 'pending',
  source       TEXT NOT NULL CHECK (source IN ('sms', 'manual', 'request')) DEFAULT 'manual',
  received_at  BIGINT NOT NULL,
  confirmed_at BIGINT,
  note         TEXT,
  created_at   BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_events_ref ON payment_events (provider, reference);
CREATE INDEX IF NOT EXISTS idx_payment_events_account ON payment_events (account_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_events_status ON payment_events (status, received_at DESC);

CREATE TABLE IF NOT EXISTS sync_ops (
  id         TEXT PRIMARY KEY,
  shop_id    TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  seq        BIGINT NOT NULL,
  type       TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  drained_at BIGINT NOT NULL,
  sig        TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_ops_shop_drained ON sync_ops (shop_id, drained_at);

-- Base déjà en service : la colonne arrive sans recréer la table (idempotent).
ALTER TABLE sync_ops ADD COLUMN IF NOT EXISTS sig TEXT;

-- Archive CHIFFRÉE (récupération de boutique). `payload` reste tel quel pour les lignes
-- antérieures au chiffrement ; `payload_enc` porte "ENC1:<base64>" pour les nouvelles.
-- On n'écrase jamais `payload` : c'est le filet de sécurité qui permet de rejouer une
-- boutique dont BACKUP_KEY a été perdu (la route lit alors le clair, en clair).
ALTER TABLE sync_ops ADD COLUMN IF NOT EXISTS payload_enc TEXT;

-- ── Restauration d'une boutique depuis l'archive (récupération après perte) ─────────
--
-- La caisse灌注 un job, puis BOUGE la quand elle le veut jusqu'à `ready`. Le job reste
-- REJOUABLE : `status` repasse par `pending` à chaque nouvelle demande, et rien n'est
-- purgé. C'est ce qui permet de recommencer une restauration interrompue sans que
-- l'orchestrateur ait à intervenir.
--
-- `total_ops` n'est renseigné qu'une fois l'archive drainée : tant qu'il est NULL, le
-- client doit afficher « lancez l'orchestrateur », JAMAIS « aucune donnée » — la
-- différence entre les deux est tout l'intérêt du bouton.
CREATE TABLE IF NOT EXISTS restore_jobs (
  id          TEXT PRIMARY KEY,        -- nanoid opaque, non devinable : c'est la seule
                                        -- chose qui autorise la lecture de l'archive
  account_id  BIGINT NOT NULL REFERENCES accounts(id),
  shop_id     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | ready
  total_ops   BIGINT,                  -- NULL = pas encore drainé
  created_at  BIGINT NOT NULL,
  resumed_at  BIGINT                   -- dernière reprise
);
CREATE INDEX IF NOT EXISTS idx_restore_jobs_account ON restore_jobs (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_restore_jobs_shop ON restore_jobs (shop_id, status);

CREATE TABLE IF NOT EXISTS device_blessings (
  device_id  TEXT NOT NULL,
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  blessed_at BIGINT NOT NULL,
  blessed_by TEXT NOT NULL,
  PRIMARY KEY (device_id)
);
CREATE INDEX IF NOT EXISTS idx_blessings_account ON device_blessings (account_id);

CREATE TABLE IF NOT EXISTS device_credentials (
  device_id  TEXT PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES accounts(id),
  password   TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_credentials_account ON device_credentials (account_id);

-- Paiements SMS (auto-renouvellement via TextBee). TID UNIQUE = idempotence.
CREATE TABLE IF NOT EXISTS sms_payments (
  id                 BIGSERIAL PRIMARY KEY,
  raw_sms            TEXT NOT NULL,
  phone              TEXT NOT NULL,
  name               TEXT NOT NULL,
  amount_fcfa        BIGINT NOT NULL,
  tid                TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'matched', 'unmatched', 'duplicate', 'processed')),
  matched_account_id BIGINT REFERENCES accounts(id),
  matched_tier_price BIGINT,
  error              TEXT,
  received_at        BIGINT NOT NULL,
  processed_at       BIGINT,
  created_at         BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_payments_tid ON sms_payments (tid);
CREATE INDEX IF NOT EXISTS idx_sms_payments_status ON sms_payments (status, created_at);