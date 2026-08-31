import type { ReactElement } from "react";
import { statusBadge as baseStatusBadge } from "../../utils";

export function Badge({ status, label }: { status: string; label?: string }) {
  return baseStatusBadge(status);
}

export function StatusBadge({ status }: { status: string }) {
  return baseStatusBadge(status);
}

export function DeliveryBadge({ deliveredAt, supersededAt }: { deliveredAt: number | null | undefined; supersededAt: number | null | undefined }): ReactElement {
  if (supersededAt) return <span className="badge superseded">Remplac\u00e9e</span>;
  if (deliveredAt) return <span className="badge delivered">R\u00e9cup\u00e9r\u00e9e</span>;
  return <span className="badge pending">En attente</span>;
}
