# Orchestrateur — le PC du commerçant

Le module qui reçoit les données des caisses POS et permet de gérer les licences.
C'est le « début de projet » : il deviendra à terme le centre de gestion de tous tes
projets. Pour l'instant, une seule chose dedans : **les boutiques qui utilisent la caisse**.

## Lancer

```bash
cd orchestrator
npm install
npm run dev
```

Puis ouvrir **http://localhost:8787** dans le navigateur du PC.

- `npm run dev` : démarre le serveur (rechargement automatique en cas de changement).
- `npm run start` : idem, sans rechargement.
- Port par défaut : **8787** (surchargeable : `$env:PORT=9000; npm run dev`).
- Les données vivent dans `orchestrator/data/orchestrator.db` (SQLite).

## Ce que fait le dashboard

- Liste des boutiques : nom, propriétaire, téléphone, lieu, date d'inscription, échéance.
- Statut de chaque licence : **Essai** (30 jours offerts), **Actif** (payé), **Expiré**.
- **Prolonger** : entre le montant reçu en FCFA, le système ajoute les jours
  (`1 mois = 10 000 FCFA`, configurable dans `src/config.ts`).
- Historique des paiements par boutique.

## Comment les boutiques arrivent ici

1. La caisse s'inscrit une fois (Paramètres → Mon établissement, 4 infos).
2. Elle stocke ses infos **localement** — elle fonctionne sans réseau.
3. Dès qu'elle a une connexion (démarrage, retour en ligne, ou bouton « Synchroniser »),
   elle envoie son profil à l'URL configurée dans Paramètres.
4. L'orchestrateur répond avec la date d'expiration de la licence, que la caisse mémorise.

## Faire joindre un téléphone

Le téléphone et ce PC doivent être sur le **même réseau Wi-Fi**.

1. Trouver l'adresse IP du PC : `ipconfig` (ligne « Adresse IPv4 », ex. `192.168.1.42`).
2. Sur la caisse : Paramètres → Mon établissement → champ « Adresse du serveur » :
   `http://192.168.1.42:8787`.
3. Cliquer « Synchroniser ».

> Windows peut bloquer le port 8787 : autoriser Node dans le pare-feu quand l'invite
> apparaît (ou ajouter une règle entrante sur le port 8787).
> L'application Android (Capacitor) nécessitera `usesCleartextTraffic` en release —
> pas nécessaire pour tester sur le navigateur du téléphone ou du PC.

## Règles de licence (source de vérité : `src/config.ts`)

- Essai : **30 jours** à compter de l'inscription, calculés côté serveur.
- Prolongation : `jours = montant / prix_du_mois × 30`, arrondi, jamais moins d'un jour.
  Une prolongation repart de `max(aujourd'hui, échéance actuelle)` : payer tôt ne fait
  jamais perdre de jours.

## Sécurité — à garder en tête

Le serveur est volontairement **sans mot de passe** pour l'instant : il est pensé pour
tourner sur le réseau privé du commerçant. Tant qu'il n'est pas exposé sur Internet,
c'est acceptable. Le jour où l'orchestrateur sera hébergé, une authentification sera
indispensable avant toute ouverture.
