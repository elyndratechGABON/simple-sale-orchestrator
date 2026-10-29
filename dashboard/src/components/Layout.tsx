import type { ReactElement, ReactNode } from "react";
import {
  TrendingUpIcon,
  StoreIcon,
  BanknoteIcon,
  GearIcon,
  LogOutIcon,
  SunIcon,
  MoonIcon,
} from "../icons";

export type Page = "tableau" | "boutiques" | "boutique" | "facturation" | "systeme";

const NAV_ITEMS: { id: Page; label: string; icon: ReactElement; masterOnly?: boolean }[] = [
  { id: "tableau", label: "Tableau de bord", icon: <TrendingUpIcon size={18} /> },
  { id: "boutiques", label: "Boutiques", icon: <StoreIcon size={18} /> },
  { id: "facturation", label: "Abonnements & paiements", icon: <BanknoteIcon size={18} /> },
  { id: "systeme", label: "Système", icon: <GearIcon size={18} /> },
];

export function Layout({
  page,
  scope,
  projectName,
  pendingCount,
  dark,
  onNavigate,
  onLogout,
  onToggleDark,
  children,
}: {
  page: Page;
  scope: "master" | "project";
  projectName: string;
  pendingCount: number;
  dark: boolean;
  onNavigate: (p: Page) => void;
  onLogout: () => void;
  onToggleDark: () => void;
  children: ReactNode;
}) {
  const visible = NAV_ITEMS.filter((n) => !n.masterOnly || scope === "master");

  return (
    <div className="shell">
      <aside className="rail hidden md:flex md:flex-col">
        <div className="rail-brand">
          <span className="logo">
            <StoreIcon size={17} />
          </span>
          <div>
            <strong>ELYNDRA CONTROL CENTER</strong>
            <div className="scope">{scope === "master" ? "Administration" : projectName}</div>
          </div>
        </div>

        <nav className="rail-section" aria-label="Navigation">
          {visible.map((n) => (
            <button
              key={n.id}
              className={`rail-item ${page === n.id ? "active" : ""}`}
              onClick={() => onNavigate(n.id)}
            >
              {n.icon}
              {n.label}
              {n.id === "facturation" && pendingCount > 0 && (
                <span className="count">{pendingCount}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="rail-footer">
          <span className="chip">{scope === "master" ? "Administrateur" : projectName}</span>
          <div className="rail-footer-actions">
            <button
              className="btn btn-ghost btn-icon"
              onClick={onToggleDark}
              title={dark ? "Mode clair" : "Mode sombre"}
              aria-label={dark ? "Passer en mode clair" : "Passer en mode sombre"}
            >
              {dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
            </button>
            <button className="btn btn-ghost btn-icon" onClick={onLogout} title="Déconnexion" aria-label="Déconnexion">
              <LogOutIcon size={16} />
            </button>
          </div>
        </div>
      </aside>

      {/* Bottom nav mobile : le rail sémantique reste sur desktop ; sur téléphone, les
          4 destinations vivent en barre fixe — le pouce les atteint sans scroll. */}
      <nav
        className="bottom-nav fixed inset-x-0 bottom-0 z-40 flex md:hidden"
        aria-label="Navigation mobile"
      >
        {visible.map((n) => (
          <button
            key={n.id}
            className={`bottom-nav-item relative flex flex-1 flex-col items-center justify-center gap-0.5 ${
              page === n.id ? "active" : ""
            }`}
            onClick={() => onNavigate(n.id)}
            aria-current={page === n.id ? "page" : undefined}
          >
            {n.icon}
            <span className="text-[10px] leading-tight">{n.label.split(" ")[0]}</span>
            {n.id === "facturation" && pendingCount > 0 && (
              <span className="absolute right-3 top-1 rounded-full bg-danger px-1.5 text-[10px] font-semibold text-white">
                {pendingCount}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="main">
        <header className="topbar">
          <div className="grow">
            <h1>
              {visible.find((n) => n.id === page)?.label ?? "Dashboard"}
            </h1>
          </div>
          <span className="live" title="Temps réel via SSE">
            <span className="dot" />
            Live
          </span>
        </header>

        <main className="content">
          {children}
        </main>
      </div>
    </div>
  );
}
