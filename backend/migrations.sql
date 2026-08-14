-- Orchestrateur v2 — boîte aux lettres (admin_commands) + stockage brut (sync_payloads).
--
-- Création idempotente : CREATE TABLE IF NOT EXISTS partout. Les colonnes AJOUTÉES aux
-- tables existantes sont pilotées depuis index.mjs (PRAGMA table_info) : SQLite ne
-- connaît pas `ADD COLUMN IF NOT EXISTS`.
--
-- La table `shops` porte l'app_origin (défaut 'pos') : le champ qui sépare les données
-- par application dès maintenant, pour qu'une seconde app (CRM, …) s'ajoute demain sans
-- réécrire le schéma. Le dashboard ne voit jamais le BRUT de sync_payloads : le backend
-- l'agrège (GET /api/v1/admin/stats) et n'expose que des totaux + top produits.

CREATE TABLE IF NOT EXISTS shops (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id         TEXT NOT NULL UNIQUE,
  owner_name        TEXT NOT NULL,
  store_name        TEXT NOT NULL,
  phone             TEXT,
  location          TEXT,
  registration_date INTEGER NOT NULL,
  expiry_date       INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id    INTEGER NOT NULL REFERENCES shops(id),
  amount     INTEGER NOT NULL,
  days_added INTEGER NOT NULL,
  created_at INTEGER NOT NULL
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
  action_type   TEXT NOT NULL CHECK (action_type IN ('suspend', 'renew', 'broadcast_message')),
  payload       TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  delivered_at  INTEGER,
  superseded_at INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_commands_device ON admin_commands (device_id);
CREATE INDEX IF NOT EXISTS idx_admin_commands_pending
  ON admin_commands (device_id, delivered_at, superseded_at);

-- Stockage brut des synchronisations : le serveur range `payload` tel quel et route
-- via app_origin. Seule l'agrégation /api/v1/admin/stats (dernier payload par caisse)
-- le relit — jamais le brut n'est exposé à la caisse ni au dashboard.
CREATE TABLE IF NOT EXISTS sync_payloads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT NOT NULL,
  app_origin  TEXT NOT NULL DEFAULT 'pos',
  payload     TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_payloads_device ON sync_payloads (device_id, received_at);

-- Les projets : chaque projet a son propre dashboard dédié (connexion par mot de passe
-- indépendant). `shops.app_origin` rattache chaque caisse à son projet. Le projet 'pos'
-- est semé au démarrage (index.mjs) ; les projets inconnus au handshake sont auto-créés
-- avec un mot de passe aléatoire, puis repris par l'administrateur.
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  password   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
