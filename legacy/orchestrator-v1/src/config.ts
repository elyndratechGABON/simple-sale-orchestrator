// Réglages globaux de l'orchestrateur : le prix du mois et la durée de l'essai.
// Ce sont les deux seuls nombres qui pilotent la licence — modifiables ici,
// c'est la source de vérité que le dashboard affiche et que l'API applique.
import { randomBytes } from "node:crypto";

/** Prix d'un mois d'abonnement, en FCFA. */
export const PRICE_PER_MONTH_FCFA = 10_000;

/** Durée de l'essai offert à l'inscription, en jours. */
export const TRIAL_DAYS = 30;

/** Jour en millisecondes. */
export const DAY_MS = 86_400_000;

/** Port d'écoute du serveur. Surchargeable avec la variable d'environnement PORT. */
export const PORT = Number(process.env.PORT ?? 8787);

/**
 * Mot de passe du dashboard. À définir via la variable d'environnement ADMIN_PASSWORD.
 * S'il est absent, un mot de passe aléatoire est généré au démarrage et affiché en
 * console — le serveur reste utilisable sans configuration, mais il faut recopier
 * le mot de passe après chaque redémarrage.
 */
const hasExplicitPassword = typeof process.env.ADMIN_PASSWORD === "string" && process.env.ADMIN_PASSWORD.length > 0;
export const ADMIN_PASSWORD = hasExplicitPassword
  ? process.env.ADMIN_PASSWORD!
  : randomBytes(8).toString("hex");
/** Vrai quand le mot de passe a été généré (pas de ADMIN_PASSWORD fournie). */
export const PASSWORD_GENERATED = !hasExplicitPassword;
