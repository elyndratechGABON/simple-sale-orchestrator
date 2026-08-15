#!/usr/bin/env bash
# Déploiement de l'orchestrateur des caisses POS sur une VM Oracle Cloud Always Free.
#   Aucune modification de code : le backend Node + SQLite tourne tel quel, disque persistant.
#
# Prérequis :
#   - VM Ubuntu 22.04/24.04 (micro AMD 1 OCPU/1 Go RAM suffit largement)
#   - Un domaine pointé vers l'IP publique de la VM (DuckDNS accepté) — requis pour HTTPS.
#   - Dans la console Oracle : autoriser TCP 80 et 443 dans la « security list » du VCN
#     (le firewall de la VM ne suffit pas, Oracle filtre aussi au niveau réseau).
#
# Usage (en root, sur la VM) :
#   sudo ORCH_DOMAIN=caisse.votredomaine.com bash oracle-setup.sh
#   sudo ORCH_DOMAIN=caisse.duckdns.org ADMIN_PASSWORD=un_mot_de_passe bash oracle-setup.sh
#
# À la fin : dashboard + API sur https://$ORCH_DOMAIN, puis poser sur Vercel :
#   VITE_ORCHESTRATOR_URL=https://$ORCH_DOMAIN   (projet elyndracaisse) et redéployer.
set -euo pipefail

DOMAIN="${ORCH_DOMAIN:-}"
ADMIN="${ADMIN_PASSWORD:-}"
APP_DIR="/opt/simple-sale-orchestrator"
DATA_DIR="/var/lib/orchestrator"
REPO="https://github.com/elyndratechGABON/simple-sale-orchestrator.git"

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "Lancer en root : sudo bash $0"; exit 1; }
[ -n "$DOMAIN" ] || { echo "ORCH_DOMAIN manquant — ex : caisse.duckdns.org"; exit 1; }

export DEBIAN_FRONTEND=noninteractive

# 1. Paquets de base -------------------------------------------------------------
log "Paquets de base"
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git ufw >/dev/null

# 2. Node 24 (node:sqlite exige Node >= 22.5) ------------------------------------
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 22 ]; then
  log "Installation de Node 24 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
log "Node $(node -v)"

# 3. Caddy (HTTPS Let's Encrypt automatique) --------------------------------------
if ! command -v caddy >/dev/null 2>&1; then
  log "Installation de Caddy (dépôt officiel)"
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key -o /usr/share/keyrings/caddy-stable.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi
log "Caddy $(caddy version | cut -d' ' -f1)"

# 4. Code source ------------------------------------------------------------------
if [ ! -d "$APP_DIR/.git" ]; then
  log "Clone du dépôt"
  git clone --depth 1 "$REPO" "$APP_DIR"
else
  log "Mise à jour du dépôt"
  git -C "$APP_DIR" pull --ff-only
fi

# 5. Dépendances + build du dashboard ---------------------------------------------
log "Dépendances backend"
( cd "$APP_DIR/backend" && npm ci --omit=dev --no-audit --no-fund )
log "Build du dashboard"
( cd "$APP_DIR/dashboard" && npm ci --no-audit --no-fund && npm run build )

# 6. Données (disque persistant) + mot de passe admin ------------------------------
mkdir -p "$DATA_DIR" /root/.orchestrator
if [ -z "$ADMIN" ]; then
  if [ -f /root/.orchestrator/admin-password ]; then
    ADMIN="$(cat /root/.orchestrator/admin-password)"
  else
    ADMIN="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)"
    printf '%s\n' "$ADMIN" > /root/.orchestrator/admin-password
    chmod 600 /root/.orchestrator/admin-password
  fi
fi
printf 'ADMIN_PASSWORD=%s\n' "$ADMIN" > "$APP_DIR/backend/.env"
chmod 600 "$APP_DIR/backend/.env"

# 7. Compte de service dédié -------------------------------------------------------
if ! id orchestrator >/dev/null 2>&1; then
  useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin orchestrator
fi
chown -R orchestrator:orchestrator "$APP_DIR" "$DATA_DIR"

# 8. Service systemd ---------------------------------------------------------------
log "Service systemd"
cat > /etc/systemd/system/orchestrator.service <<EOF
[Unit]
Description=Orchestrateur des caisses POS
After=network.target

[Service]
WorkingDirectory=$APP_DIR/backend
ExecStart=/usr/bin/node index.mjs
Environment=ORCHESTRATOR_DB=$DATA_DIR/orchestrator.db
Environment=PORT=8787
User=orchestrator
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now orchestrator

# 9. Caddy (reverse proxy HTTPS) ----------------------------------------------------
log "Caddy — reverse proxy vers 127.0.0.1:8787"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    encode gzip
    reverse_proxy 127.0.0.1:8787
}
EOF
caddy fmt --overwrite /etc/caddy/Caddyfile >/dev/null
systemctl enable --now caddy

# 10. Firewall (port 8787 exposé nulle part ailleurs) ------------------------------
log "Firewall : 22, 80, 443 ouverts ; le reste fermé"
ufw allow 22/tcp >/dev/null 2>&1
ufw allow 80/tcp >/dev/null 2>&1
ufw allow 443/tcp >/dev/null 2>&1
ufw --force enable >/dev/null

# 11. Récapitulatif ------------------------------------------------------------------
sleep 3
log "Vérification"
curl -fsS "http://127.0.0.1:8787/api/v1/admin/projects" -o /dev/null && echo "backend OK (8787)"
curl -fsS "https://$DOMAIN/api/v1/admin/projects" -o /dev/null && echo "HTTPS OK (https://$DOMAIN)"

cat <<SUMMARY

Déploiement terminé.
  Dashboard + API : https://$DOMAIN
  Mot de passe admin : $ADMIN
  Base SQLite : $DATA_DIR/orchestrator.db  (persistante, hors du dépôt)

Dernière étape — sur Vercel (projet elyndracaisse) :
  1. Variable d'environnement : VITE_ORCHESTRATOR_URL=https://$DOMAIN
  2. Redéployer le PWA. Les utilisateurs qui installent le PWA et enregistrent
     leur business apparaîtront alors sur https://$DOMAIN avec leurs vraies ventes.
SUMMARY
