#!/usr/bin/env bash
set -euo pipefail

host=${1:-familyhub@family-hub.local}
target=${FAMILY_HUB_TARGET:-/opt/family-hub}
version=${FAMILY_HUB_VERSION:-0.1.0}
root=$(cd "$(dirname "$0")/.." && pwd)

[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]

ssh "$host" "install -d '$target'"
scp "$root/compose.yaml" "$host:$target/compose.yaml"
ssh "$host" "cd '$target' && if [ ! -f .env ]; then umask 077; printf '%s\n' 'PORT=3000' 'APP_ORIGIN=http://localhost:3000' 'ALLOWED_ORIGINS=http://localhost:3000,http://family-hub.local:3000' 'DATABASE_PATH=/data/family-hub.sqlite' 'HOUSEHOLD_NAME=Our Home' 'SESSION_DAYS=30' >.env; fi && docker pull 'ghcr.io/3d6564/family-hub:$version' && FAMILY_HUB_VERSION='$version' docker compose up -d --remove-orphans && rm -f compose.pi.yaml compose.image.yaml compose.published.yaml && container=\$(docker compose ps -q family-hub) && status= && for attempt in 1 2 3 4 5 6 7 8 9 10; do status=\$(docker inspect --format '{{.State.Health.Status}}' \"\$container\"); if [ \"\$status\" = healthy ]; then break; fi; sleep 3; done && test \"\$status\" = healthy && test \"\$(curl --fail --silent http://127.0.0.1:3000/health/ready)\" = ready"

printf 'Family Hub %s deployed to %s:%s.\n' "$version" "$host" "$target"
