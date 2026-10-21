import type { ReactElement } from "react";

export const DAY_MS = 86_400_000;
export const ONLINE_WINDOW_MS = 120_000;

export const TIERS = [
  { price: 10_000, devices: 2 },
  { price: 25_000, devices: 4 },
  { price: 50_000, devices: 8 },
];

export const fmtDate = (ms: number | null | undefined): string =>
  ms ? new Date(ms).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

export const fmtDateShort = (ms: number): string =>
  new Date(ms).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });

export const fmtDateTime = (ms: number | null | undefined): string =>
  ms
    ? new Date(ms).toLocaleString("fr-FR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

export const fmtFcfa = (n: number | null | undefined): string =>
  n == null ? "—" : `${Math.round(n).toLocaleString("fr-FR")} F`;

export function fmtAgo(ms: number | null | undefined): string {
  if (!ms) return "jamais";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86_400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86_400)} j`;
}

export const tierForAmount = (amount: number) => [...TIERS].reverse().find((t) => amount >= t.price) ?? null;

export const daysFromAmount = (amount: number): number => {
  const t = tierForAmount(amount);
  return t ? Math.max(1, Math.round((amount / t.price) * 30)) : 0;
};

export const daysLeftOf = (expiry: number, now: number): number => Math.ceil((expiry - now) / DAY_MS);

export const plural = (n: number): string => (n > 1 ? "s" : "");

export function statusBadge(status: string): ReactElement {
  const cls =
    status === "active"
      ? "active"
      : status === "grace"
        ? "grace"
        : status === "suspended" || status === "over_limit"
          ? "suspended"
          : "expired";
  const label =
    status === "active"
      ? "Actif"
      : status === "grace"
        ? "En grâce"
        : status === "suspended"
          ? "Suspendu"
          : status === "over_limit"
            ? "Hors quota"
            : "Expiré";
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function deliveryBadge(deliveredAt: number | null | undefined, supersededAt: number | null | undefined): ReactElement {
  if (supersededAt) return <span className="badge superseded">Remplacée</span>;
  if (deliveredAt) return <span className="badge delivered">Récupérée</span>;
  return <span className="badge pending">En attente</span>;
}
