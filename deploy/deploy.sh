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
# speech relay needs ffmpeg (ASR decode) and a python venv
command -v ffmpeg >/dev/null || (apt-get update -qq && apt-get install -y -qq ffmpeg)
python3 -c 'import ensurepip' 2>/dev/null || (apt-get update -qq && apt-get install -y -qq python3-venv)
id repaircenter &>/dev/null || useradd --system --create-home repaircenter
mkdir -p /opt/repaircenter/tts-relay
SETUP

echo "== sync artifacts =="
rsync -az --delete dist "$HOST:$APP_DIR/"
rsync -az deploy/server.mjs deploy/auth.mjs deploy/mailer.mjs deploy/backup.sh "$HOST:$APP_DIR/deploy/"
rsync -az .env "$HOST:$APP_DIR/.env"
rsync -az tools/tts-relay/serve.py tools/tts-relay/requirements.txt "$HOST:$APP_DIR/tts-relay/"
rsync -az deploy/repaircenter.service "$HOST:/etc/systemd/system/repaircenter.service"
rsync -az deploy/tts-relay.service "$HOST:/etc/systemd/system/tts-relay.service"
rsync -az deploy/repaircenter-backup.service "$HOST:/etc/systemd/system/repaircenter-backup.service"
rsync -az deploy/repaircenter-backup.timer "$HOST:/etc/systemd/system/repaircenter-backup.timer"

echo "== (re)start =="
ssh "$HOST" bash -s <<'START'
set -e
echo "PORT=8080" >> /opt/repaircenter/.env.tmp || true
sort -u /opt/repaircenter/.env /opt/repaircenter/.env.tmp 2>/dev/null > /opt/repaircenter/.env.merged || cp /opt/repaircenter/.env /opt/repaircenter/.env.merged
mv /opt/repaircenter/.env.merged /opt/repaircenter/.env
rm -f /opt/repaircenter/.env.tmp
# speech relay venv (idempotent; the unit runs venv/bin/python). pip is the
# real marker: a venv created without ensurepip has python but no pip.
[ -x /opt/repaircenter/tts-relay/venv/bin/pip ] || {
  rm -rf /opt/repaircenter/tts-relay/venv
  python3 -m venv /opt/repaircenter/tts-relay/venv
}
/opt/repaircenter/tts-relay/venv/bin/pip install -q -r /opt/repaircenter/tts-relay/requirements.txt
# offsite backup identity: generated once on the VM, never leaves it. The
# public half must be authorized on the BACKUP_REMOTE host (see backup.sh).
[ -f /opt/repaircenter/.ssh/backup_ed25519 ] || {
  mkdir -p /opt/repaircenter/.ssh
  ssh-keygen -t ed25519 -N '' -C repaircenter-backup -f /opt/repaircenter/.ssh/backup_ed25519 >/dev/null
  echo "new backup key, authorize it on the backup host:"
  cat /opt/repaircenter/.ssh/backup_ed25519.pub
}
chown -R repaircenter:repaircenter /opt/repaircenter
# port 80 needs the capability, not root
setcap 'cap_net_bind_service=+ep' "$(command -v node)"
systemctl daemon-reload
systemctl enable --now repaircenter tts-relay
systemctl enable --now repaircenter-backup.timer
systemctl restart repaircenter tts-relay
sleep 1
systemctl --no-pager --lines=5 status repaircenter tts-relay
START

echo "== done: http://${HOST#*@}/ =="
