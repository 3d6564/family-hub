# Update and recovery guide

Family Hub never installs updates automatically.

## Before updating

1. Download a backup from **Settings > Access**.
2. Store it privately outside the Docker host.
3. Record the current image version or Git commit.
4. Read the target release's setup, migration, and rollback notes.
5. Confirm the environment settings and data volume.

The Settings backup is a consistent SQLite copy and contains the full
household, including calendar feed URLs. Do not copy the live database file:
write-ahead logging can leave committed data in a separate WAL file. Stop the
container first if a file copy is required.

## Update

Published-image deployment uses `compose.published.yaml`. It is not the current Pi path. When that image is available:

```sh
export FAMILY_HUB_VERSION=0.2.0
docker compose -f compose.published.yaml pull
docker compose -f compose.published.yaml up -d
```

For the current source build, select the intended Git revision and run:

```sh
docker compose up -d --build --remove-orphans
```

On the prepared Pi, `scripts/deploy-pi.sh` pulls the pinned image and replaces
the container while preserving `.env` and the data volume. For Portainer, follow
[`portainer.md`](portainer.md).

With any container manager, replace only the application container. Keep the
existing environment settings and mount the existing volume at `/data`. Never
run `docker compose down --volumes` during an update.

After replacement, run `docker compose ps`. The container starts as `starting`
and becomes `healthy` after the server and database respond. If it becomes
`unhealthy`, inspect the container logs without sharing sensitive data. A
health failure does not restart the container; the restart policy applies when
the server exits. After it is healthy, open the calendar and Settings.

## Roll back

Follow the classification in the release notes.

For **Direct rollback supported**, select the recorded previous immutable tag
and replace the container without changing the volume. Do not use `stable` as a
rollback reference.

For **Backup restore required**:

1. Stop attempts to run the previous image against the migrated database.
2. Run an image that can open the migrated database.
3. Restore the pre-update backup from **Settings > Access**.
4. After Family Hub restarts, deploy the previous immutable image.
5. Confirm health, the calendar, and Settings.

Restoration removes changes made after the backup. If Settings is unavailable,
stop the service and restore at the host level without overwriting the only
database copy.

If an update fails, preserve `.env` and the volume, check the container logs for
non-sensitive errors, and follow the release's rollback classification.
