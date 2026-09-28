#!/usr/bin/env bash
set -euo pipefail

host=${1:-familyhub@family-hub.local}
target=${FAMILY_HUB_TARGET:-/opt/family-hub}

ssh "$host" "install -d '$target'"
rsync --archive --delete \
  --exclude '.env' \
  --exclude '.git/' \
  --exclude 'artifacts/' \
  --exclude 'data/' \
  --exclude 'node_modules/' \
  --exclude 'family-hub-reference.png' \
  ./ "$host:$target/"

ssh "$host" "cd '$target' && if [ ! -f .env ]; then umask 077; key=\$(openssl rand -base64 32); printf '%s\n' 'PORT=3000' 'APP_ORIGIN=http://localhost:3000' 'ALLOWED_ORIGINS=http://localhost:3000,http://family-hub.local:3000' 'DATABASE_PATH=/data/family-hub.sqlite' 'HOUSEHOLD_NAME=Our Home' 'SESSION_DAYS=30' \"TOKEN_ENCRYPTION_KEY=\$key\" 'GOOGLE_CLIENT_ID=' 'GOOGLE_CLIENT_SECRET=' 'GOOGLE_REDIRECT_URI=http://localhost:3000/api/google/callback' >.env; fi && if docker compose version >/dev/null 2>&1; then docker compose up -d --build --remove-orphans; else docker-compose up -d --build --remove-orphans; fi"

printf 'Family Hub deployed to %s:%s.\n' "$host" "$target"
