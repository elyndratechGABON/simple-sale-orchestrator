// Persistance de l'orchestrateur : SQLite via le module natif node:sqlite (Node ≥ 22.5).
// Aucune dépendance à compiler — c'est ce qui rend l'installation silencieuse sur Windows.
//
// Deux tables seulement :
//   - shops    : une ligne par boutique, identifiée par `device_id` (l'UUID que l'app
//                génère à l'inscription). L'échéance (`expiry_date`) est l'horodatage
//                en millisecondes que l'API renvoie à l'app, qui s'y conforme.
//   - payments : l'historique des prolongations. Chaque « Prolonger » du dashboard
//                ajoute une ligne — montant reçu, jours ajoutés, date.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DAY_MS, TRIAL_DAYS } from "./config.js";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const DB_PATH = join(DATA_DIR, "orchestrator.db");

mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;

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
`);

export interface ShopRow {
  id: number;
  device_id: string;
  owner_name: string;
  store_name: string;
  phone: string | null;
  location: string | null;
  registration_date: number;
  expiry_date: number;
  created_at: number;
  updated_at: number;
}

export interface ShopListItem extends ShopRow {
  payments: number;
}

export interface PaymentRow {
  id: number;
  shop_id: number;
  amount: number;
  days_added: number;
  created_at: number;
}

export interface ShopInput {
  device_id: string;
  owner_name: string;
  store_name: string;
  phone?: string;
  location?: string;
  registration_date: number;
}

export function getShopById(id: number): ShopRow | undefined {
  return db.prepare("SELECT * FROM shops WHERE id = ?").get(id) as ShopRow | undefined;
}

/**
 * Inscription ou mise à jour d'une boutique, identifiée par son `device_id`.
 *
 * Première venue : insertion, avec l'échéance calculée depuis la DATE D'INSCRIPTION
 * (`registration_date + essai`) et non depuis l'instant de réception — une boutique qui
 * ne synchronise que trois jours plus tard ne perd pas trois jours d'essai.
 *
 * Retour : mise à jour des quatre infos uniquement. L'échéance n'est JAMAIS touchée ici :
 * une resynchronisation ne doit pas réinitialiser l'essai, seul « Prolonger » l'étend.
 */
export function upsertShop(input: ShopInput): ShopRow {
  const now = Date.now();
  const existing = getShopByDeviceId(input.device_id);

  if (existing) {
    db.prepare(
      `UPDATE shops
       SET owner_name = ?, store_name = ?, phone = ?, location = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      input.owner_name,
      input.store_name,
      input.phone ?? null,
      input.location ?? null,
      now,
      existing.id,
    );
    return getShopById(existing.id)!;
  }

  const result = db
    .prepare(
      `INSERT INTO shops
         (device_id, owner_name, store_name, phone, location, registration_date, expiry_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.device_id,
      input.owner_name,
      input.store_name,
      input.phone ?? null,
      input.location ?? null,
      input.registration_date,
      input.registration_date + TRIAL_DAYS * DAY_MS,
      now,
      now,
    );
  return getShopById(Number(result.lastInsertRowid))!;
}

export function getShopByDeviceId(deviceId: string): ShopRow | undefined {
  return db.prepare("SELECT * FROM shops WHERE device_id = ?").get(deviceId) as ShopRow | undefined;
}

/** Toutes les boutiques, les plus proches de l'échéance en premier. */
export function listShops(): ShopListItem[] {
  return db
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM payments p WHERE p.shop_id = s.id) AS payments
       FROM shops s
       ORDER BY s.expiry_date ASC`,
    )
    .all() as unknown as ShopListItem[];
}

/**
 * Prolonge une licence : repart de max(aujourd'hui, échéance actuelle) — une prolongation
 * payée ne peut jamais expirer dans le passé — et journalise le paiement.
 */
export function extendShop(id: number, amount: number, days: number): ShopRow | undefined {
  const shop = getShopById(id);
  if (!shop) return undefined;

  const now = Date.now();
  const base = Math.max(now, shop.expiry_date);
  const next = base + days * DAY_MS;

  db.exec("BEGIN");
  try {
    db.prepare("UPDATE shops SET expiry_date = ?, updated_at = ? WHERE id = ?").run(next, now, id);
    db.prepare(
      "INSERT INTO payments (shop_id, amount, days_added, created_at) VALUES (?, ?, ?, ?)",
    ).run(id, amount, days, now);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return getShopById(id);
}

/** Historique des prolongations d'une boutique, la plus récente en premier. */
export function listPayments(shopId: number): PaymentRow[] {
  return db
    .prepare("SELECT * FROM payments WHERE shop_id = ? ORDER BY created_at DESC")
    .all(shopId) as unknown as PaymentRow[];
}
