# Portainer deployment and update guide

> **Draft:** The image and Compose file are available. Portainer screen names
> have not been checked against a running Portainer version. Keep issue #4 open
> until that check is done.

## Requirements

- A supported Docker host with Portainer
- `compose.yaml` and an immutable image tag, such as `ghcr.io/3d6564/family-hub:0.1.0`
- Private network access; never expose port 3000 to the internet
- An HTTPS reverse proxy for phones
- `SITE_URL`, `TZ`, `HOUSEHOLD_NAME`, and `SESSION_DAYS`

## Deploy

1. In **Stacks**, add a stack named `family-hub`.
2. Paste or upload `compose.yaml`.
3. Set `FAMILY_HUB_VERSION` to an immutable tag, such as `0.1.0`. Do not use
   `stable` unless you record the installed version before every update.
4. Add environment values in Portainer instead of relying on a local `.env`.
5. Confirm that the named volume mounts at `/data` and the port binding matches
   the private network design.
6. Deploy and confirm container health.
7. Create the adult accounts, configure HTTPS, and pair the wall display.

The named volume contains private household data. Never remove it during a
redeployment. The mutable `stable` tag is convenient but is not a rollback
reference.

## Update

1. Complete the [backup checks](update-and-recovery.md#before-updating).
2. Open the stack and select the new immutable image tag.
3. Confirm that environment values and the `/data` volume are unchanged.
4. Redeploy, confirm health, and open the calendar and Settings.

If using `stable`, tell Portainer to pull the latest image and record the
installed version before redeployment.

## Roll back

Follow the release's rollback classification. For direct rollback, select the
recorded previous immutable tag and redeploy with the same volume. If a backup
restore is required, follow the
[recovery procedure](update-and-recovery.md#roll-back).

## Remaining check

Verify these steps in Portainer and record the tested version:

- Deploy without a source checkout or host `.env` file.
- Preserve test data and settings during image replacement.
- Report container health.
- Perform direct rollback and backup restoration with test data.

Record the tested Portainer version and update any changed screen labels.
