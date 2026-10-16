# Published image deployment

Family Hub runs from the public image `ghcr.io/3d6564/family-hub`. The image
does not contain `.env`, the database, or household data. Use an immutable
version tag. Do not use `stable` for the Pi.

`compose.yaml` is the only deployment stack. It keeps household data in the
named volume mounted at `/data`. Do not run `docker compose down --volumes`.

```sh
export FAMILY_HUB_VERSION=0.1.0
docker compose pull
docker compose up -d
```

The prepared Pi uses `./scripts/deploy-pi.sh`. That command pulls the pinned
image, preserves `.env` and the existing data volume, and replaces the
container.

Set `FAMILY_HUB_PUBLISH=127.0.0.1:3000` when the reverse proxy runs on the same
machine. The default publishes port 3000 on the host for the current private
LAN. Do not expose that port to the internet.

Portainer can import `compose.yaml`. Set `FAMILY_HUB_VERSION` and the other
environment values in the stack UI.

A named volume is the normal data location. A bind mount must be writable by
the container user `hub`.
