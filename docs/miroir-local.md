# Le miroir local — la copie du commerce chez le commerçant

## La demande

> « L'orchestrateur serveur envoie les données en local régulièrement, et lors
> d'une demande de récupération je n'aurai qu'à allumer l'orchestrateur local. »

## Le principe

Le cloud garde l'archive des opérations (`sync_ops`). Une **instance locale** —
un petit service que le commerçant lance sur son propre ordinateur — en garde une
copie chez lui, et sait la **rendre** au cloud quand celui-ci l'a oubliée.

Deux sens de circulation, et c'est la boucle qui fait la promesse :

```
        DESCENDANT                       REMONTANT
  cloud  ────────────▶  local      local  ────────────▶  cloud
  (archive du compte)   (copie)     (ce que le cloud a purgé)
```

- **Descendant** : le cloud sert les opérations du compte (`POST /api/v1/mirror/ops`).
  L'instance locale les range dans un SQLite local.
- **Remontant** : l'instance locale rend au cloud les opérations **plus anciennes
  que la borne basse du cloud** (`POST /api/v1/mirror/push`). C'est ce qui rend la
  copie locale utile : le cloud purge son archive au bout de six mois, la copie
  locale garde tout.

## Pourquoi la instance locale TIRE

Le serveur ne pousse jamais — c'est la règle du projet (`docs/orchestrateur-flux.md`),
et c'est aussi la seule méthode qui marche derrière un routeur : un service chez le
commerçant est derrière son NAT, le cloud ne peut pas y entrer. Le miroir est donc
tiré par l'instance locale, à intervalles réguliers (15 min par défaut).

## Lancement

```bash
CLOUD_URL=https://simple-sale-orchestrator.vercel.app \
ACCOUNT_PHONE=07657843 \
ACCOUNT_PASSWORD=... \
node tools/local-orchestrator.mjs
```

L'instance :

- garde sa copie dans `data/mirror.sqlite` (`node:sqlite`, **aucune dépendance** à
  installer — Node 22+ l'a dans le cœur) ;
- sert la restauration (`POST /api/v1/restore`, `GET /api/v1/restore/:job_id`) avec
  le même contrat que le cloud ;
- **proxifie** le reste de l'API vers le cloud : elle est alors un orchestrateur de
  substitution ;
- exige les **identifiants du compte** pour servir l'archive : elle tient les
  données du commerce, elle ne les distribue pas à quiconque approche sur le réseau.

### HTTPS obligatoire pour la restauration

L'application est servie en **HTTPS**, et le navigateur refuse qu'une page HTTPS
appelle une adresse HTTP (contenu mixte). Une instance en `http://192.168.x.x`
sera donc **injoignable** par la caisse — sans que rien ne le dise côté serveur.

D'où `LOCAL_TLS_CERT` et `LOCAL_TLS_KEY` :

```bash
LOCAL_TLS_CERT=./cert.pem LOCAL_TLS_KEY=./key.pem node tools/local-orchestrator.mjs
```

Le certificat doit être reconnu par le téléphone. Un certificat invalide fait
échouer le **démarrage** : mieux vaut un échec franc qu'un serveur qui démarre et
ne négocie jamais le TLS.

Le miroir, lui, fonctionne dans les deux régimes (c'est lui qui parle au cloud).

## Ce que fait la caisse

1. Le commerçant saisit l'adresse de son instance dans **Paramètres → Sauvegarde et
   restauration → Récupérer depuis mon orchestrateur local**.
2. L'adresse est mémorisée sur l'appareil : elle n'est pas compilée, car elle change
   avec le réseau et l'instance n'est allumée que par intermittence.
3. La restauration interroge **l'instance locale d'abord, le cloud ensuite**. Ce
   repli est la résilience de la caisse : une instance éteinte ne rend pas la
   récupération impossible — le cloud garde l'archive courante, le local sert ce que
   le cloud a oublié.
4. Un service qui **refuse** (401, 403) n'est pas une panne : le refus est remonté
   tel quel, sans aller demander le cloud à la place (il répondrait la même chose).

## La sécurité de la remontée

La remontant écrit dans l'archive — et l'archive est rejouée par la caisse **sans
vérification de signature** (le serveur engage sa parole, cf. `apply/orchestrate.ts`).
Une remontée non vérifiée serait donc une injection d'historique : n'importe qui
connaissant le mot de passe du compte pourrait y glisser des ventes imaginaires.

La route vérifie donc **chaque opération** :

- la clé publique de l'appareil est cherchée dans les annonces du compte
  (`device.announce` → `public_key`) ;
- la signature ECDSA P-256 est vérifiée sur le corps canonique de l'op.

Le corps canonique est reproduit côté serveur (`backend/op-signature.mjs`) et
**épinglé par le même vecteur de test des deux côtés** :
`backend/tests/op-signature.test.mjs` (serveur) et
`src/lib/syncengine/identity/crypto.test.ts` (client). C'est ce qui garantit que les
deux implémentations ne divergent pas en silence — la divergence avait déjà coûté
une archive entière non propagée (commit `3e2f1b5c`).

## Le vecteur d'attaque du proxy

L'instance locale proxifie `/api/*` vers le cloud, **sauf** `/api/v1/mirror/ops` et
`/api/v1/mirror/push`. Les relaier par le proxy enverrait toutes les requêtes
depuis la même IP (celle du PC) — et le verrou de débit du cloud, qui protège la
vérification du mot de passe, serait contourné : n'importe qui sur le réseau local
pourrait tester des mots de passe sans jamais être bloqué.

## Ce que ce miroir ne fait pas

- Il ne remplace pas l'orchestrateur principal : le handshake, la synchronisation et
  le canal P2P continuent de viser le cloud.
- Il ne chiffre pas la copie locale : le SQLite est en clair sur le disque du
  commerçant (c'est sa machine, et le cloud chiffre déjà au repos).
- Il ne remplace pas la rétention du cloud : la copie locale est un filet, pas un
  remplacement de l'archive officielle.
