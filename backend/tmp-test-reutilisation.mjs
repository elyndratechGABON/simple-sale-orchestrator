/** TEST RÉEL DE LA RÉUTILISATION : un écran libéré qui revient avec la MÊME
 *  empreinte doit RÉATTRIBUER sa fiche ET la RÉACTIVER (pas de nouvelle fiche).
 *  Vérifié contre la PRODUCTION, sur des fiches jetables. */
import pg from 'pg';

const PROD = 'https://simple-sale-orchestrator.vercel.app';
const URL =
  'postgresql://elyndra_prod:npg_RoCw8iB4cFPm@ep-round-waterfall-ayiyzxnt-pooler.c-5.us-east-2.aws.neon.tech/orchestrator?sslmode=require&channel_binding=require';

const DEVICE_A = `test-reuse-A-${Date.now()}`;
const DEVICE_B = `test-reuse-B-${Date.now()}`;
const EMPREINTE = `fp-reuse-${Date.now()}`;
const COMPTE = 3; // le compte ROROr (celui de BERNARD)

const c = new pg.Client({ connectionString: URL, connectionTimeoutMillis: 25000 });
await c.connect();
console.log('connecté ✓\n');

// 1. Une fiche d'écran, puis LIBÉRÉE (l'employé est parti).
const now = Date.now();
const ins = await c.query(
  `INSERT INTO shops (device_id, owner_name, store_name, phone, location, registration_date,
                      expiry_date, created_at, updated_at, app_origin, account_id, device_fingerprint)
   VALUES ($1,'BERNARD','ROROr','076565434','Akanda',$2,$3,$2,$2,'pos',$4,$5) RETURNING id`,
  [DEVICE_A, now, now + 30 * 86400000, COMPTE, EMPREINTE],
);
const idFiche = ins.rows[0].id;
await c.query(`UPDATE shops SET released_at = $1 WHERE id = $2`, now, idFiche);
console.log(`fiche #${idFiche} créée puis LIBÉRÉE (écran parti) : ${DEVICE_A}`);

// 2. La bénédiction qui rattache l'appareil qui revient au compte.
await c.query(
  `INSERT INTO device_blessings (device_id, account_id, blessed_at, blessed_by)
   VALUES ($1,$2,$3,'test')`,
  [DEVICE_B, COMPTE, now],
);

const avant = await c.query('SELECT COUNT(*)::int AS n FROM shops');
console.log(`fiches de shops avant le retour : ${avant.rows[0].n}\n`);

// 3. L'écran REVIENT : même empreinte, nouvel identifiant d'écran.
const hs = await fetch(`${PROD}/api/v1/handshake`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    device_id: DEVICE_B,
    store_name: 'ROROr',
    owner_name: '',
    phone: '076565434',
    location: 'Akanda',
    app_version: '1.0.0-test',
    app_origin: 'pos',
    device_fingerprint: EMPREINTE,
    account_phone: '076565434',
    employee_name: 'Le slayboy',
    employee_phone: '074231548',
  }),
});
console.log(`POST /api/v1/handshake → ${hs.status}`);

// 4. Vérifications.
const apres = await c.query('SELECT COUNT(*)::int AS n FROM shops');
const fiche = await c.query(
  `SELECT id, device_id, released_at IS NULL AS reactivee, account_id, employee_name
     FROM shops WHERE device_fingerprint = $1`,
  [EMPREINTE],
);
const reprise = fiche.rows[0];

console.log(`\nfiches de shops après le retour : ${apres.rows[0].n} (avant : ${avant.rows[0].n})`);
console.log(`fiche porteuse de l'empreinte :`);
console.log(`   id=${reprise.id}  device_id=${reprise.device_id}  libérée=${!reprise.reactivee}  compte=${reprise.account_id}  employé=${reprise.employee_name}`);
console.log(`\n${apres.rows[0].n === avant.rows[0].n ? '✅ AUCUNE nouvelle fiche créée' : '❌ une fiche fantôme a été créée'}`);
console.log(`${reprise.device_id === DEVICE_B ? '✅ la fiche a été RÉATTRIBUÉE' : '❌ la fiche n’a pas été réattribuée'}`);
console.log(`${reprise.reactivee ? '✅ la fiche est RÉACTIVÉE (la place lui revient)' : '❌ la fiche est restée LIBÉRÉE'}`);

// 5. Nettoyage.
await c.query(`DELETE FROM device_blessings WHERE device_id = $1`, [DEVICE_B]);
await c.query(`DELETE FROM activity_events WHERE shop_id = $1`, [idFiche]);
await c.query(`DELETE FROM shops WHERE id = $1`, [idFiche]);
const reste = await c.query('SELECT COUNT(*)::int AS n FROM shops');
console.log(`\nnettoyage fait — fiches restantes : ${reste.rows[0].n}`);
await c.end();
