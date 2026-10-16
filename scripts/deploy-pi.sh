#!/usr/bin/env bash
set -euo pipefail

host=${1:-familyhub@family-hub.local}
target=${FAMILY_HUB_TARGET:-/opt/family-hub}
version=${FAMILY_HUB_VERSION:-0.1.0}
root=$(cd "$(dirname "$0")/.." && pwd)

[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]

ssh "$host" "install -d '$target'"

if [[ ${FAMILY_HUB_SOURCE_BUILD:-} == 1 ]]; then
  rsync --archive --delete \
    --exclude '.env' \
    --exclude '.git/' \
    --exclude 'artifacts/' \
    --exclude 'data/' \
    --exclude 'node_modules/' \
    --exclude 'family-hub-reference.png' \
    "$root/" "$host:$target/"
  ssh "$host" "cd '$target' && if [ ! -f .env ]; then umask 077; printf '%s\n' 'PORT=3000' 'APP_ORIGIN=http://localhost:3000' 'ALLOWED_ORIGINS=http://localhost:3000,http://family-hub.local:3000' 'DATABASE_PATH=/data/family-hub.sqlite' 'HOUSEHOLD_NAME=Our Home' 'SESSION_DAYS=30' >.env; fi && if docker compose version >/dev/null 2>&1; then docker compose up -d --build --remove-orphans; else docker-compose up -d --build --remove-orphans; fi"
  printf 'Family Hub source build deployed to %s:%s.\n' "$host" "$target"
  exit 0
fi

scp "$root/compose.pi.yaml" "$host:$target/compose.pi.yaml"
ssh "$host" "cd '$target' && if [ ! -f .env ]; then umask 077; printf '%s\n' 'PORT=3000' 'APP_ORIGIN=http://localhost:3000' 'ALLOWED_ORIGINS=http://localhost:3000,http://family-hub.local:3000' 'DATABASE_PATH=/data/family-hub.sqlite' 'HOUSEHOLD_NAME=Our Home' 'SESSION_DAYS=30' >.env; fi && docker pull 'ghcr.io/3d6564/family-hub:$version' && FAMILY_HUB_VERSION='$version' docker compose -f compose.pi.yaml up -d --remove-orphans && cp compose.pi.yaml compose.yaml && rm -f compose.image.yaml && container=\$(docker compose -f compose.pi.yaml ps -q family-hub) && status= && for attempt in 1 2 3 4 5 6 7 8 9 10; do status=\$(docker inspect --format '{{.State.Health.Status}}' \"\$container\"); if [ \"\$status\" = healthy ]; then break; fi; sleep 3; done && test \"\$status\" = healthy && test \"\$(curl --fail --silent http://127.0.0.1:3000/health/ready)\" = ready"

printf 'Family Hub %s deployed to %s:%s.\n' "$version" "$host" "$target"
