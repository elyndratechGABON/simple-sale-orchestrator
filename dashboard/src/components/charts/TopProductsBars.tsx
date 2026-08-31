import { InboxIcon } from "../../icons";
import { fmtFcfa } from "../../utils";

export function TopProductsBars({ products }: { products: { name: string; quantity: number; revenue: number }[] }) {
  if (products.length === 0)
    return (
      <div className="chart-empty">
        <InboxIcon size={22} />
        Aucun produit \u2014 les caisses doivent synchroniser.
      </div>
    );
  const max = Math.max(1, ...products.map((p) => p.revenue));
  return (
    <div className="bars">
      {products.map((p) => (
        <div className="bar-row" key={p.name} title={`${p.name} \u2014 \u00d7${p.quantity}`}>
          <span className="bar-name">{p.name}</span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${(p.revenue / max) * 100}%` }} />
          </div>
          <span className="bar-value mono">{fmtFcfa(p.revenue)}</span>
        </div>
      ))}
    </div>
  );
}
