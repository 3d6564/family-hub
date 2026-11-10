#!/usr/bin/env bash
set -euo pipefail

# Mount source only: household databases, backups, and .env stay outside the container.
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
runtime=${CONTAINER_RUNTIME:-podman}
image=docker.io/library/node:22-bookworm
args=(run --rm --security-opt label=disable --workdir /workspace
  --env HOME=/tmp --env npm_config_cache=/npm-cache
  --volume family-hub-dev-modules:/workspace/node_modules
  --volume family-hub-dev-npm-cache:/npm-cache)
if [[ ${FAMILY_HUB_DEV_BROWSER:-0} == 1 ]]; then
  image=localhost/family-hub-dev-browser:node22
  args+=(--env FAMILY_HUB_TEST_BROWSER=/usr/bin/chromium)
fi
for entry in src public test migrations scripts docs package.json package-lock.json; do
  args+=(--volume "$root/$entry:/workspace/$entry")
done
if [[ ${1:-} != install && ${1:-} != ci && ${1:-} != audit && ${1:-} != view ]]; then
  args+=(--network none)
fi
exec "$runtime" "${args[@]}" "$image" npm "$@"
