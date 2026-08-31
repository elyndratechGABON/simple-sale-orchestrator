import type { ReactElement } from "react";

type StatCardProps = {
  label: string;
  value: string | number;
  icon?: ReactElement;
  variant?: "default" | "accent" | "ok" | "warn" | "danger";
};

export function StatCard({ label, value, icon, variant = "default" }: StatCardProps) {
  return (
    <div className="stat-card">
      {icon && <div className={`stat-card-icon ${variant}`}>{icon}</div>}
      <div className="stat-card-content">
        <div className="stat-card-label">{label}</div>
        <div className={`stat-card-value mono ${variant === "accent" ? "accent" : variant === "ok" ? "ok" : variant === "warn" ? "warn" : variant === "danger" ? "danger" : ""}`}>
          {value}
        </div>
      </div>
    </div>
  );
}
