// Scanner de projet — analyse un repo d'application et écrit son manifest pour
// l'orchestrateur (backend/manifests/<id>.json).
//
// Usage :
//   node scan.mjs <chemin-du-repo> [--out <dossier-manifests>] [--price 10000] [--trial 30] [--force]
//
// Ce que fait le script :
//   1. Lit package.json (nom, description, dépendances).
//   2. Cherche l'identité d'app : APP_ORIGIN / VITE_APP_ORIGIN / app_origin.
//   3. Détecte le type d'app (heursitiques, cf. detectType).
//   4. Trouve le contrat de sync (buildLightPayload / syncData / data_payload) et en
//      extrait les KPI (totals, by_day, top_products).
//   5. Détecte le schéma local (IndexedDB/Dexie) s'il existe.
//   6. Écrit backend/manifests/<id>.json — à relire et valider avant de commiter.
//
// Le manifest est un POINT DE DÉPART : les prix/essai sont des défauts modifiables à
// la main ou dans le dashboard (POST /api/v1/admin/projects/:id/config).
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

function usage() {
  console.error(`Usage : node scan.mjs <chemin-du-repo> [--out <dossier>] [--price N] [--trial N] [--force]`);
  process.exit(1);
}

// ── Args ───────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const repoArg = args.find((a) => !a.startsWith("--"));
if (!repoArg) usage();
const repoPath = resolve(repoArg);
const outDir = argOf("--out") ? resolve(argOf("--out")) : resolve(join(repoArg, "..", "simple-sale-orchestrator", "backend", "manifests"));
const forcedPrice = Number(argOf("--price"));
const forcedTrial = Number(argOf("--trial"));
const force = args.includes("--force");

if (!existsSync(repoPath) || !statSync(repoPath).isDirectory()) {
  console.error(`Dossier introuvable : ${repoPath}`);
  process.exit(1);
}

// ── Lecture récursive des sources ──────────────────────────────────────────────────
const SKIP = new Set(["node_modules", ".git", "dist", ".output", ".vercel", "build", "public", "legacy"]);
function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (/\.(ts|tsx|js|mjs|json)$/.test(entry)) files.push(full);
  }
  return files;
}
const files = walk(repoPath);
const read = (f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
};
const allSrc = files.map(read).join("\n");
const srcFiles = files.filter((f) => /\.(ts|tsx|js|mjs)$/.test(f));

// ── 1. package.json ────────────────────────────────────────────────────────────────
let pkg = {};
const pkgFile = join(repoPath, "package.json");
if (existsSync(pkgFile)) {
  try {
    pkg = JSON.parse(read(pkgFile));
  } catch {
    console.warn("package.json illisible — ignoré.");
  }
}

// ── 2. Identité d'app (app_origin) ─────────────────────────────────────────────────
let appOrigin = null;
const originMatch = allSrc.match(/VITE_APP_ORIGIN\s*[^]*?\.trim\(\)\s*\|\|\s*"([^"]+)"/);
if (originMatch) appOrigin = originMatch[1];
else {
  const m2 = allSrc.match(/APP_ORIGIN\s*=\s*"([^"]+)"/);
  if (m2) appOrigin = m2[1];
  else {
    const m3 = allSrc.match(/app_origin\s*:\s*APP_ORIGIN/);
    if (m3) appOrigin = "pos";
  }
}

// ── 3. Type d'app (heuristiques) ───────────────────────────────────────────────────
function detectType(src) {
  const dbSrc = srcFiles.filter((f) => /(db|database|schema)/i.test(f)).map(read).join("\n");
  const isPos =
    /sales\s*=|sale_items\s*=|price_at_sale/.test(dbSrc) &&
    (/Dexie/.test(dbSrc) || /IndexedDB/.test(dbSrc));
  if (isPos) return "pos";
  if (/computePeriodStats|buildLightPayload|syncData|data_payload/.test(src)) return "sync-app";
  return "app";
}
const type = detectType(allSrc);

// ── 4. KPI du contrat de sync ──────────────────────────────────────────────────────
const KPI_LABELS = {
  revenue: "Chiffre d'affaires",
  profit: "Bénéfice",
  sales: "Ventes",
  items: "Articles vendus",
  customers: "Clients servis",
  orders: "Commandes",
  bookings: "Réservations",
  members: "Nouveaux membres",
  messages: "Messages envoyés",
  plays: "Lectures",
  downloads: "Téléchargements",
};

// Les clés de l'objet `totals` du payload — ex. `totals: { revenue: ..., profit: ... }`.
function detectTotalsKeys(src) {
  const idx = src.indexOf("totals:");
  if (idx < 0) return [];
  const slice = src.slice(idx, idx + 600);
  const inner = slice.match(/totals:\s*\{(.{0,400}?)\}/s);
  if (!inner) return [];
  const keys = [];
  for (const m of inner[1].matchAll(/(\w+)\s*:/g)) keys.push(m[1]);
  return [...new Set(keys)].filter((k) => !["day", "days"].includes(k));
}

// Les clés portées par chaque jour de la série `by_day` — ex. `(d) => ({ day, revenue, sales })`.
function detectByDayKeys(src) {
  const idx = src.indexOf("by_day:");
  if (idx < 0) return [];
  const slice = src.slice(idx, idx + 800);
  const inner = slice.match(/by_day:[\s\S]{0,200}?\{\s*([\s\S]{0,250}?)\}/s);
  if (!inner) return [];
  const keys = [];
  for (const m of inner[1].matchAll(/(\w+)\s*:/g)) keys.push(m[1]);
  return [...new Set(keys)].filter((k) => !["day", "days"].includes(k));
}

function has(src, needle) {
  return src.includes(needle);
}

const totalsKeys = detectTotalsKeys(allSrc);
const metrics = (totalsKeys.length ? totalsKeys : ["revenue", "profit", "sales"]).map((k) => ({
  key: k,
  label: KPI_LABELS[k] ?? k,
  kind: /revenue|profit|total|amount|price|ca|mrr/i.test(k) ? "money" : "count",
}));

const series = {};
if (has(allSrc, "by_day")) {
  const keys = detectByDayKeys(allSrc);
  series.by_day = { keys: keys.length ? keys : ["revenue", "profit", "sales"] };
}
if (has(allSrc, "top_products")) series.top_products = { keys: ["quantity", "revenue"] };

// ── 5. Schéma local (IndexedDB/Dexie) ──────────────────────────────────────────────
function detectSchema(src) {
  const names = new Set();
  const dbFile = srcFiles.find((f) => /db\.ts$/.test(f) || /db\.mjs$/.test(f));
  const dbSrc = dbFile ? read(dbFile) : src;
  for (const m of dbSrc.matchAll(/(\w+)\.addTable|store\(\s*["'](\w+)["']|from\(\s*["'](\w+)["']/g)) {
    const name = m[1] || m[2] || m[3];
    if (name) names.add(name);
  }
  return [...names].filter((n) => !["db", "database"].includes(n));
}

// ── 6. Détection du dossier du repo parent (nom du projet Vercel) ──────────────────
const repoName = pkg.name?.replace(/^@[^/]+\//, "") || requireRepoName(repoPath);

function requireRepoName(p) {
  const base = p.split(/[\\/]/).pop() ?? "app";
  return base.replace(/-(main|cop(y|ie))$/i, "");
}

// ── Assemblage ─────────────────────────────────────────────────────────────────────
const price = Number.isFinite(forcedPrice) && forcedPrice > 0 ? forcedPrice : 10000;
const trial = Number.isFinite(forcedTrial) && forcedTrial > 0 ? forcedTrial : 30;
const periodDays = has(allSrc, "lastDaysRange(30)") || has(allSrc, "lastDaysRange(7)") ? 7 : 7;

const manifest = {
  id: appOrigin || requireRepoName(repoPath),
  name: pkg.description || repoName,
  type,
  pricing: { price_per_month_fcfa: price, trial_days: trial },
  period_days: periodDays,
  metrics,
  series,
  source: {
    repo: repoName,
    package_name: pkg.name ?? null,
    detected_type: type,
    detected_tables: detectSchema(allSrc),
  },
};

// ── Écriture ───────────────────────────────────────────────────────────────────────
const outFile = join(outDir, `${manifest.id}.json`);
let existing = null;
if (existsSync(outFile)) {
  if (!force) {
    console.error(`Refus : ${outFile} existe déjà. Utilisez --force pour l'écraser.`);
    process.exit(1);
  }
  try {
    existing = JSON.parse(read(outFile));
  } catch {
    /* manifest existant illisible — on repars de zéro */
  }
}
// --force préserve les réglages manuels (nom, tarif, KPI, séries) et ne rafraîchit que
// la détection (type, période, source). Sinon, un rescan détruirait les ajustements.
if (existing) {
  manifest.name = existing.name ?? manifest.name;
  manifest.pricing = existing.pricing ?? manifest.pricing;
  manifest.metrics = existing.metrics ?? manifest.metrics;
  manifest.series = existing.series ?? manifest.series;
}
writeFileSync(outFile, JSON.stringify(manifest, null, 2) + "\n");

// ── Compte-rendu ───────────────────────────────────────────────────────────────────
console.log(`\nManifest généré : ${outFile}\n`);
console.log(`  id          : ${manifest.id}`);
console.log(`  name        : ${manifest.name}`);
console.log(`  type        : ${manifest.type}`);
console.log(`  pricing     : ${price} FCFA/mois · essai ${trial} j`);
console.log(`  KPI         : ${metrics.map((m) => m.key).join(", ")}`);
if (manifest.series.by_day) console.log(`  série       : by_day (${manifest.series.by_day.keys.join(", ")})`);
if (manifest.series.top_products) console.log(`  série       : top_products`);
console.log(`  tables loc. : ${manifest.source.detected_tables.join(", ") || "aucune détectée"}\n`);
console.log("Revoir le fichier avant de le commiter — le scanner fait des hypothèses.");
