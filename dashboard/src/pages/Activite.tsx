import { useEffect, useState } from "react";
import { fetchActivity, type ActivityEvent } from "../api";
import { fmtDateTime, fmtAgo } from "../utils";
import { InboxIcon } from "../icons";

const LEVEL_LABEL: Record<string, string> = {
  info: "Info",
  success: "Succ\u00e8s",
  warn: "Avertissement",
  error: "Erreur",
};

const LEVEL_CLS: Record<string, string> = {
  info: "",
  success: "ok",
  warn: "",
  error: "danger",
};

export function Activite() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetchActivity({ limit: 50 });
        if (!alive) return;
        setEvents(res.events);
        setReady(true);
        setError("");
      } catch {
        if (alive) setError("Impossible de charger l'activit\u00e9.");
      }
    };
    load();
    const t = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  return (
    <>
      {error && <div className="alert-banner">{error}</div>}

      {!ready ? (
        <div className="skeleton" style={{ height: 200 }} />
      ) : events.length === 0 ? (
        <div className="empty">
          <InboxIcon size={28} />
          <strong>Aucune activit\u00e9</strong>
          Les \u00e9v\u00e9nements apparaissent au fil des synchronisations.
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Niveau</th>
                <th>Type</th>
                <th>\u00c9v\u00e9nement</th>
                <th>Quand</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>
                    <span className={`badge ${LEVEL_CLS[e.level] ?? ""}`}>
                      {LEVEL_LABEL[e.level] ?? e.level}
                    </span>
                  </td>
                  <td>
                    <span className="mono">{e.category}</span>
                  </td>
                  <td className="cell-store">
                    <strong>{e.title}</strong>
                    {e.detail && <div className="meta">{e.detail}</div>}
                  </td>
                  <td className="mono" title={fmtDateTime(e.created_at)}>{fmtAgo(e.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
