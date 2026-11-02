// ── Rate limiter (sans dépendance) ───────────────────────────────────────────────
// Verrou de débit PAR IP sur les routes critiques (handshake, sync-data, demandes
// d'abonnement, webhook SMS, login). Sans lui, un script peut marteler ces routes :
// chaque invocation serverless est facturée (temps + mémoire) et les connexions
// Postgres se saturent — le coût de la plateforme explose sans même une attaque
// malsine, un bug côté caisse (boucle de retry) suffit.
//
// running best-effort : en serveless, la Map vit PAR INSTANCE — un attaquant réparti
// sur plusieurs instances contourne le compteur. L'exactitude n'est pas le but :
// RENDRE l'abus INEXPLOITABLE EN PRATIQUE l'est. Le limiteur de login, lui, garde sa
// logique dédiée (verrou après N ÉCHECS, pas après N requêtes) — les deux se
// complètent sur la même route, ce qui est l'"uniformisation" demandée.

const WINDOW_MS = Number(process.env.RATE_WINDOW_MS ?? 60_000);
const WINDOW_MAX = Number(process.env.RATE_WINDOW_MAX ?? 30);

/** `ip → { count, reset }` — purgé périodiquement pour ne pas grossir sans borne
 *  (les IP éphémères des proxies et du mobile changent à chaque requête). */
const hits = new Map();

function sweep() {
  const now = Date.now();
  for (const [ip, win] of hits) if (win.reset <= now) hits.delete(ip);
}
const sweeper = setInterval(sweep, WINDOW_MS);
sweeper.unref?.();

/** L'IP du client : derrière Vercel, l'adresse socket est celle du proxy —
 *  l'en-tête `x-forwarded-for` (posé par la plateforme, non falsifiable à
 *  l'origine du proxy de confiance) la porte. */
export function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress ?? "inconnu";
}

/** Middleware : 30 requêtes / minute / IP par défaut (env sur-écritable),
 *  renvoie 429 avec `Retry-After` quand le plafond est atteint. */
export function rateLimit(opts = {}) {
  const windowMs = opts.windowMs ?? WINDOW_MS;
  const max = opts.max ?? WINDOW_MAX;
  return function rateLimitMw(req, res, next) {
    if (req.method === "OPTIONS") return next();
    const ip = clientIp(req);
    const now = Date.now();
    let win = hits.get(ip);
    if (!win || win.reset <= now) {
      win = { count: 0, reset: now + windowMs };
      hits.set(ip, win);
    }
    win.count += 1;
    if (win.count > max) {
      const retry = Math.ceil((win.reset - now) / 1000);
      res.set("Retry-After", String(retry));
      return res.status(429).json({
        error: `Trop de requêtes. Réessayez dans ${retry} secondes.`,
      });
    }
    return next();
  };
}
