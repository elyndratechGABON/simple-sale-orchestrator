// Audit log, activité & paiement events (Control Center Elyndra).
// Ces helpers transforment l'orchestrateur existant en un vrai Control Center
// sans casser aucune route ni table existante. Tous les helpers sont ASYNC (Postgres).
import { db } from "../config.mjs";
import { sessionOf } from "./auth.mjs";

/** Identifiant de l'admin depuis la session (master_id pour audit trail). */
export function adminIdOf(req) {
  const session = sessionOf(req);
  if (!session) return "unknown";
  return session.scope === "master" ? "master" : `projet:${session.project}`;
}

/** Enregistre une action administrative dans le log d'audit. */
export const logAdminAction = (req, targetType, targetId, action, reason) =>
  db.run(
    "INSERT INTO admin_actions (admin_id, target_type, target_id, action, reason, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    adminIdOf(req),
    targetType,
    String(targetId),
    action,
    reason ?? null,
    Date.now(),
  );

/** Enregistre un événement dans la timeline d'activité. */
export const logActivity = (level, category, title, detail, data, shopId, accountId, projectId) =>
  db.run(
    `INSERT INTO activity_events (level, category, title, detail, data, shop_id, account_id, project_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    level,
    category,
    title,
    detail ?? null,
    data ? JSON.stringify(data) : null,
    shopId ?? null,
    accountId ?? null,
    projectId ?? null,
    Date.now(),
  );

/**
 * Crée un payment_event unifié à partir d'un paiement reçu (SMS matché, validation 1 clic,
 * ou paiement manuel). Idempotence par (provider, reference). Retourne l'id du payment_event
 * ou null si doublon.
 */
export async function upsertPaymentEvent({ account_id, shop_id, device_id, amount, provider = "manual", reference, status = "confirmed", source = "manual", received_at, note }) {
  const now = received_at ?? Date.now();
  try {
    const info = await db.get(
      `INSERT INTO payment_events (account_id, shop_id, device_id, amount, provider, reference, status, source, received_at, confirmed_at, note, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      account_id,
      shop_id ?? null,
      device_id ?? null,
      amount,
      provider,
      reference,
      status,
      source,
      now,
      status === "confirmed" ? now : null,
      note ?? null,
      now,
    );
    return Number(info.id);
  } catch (e) {
    if (String(e?.code ?? e?.message).includes("unique") || String(e?.code ?? e?.message).includes("23505")) return null; // doublon
    throw e;
  }
}