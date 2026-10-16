# Portainer deployment and update guide

> **Draft:** Issues #5 and #7 must provide tested images and a portable Compose
> stack before this guide can be used. Keep issue #4 open until then.

## Requirements

- A supported Docker host with Portainer
- The release Compose file and an immutable image tag
- Private network access; never expose port 3000 to the internet
- An HTTPS reverse proxy for phones
- `SITE_URL`, `TZ`, `HOUSEHOLD_NAME`, and `SESSION_DAYS`

## Deploy

1. In **Stacks**, add a stack named `family-hub`.
2. Paste or upload `compose.yaml`.
3. Select an immutable tag, such as
   `ghcr.io/3d6564/family-hub:0.2.0`.
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

## Before publication

After issues #5 and #7 are complete, verify that Portainer can:

- Deploy without a source checkout or host `.env` file.
- Preserve test data and settings during image replacement.
- Report container health.
- Perform direct rollback and backup restoration with test data.

Record the tested Portainer version and update any changed screen labels.
