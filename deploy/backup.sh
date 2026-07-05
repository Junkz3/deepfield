#!/usr/bin/env bash
# Snapshot the account data (users, sessions, per-user stores) to a local
# tarball, then push the backlog to an offsite host over SSH. Runs hourly
# via repaircenter-backup.timer as the repaircenter user.
# Rotation: newest 24 kept locally (one day), newest 72 offsite (three days).
# Offsite target comes from /opt/repaircenter/.env:
#   BACKUP_REMOTE=user@host   BACKUP_SSH_PORT=22
# Without BACKUP_REMOTE the local rotation still runs.
set -euo pipefail

APP=/opt/repaircenter
KEY="$APP/.ssh/backup_ed25519"

env_val() { grep -m1 "^$1=" "$APP/.env" 2>/dev/null | cut -d= -f2- || true; }
REMOTE="$(env_val BACKUP_REMOTE)"
PORT="$(env_val BACKUP_SSH_PORT)"
PORT="${PORT:-22}"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$APP/backups"
tar -czf "$APP/backups/data-$STAMP.tar.gz" -C "$APP" data
ls -1t "$APP/backups"/data-*.tar.gz | tail -n +25 | xargs -r rm -f

if [ -n "$REMOTE" ] && [ -f "$KEY" ]; then
  SSH="ssh -i $KEY -p $PORT -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"
  rsync -az -e "$SSH" "$APP/backups/" "$REMOTE:backups/"
  $SSH "$REMOTE" 'ls -1t backups/data-*.tar.gz 2>/dev/null | tail -n +73 | xargs -r rm -f'
fi
