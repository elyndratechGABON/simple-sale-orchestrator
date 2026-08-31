// ── Parser SMS Mobile Money ──────────────────────────────────────────────────────
// Extrait les données de paiement depuis un SMS de confirmation Mobile Money.
//
// Format supporté (Airtel Money Gabon) :
//   "Recu 1000F du 074337844,Helene. Nouveau solde 1148.6F. TID: PP260818.1345.D05428."
//
// Retourne un objet structuré ou null si le SMS ne correspond pas à un paiement.

/**
 * @typedef {Object} ParsedSms
 * @property {number}  amount  - Montant en FCFA (nombre entier)
 * @property {string}  phone   - Numéro du payeur (sans indicatif)
 * @property {string}  name    - Nom du payeur (trim, title-case)
 * @property {string}  tid     - Identifiant unique de transaction
 */

// Format Airtel Money : "Recu 1000F du 074337844,Helene. Nouveau solde 1148.6F. TID: PP260818.1345.D05428."
const AIRTEL_RE = /^Recu\s+([\d.,]+)F\s+du\s+(\d+)\s*,\s*([^.]+)\.\s*Nouveau solde\s+[\d.,]+F\s*\.\s*TID\s*:\s*(.+)/i;

// Format alternatif Moov / autre opérateur : "Paiement de 10000F recu de 076123456,Jean. Ref: ABC123."
const ALT_RE = /(?:Paiement|Payment)\s+(?:de\s+)?([\d.,]+)F\s+(?:recu|reçu)\s+(?:de\s+)?(\d+)\s*,\s*([^.]+)\.\s*(?:Ref|TID)\s*:\s*(.+)/i;

/**
 * Normalise un nom : trim, collapse espaces, title-case.
 * @param {string} raw
 * @returns {string}
 */
function normalizeName(raw) {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Parse un SMS de confirmation Mobile Money.
 * @param {string} sms - Texte brut du SMS
 * @returns {ParsedSms | null}
 */
export function parseSms(sms) {
  if (typeof sms !== "string") return null;
  const text = sms.trim();
  if (!text) return null;

  const match = text.match(AIRTEL_RE) || text.match(ALT_RE);
  if (!match) return null;

  const [, rawAmount, phone, rawName, tid] = match;

  // Montant : "10.000" ou "10000" ou "1 000" → 10000
  const amount = parseInt(rawAmount.replace(/[.\s]/g, ""), 10);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  return {
    amount,
    phone: phone.trim(),
    name: normalizeName(rawName),
    tid: tid.trim().replace(/[.\s]+$/, ""),
  };
}

/**
 * Vérifie si un SMS ressemble à un SMS de paiement Mobile Money
 * (même si le parsing échoue — utile pour filtrer avant forward).
 * @param {string} sms
 * @returns {boolean}
 */
export function isPaymentSms(sms) {
  if (typeof sms !== "string") return false;
  const text = sms.trim().toLowerCase();
  return text.startsWith("recu ") || text.includes("paiement") || text.includes("payment");
}
