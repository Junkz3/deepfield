#!/usr/bin/env bash
# One-shot deploy to a plain Ubuntu VM (tested target: Vultr Cloud Compute).
#   ./deploy/deploy.sh root@<VM_IP>
# Requires: local npm build works, ssh key auth on the VM, .env present locally
# (VULTR_INFERENCE_API_KEY + VULTR_BASE_URL; it is copied to the server only).
set -euo pipefail

HOST="${1:?usage: ./deploy/deploy.sh user@vm-ip}"
APP_DIR=/opt/repaircenter

echo "== build =="
npm run build

echo "== first-time server setup (idempotent) =="
ssh "$HOST" bash -s <<'SETUP'
set -e
command -v node >/dev/null || (apt-get update -qq && apt-get install -y -qq nodejs)
id repaircenter &>/dev/null || useradd --system --create-home repaircenter
mkdir -p /opt/repaircenter
SETUP

echo "== sync artifacts =="
rsync -az --delete dist "$HOST:$APP_DIR/"
rsync -az deploy/server.mjs deploy/auth.mjs "$HOST:$APP_DIR/deploy/"
rsync -az .env "$HOST:$APP_DIR/.env"
rsync -az deploy/repaircenter.service "$HOST:/etc/systemd/system/repaircenter.service"

echo "== (re)start =="
ssh "$HOST" bash -s <<'START'
set -e
echo "PORT=8080" >> /opt/repaircenter/.env.tmp || true
sort -u /opt/repaircenter/.env /opt/repaircenter/.env.tmp 2>/dev/null > /opt/repaircenter/.env.merged || cp /opt/repaircenter/.env /opt/repaircenter/.env.merged
mv /opt/repaircenter/.env.merged /opt/repaircenter/.env
rm -f /opt/repaircenter/.env.tmp
chown -R repaircenter:repaircenter /opt/repaircenter
# port 80 needs the capability, not root
setcap 'cap_net_bind_service=+ep' "$(command -v node)"
systemctl daemon-reload
systemctl enable --now repaircenter
systemctl restart repaircenter
sleep 1
systemctl --no-pager --lines=5 status repaircenter
START

echo "== done: http://${HOST#*@}/ =="
