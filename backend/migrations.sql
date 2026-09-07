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
  action_type   TEXT NOT NULL CHECK (action_type IN ('suspend', 'renew', 'broadcast_message', 'delete_account_request')),
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

-- Historique par jour du CA des caisses : reconstitué côté serveur à partir des fenêtres
-- glissantes de 7 j (`by_day`) que les caisses déposent à chaque sync. Chaque sync
-- ré-écrase la valeur du jour (idempotent) : sans rien demander de plus à l'app, le
-- dashboard sait combien chaque boutique a fait ce mois-ci et sur 30 jours.
-- `day` = minuit LOCAL de l'appareil, en ms — la même clé que `analytics.ts` côté caisse.
CREATE TABLE IF NOT EXISTS daily_stats (
  device_id  TEXT NOT NULL,
  day        INTEGER NOT NULL,
  revenue    INTEGER NOT NULL DEFAULT 0,
  profit     INTEGER NOT NULL DEFAULT 0,
  sales      INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, day)
);
CREATE INDEX IF NOT EXISTS idx_daily_stats_day ON daily_stats (day);

-- Les projets : chaque projet a son propre dashboard dédié (connexion par mot de passe
-- indépendant). `shops.app_origin` rattache chaque caisse à son projet. Le projet 'pos'
-- est semé au démarrage (index.mjs) ; les projets inconnus au handshake sont auto-créés
-- avec un mot de passe aléatoire, puis repris par l'administrateur. `type`,
-- `price_per_month_fcfa` et `trial_days` sont pilotés par le manifest de l'app
-- (backend/manifests/) ou réglés à la main par le master (POST .../projects/:id/config).
CREATE TABLE IF NOT EXISTS projects (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  password            TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  type                TEXT,
  price_per_month_fcfa INTEGER,
  trial_days          INTEGER
);

-- Les COMPTES marchands : l'abonnement vit ici, pas sur la fiche boutique. Un compte
-- couvre plusieurs écrans (shops.account_id) jusqu'à max_devices places ; l'échéance et
-- la suspension sont portées par le compte et MIRRORÉES sur chaque fiche boutique
-- (syncShopsFromAccount) pour que tout le code existant continue de lire shops sans
-- savoir que la vérité a déménagé.
--
-- Identité : le téléphone normalisé sert de clé de regroupement (les écrans d'un même
-- commerçant présentent les mêmes identifiants au handshake). Le mot de passe est le
-- secret partagé saisi sur chaque appareil. `phone` peut être NULL (comptes créés en
-- rattrapage pour des fiches sans numéro) : SQLite admet plusieurs NULL dans un UNIQUE.
CREATE TABLE IF NOT EXISTS accounts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  owner_name   TEXT NOT NULL DEFAULT '',
  phone        TEXT UNIQUE,
  password     TEXT NOT NULL,
  max_devices  INTEGER NOT NULL DEFAULT 2,
  expiry_date  INTEGER NOT NULL,
  suspended_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Les DEMANDES d'abonnement : la caisse dépose ici la preuve d'un paiement mobile
-- money (palier choisi + référence de transaction) ; le dashboard la valide ou la
-- refuse EN UN CLIC. La validation applique exactement une « Prolongation par montant »
-- au compte (même code que la commande renew), puis la demande est archivée — jamais
-- supprimée : l'historique des demandes sert de preuve en cas de litige.
--
--  - account_id : résolu côté serveur au dépôt (via device_id → shops.account_id) ;
--    toujours renseigné, car toute caisse connue du serveur a un compte (migration).
--  - status     : pending → approved | rejected. Une nouvelle demande du même compte
--    passe l'ancienne pending en 'superseded' (le marchand a changé d'avis de palier).
CREATE TABLE IF NOT EXISTS subscription_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  device_id    TEXT NOT NULL,
  store_name   TEXT NOT NULL DEFAULT '',
  owner_name   TEXT NOT NULL DEFAULT '',
  plan_name    TEXT NOT NULL DEFAULT '',
  plan_price   INTEGER NOT NULL,
  plan_devices INTEGER NOT NULL,
  reference    TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER,
  decided_by   TEXT
);
CREATE INDEX IF NOT EXISTS idx_subscription_requests_account
  ON subscription_requests (account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_subscription_requests_pending
  ON subscription_requests (status, created_at);

-- Demandes de suppression d'une caisse, déposées par l'EMPLOYÉ depuis son écran
-- (Paramètres → Supprimer mon compte → envoyer la demande). Le propriétaire les voit
-- dans le dashboard et tranche EN UN CLIC :
--   - approuver  → la fiche serveur est supprimée (`deleteShop`) ET une commande
--                  `delete_account_request` part à l'appareil (purge locale au
--                  consentement de l'employé au prochain handshake) ;
--   - refuser    → la commande `delete_account_request` part avec `status: rejected`,
--                  l'appareil l'affiche et libère l'écran.
-- Une nouvelle demande du MÊME appareil rend la précédente caduque ('superseded').
CREATE TABLE IF NOT EXISTS delete_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id   TEXT NOT NULL,
  store_name  TEXT NOT NULL DEFAULT '',
  reason      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  created_at  INTEGER NOT NULL,
  decided_at  INTEGER,
  decided_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_delete_requests_device ON delete_requests (device_id, created_at);
CREATE INDEX IF NOT EXISTS idx_delete_requests_pending ON delete_requests (status, created_at);

-- ────────────────────────────────────────────────────────────────────────────────────
-- Table des COMPTES marchands — les colonnes suivantes sont ajoutées en runtime par
-- index.mjs (PRAGMA table_info) car SQLite ne connaît pas ADD COLUMN IF NOT EXISTS.
--   merged_into  : redirection vers le compte survivant (fusion par enseigne)
--   keyword      : mot clé de récupération (XXXX-XXXX), unique, jamais renvoyé ensuite
-- Les indexes associés sont créés dans index.mjs.
-- ────────────────────────────────────────────────────────────────────────────────────

-- Audit log : chaque action administrative est enregistrée pour traçabilité.
-- target_type indique la table visée (account, shop, project, request, sms_payment, system).
-- Le token SSE n'est PAS stocké : le master_id identifie l'administrateur (session token →
-- résolu côté serveur via le registry en mémoire, ou "master" si master direct).
CREATE TABLE IF NOT EXISTS admin_actions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id     TEXT NOT NULL,
  target_type  TEXT NOT NULL CHECK (target_type IN ('account', 'shop', 'project', 'request', 'sms_payment', 'system')),
  target_id    TEXT NOT NULL,
  action       TEXT NOT NULL,
  reason       TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_actions_target ON admin_actions (target_type, target_id);

-- Événements d'activité : timeline business unifiée pour le dashboard.
-- Chaque événement vient soit du backend (commande, paiement validé) soit de l'activité
-- d'une caisse (handshake, sync). Level : info | success | warn | error.
CREATE TABLE IF NOT EXISTS activity_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  level         TEXT NOT NULL CHECK (level IN ('info', 'success', 'warn', 'error')),
  category      TEXT NOT NULL,
  title         TEXT NOT NULL,
  detail        TEXT,
  data          TEXT,
  shop_id       INTEGER REFERENCES shops(id),
  account_id    INTEGER REFERENCES accounts(id),
  project_id    TEXT REFERENCES projects(id),
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_category ON activity_events (category, created_at DESC);

-- Payment events : unifie les paiements reçus (table `payments` legacy + `sms_payments`).
-- Idempotence garantie par (provider, reference) UNIQUE : une même transaction ne crédite
-- jamais deux fois. Le champ `source` indique l'origine : 'sms' (TextBee) ou 'manual' (admin).
CREATE TABLE IF NOT EXISTS payment_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER NOT NULL REFERENCES accounts(id),
  shop_id      INTEGER REFERENCES shops(id),
  device_id    TEXT,
  amount       INTEGER NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'XAF',
  provider     TEXT NOT NULL DEFAULT 'manual',
  reference    TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'duplicate', 'expired')) DEFAULT 'pending',
  source       TEXT NOT NULL CHECK (source IN ('sms', 'manual', 'request')) DEFAULT 'manual',
  received_at  INTEGER NOT NULL,
  confirmed_at INTEGER,
  note         TEXT,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_events_ref ON payment_events (provider, reference);
CREATE INDEX IF NOT EXISTS idx_payment_events_account ON payment_events (account_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_events_status ON payment_events (status, received_at DESC);

-- Archive des opérations du canal P2P, récupérées par le DRAINER depuis le relais ops
-- (Neon) à chaque démarrage + périodiquement. L'orchestrateur COPE (jamais supprime) :
-- la purge côté relais est, elle, régie par la fraîcheur des appareils (le relais ne
-- libère la place que lorsque tous les appareils présents ont tiré les ops).
CREATE TABLE IF NOT EXISTS sync_ops (
  id         TEXT PRIMARY KEY,          -- `${shortDeviceId}:${seq}`, comme chez le relais
  shop_id    TEXT NOT NULL,             -- groupe de partage (s_<hash>), opaque
  device_id  TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  payload    TEXT NOT NULL,             -- JSON brut, jamais interprété
  created_at INTEGER NOT NULL,
  drained_at INTEGER NOT NULL           -- moment de la copie depuis le relais
);
CREATE INDEX IF NOT EXISTS idx_sync_ops_shop_drained ON sync_ops (shop_id, drained_at);
