# Published image deployment

This path is separate from the current source-build deployment. Do not replace
`compose.yaml` or run it on the current Pi until an ARM64 image has been tested.

The image registry is private. A Docker host must log in to `ghcr.io` before it
can pull an image. Images do not contain `.env`, the database, or household data.

## Compose

Set an immutable version, then start the separate stack:

```sh
export FAMILY_HUB_VERSION=0.2.0
docker compose -f compose.published.yaml up -d
```

The stack name is `family-hub-published`. It does not use the current Pi's
source-build volume. Its named volume stays mounted at `/data` when the image
is replaced. Do not run `docker compose down --volumes`.

Portainer can import `compose.published.yaml`. Set `FAMILY_HUB_VERSION` and the
other environment values in the stack UI. Do not rely on a host-local `.env`
file.

## Network

The default binding is `127.0.0.1:3000`. Use it when the HTTPS reverse proxy
runs on the same machine.

For a reverse proxy on another private-network machine, set
`FAMILY_HUB_PUBLISH` to the host's private address and port, such as
`192.168.1.20:3000`. Do not expose port 3000 to the internet.

## Bind mounts

A named volume is the normal data location. A bind mount must be writable by
the container user `hub`. A directory owned only by the host user can prevent
startup. Do not point a bind mount at a live database without a backup.

## Update

Record the current immutable tag, back up the database, change
`FAMILY_HUB_VERSION`, and run:

```sh
docker compose -f compose.published.yaml pull
docker compose -f compose.published.yaml up -d
```

Use the recorded tag for rollback. Do not use `stable` as the Pi's normal tag.
