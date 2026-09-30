# Family Hub

A private household calendar and task PWA. It runs as one Node.js service with SQLite. Calendar events are fetched read-only from iCal feeds when a month is opened.

## Local setup

Requirements: Node.js 22+, npm, and build tools supported by `better-sqlite3` if a prebuilt binary is unavailable.

1. Run `cp .env.example .env`.
2. Run `npm install`.
3. Create each adult account separately. Run `npm run bootstrap -- --email adult@example.com --name "Adult Name"`, enter a password of at least 12 characters, then repeat for the second adult. For initial local provisioning only, add `--allow-temporary-password` to accept an explicitly temporary password of at least 8 characters, such as `password`. Change it in Settings immediately after sign-in.
4. Run `npm start`.
5. Open `http://localhost:3000`.

No sample household records are created. Add children, routines, chores, plans, reminders, and calendar feeds after sign-in. Create the first two adults with the local bootstrap command. Adults can add more household members in Settings.

Routines are personal habits or school steps, such as brushing teeth or practicing spelling. Each assigned child checks off their own routine for the day. Chores are household jobs, such as setting the table or sorting recycling; they can be assigned to someone or left for anyone. A scheduled chore stays until it is marked done, and that completion is kept for the day. Timed calendar events show their time next to the title. Settings can change the color palette. The header button switches light or dark mode on each display, and the dim schedule forces dark mode during its hours. Each palette works in either mode.

Run checks with:

```sh
npm run check
npm test
```

## Wall display pairing

1. Sign in with an adult account on a personal device.
2. Open **Settings** and select **Create pairing code**.
3. On the wall display, select **Pair display** and enter the code within 10 minutes.
4. Revoke a display from **Settings** at any time.

Deployment automation can create a 10-minute code for the deployment's household with `npm run pairing-code`. The command prints only the code. In Docker, run `docker compose exec family-hub npm run --silent pairing-code` to suppress npm's command banner.

The wall display gets a separate opaque device session. It can read the dashboard and calendar, and toggle today's routines and chores. It cannot change reminders, members, plans, calendar feeds, task order, or account settings. It never receives calendar feed URLs.

## Calendar feeds

Adults add read-only iCal feeds in **Settings** with a calendar name, iCal URL, and color. For Google Calendar, open the calendar's **Settings and sharing** page, then copy either **Public address in iCal format** for a public calendar or **Secret address in iCal format** for a private calendar. To revoke a secret address, reset it in Google Calendar and delete or replace the feed in Family Hub.

Treat an iCal URL as a bearer secret: anyone with the URL can read that calendar. The URL is hidden after save, but is stored as plain text in SQLite. Keep the database and backups private. Feed events are fetched when requested and are not copied into the local database.

## Docker deployment

1. Create `.env` from `.env.example`. Use the public HTTPS URL for `APP_ORIGIN`.
   Set `ALLOWED_ORIGINS` to the comma-separated browser origins allowed to submit changes. Include each temporary LAN URL used before HTTPS is configured.
2. Run `docker compose up -d --build`.
3. Create adults inside the running service: `docker compose exec family-hub npm run bootstrap -- --email adult@example.com --name "Adult Name"`. Repeat for the second adult.
4. Port 3000 listens on the host network for private-LAN administration. Put an HTTPS reverse proxy in front of it for phone PWA installation or access across networks. Do not forward port 3000 directly to the internet.
5. Back up the Docker volume. SQLite data and calendar feed URLs are stored there. Keep the database and backups private.

The service applies numbered migrations at startup. Stop the service or use SQLite's online backup API when making a manual database backup.

## Raspberry Pi kiosk

Use 64-bit Raspberry Pi OS Desktop on a Pi 4B or Pi 5. Install Docker Engine and the Compose plugin, clone this repository, create `.env`, and start the service with `docker compose up -d --build`. Do not use the older 32-bit DAKOS installation for this deployment.

For the prepared `family-hub` Pi, provision and deploy repeatedly from this repository:

```sh
./scripts/provision-pi.sh
./scripts/deploy-pi.sh
```

`provision-pi.sh` installs Debian's Docker and Compose packages. `deploy-pi.sh` synchronizes tracked application files to `/opt/family-hub`, preserves the remote `.env` and Docker data volume, rebuilds the image, applies migrations at startup, and replaces the running container. Run the deploy command after pulling or checking out any revision. The script accepts another SSH destination as its first argument.

After pairing the wall display, add Chromium kiosk startup to the desktop user's autostart configuration:

```sh
./scripts/configure-kiosk.sh http://localhost:3000/
```

The script adds an idempotent Labwc autostart entry. Re-running it does not add duplicate Chromium commands. Use the local URL while the reverse proxy is not configured; change it to the final HTTPS URL later.

The display connects through micro-HDMI on the Pi to HDMI on the monitor. Touch requires a separate USB upstream/data cable from the monitor to a Pi USB port; an HDMI cable does not carry touch input. The monitor also needs its specified power supply. Before buying a monitor, confirm that its touch controller supports standard Linux USB HID, that its VESA pattern and weight fit the mount, and that both the required video and USB upstream ports remain accessible after mounting. Exact support, cable types, power, and mount compatibility cannot be confirmed without the monitor model and manual.

Raspberry Pi OS does not guarantee an on-screen keyboard in Chromium kiosk mode. Prefer a dashboard that does not require typing on the wall. If wall text entry is required, install and test an on-screen keyboard such as `wvkbd` or `onboard` with the selected desktop session before mounting the display.

## HTTPS and phone installation

Terminate HTTPS at a reverse proxy such as Caddy on the homelab. Use a private DNS name with a certificate trusted by both phones, or use a secure private-network product that supplies a trusted HTTPS name. Do not forward the app directly to the public internet. Set `APP_ORIGIN` to the exact HTTPS origin.

Open the HTTPS URL on each phone and use the browser's **Add to Home Screen** or **Install app** command. PWA installation and service workers require HTTPS except on `localhost`.

## CI and releases

`.github/workflows/ci.yml` runs syntax checks and tests for each push and pull request. A deployment workflow is intentionally not included because the Git remote, target host, registry, and secret store are not yet defined. The production unit is the Docker image built by `Dockerfile`; `compose.yaml` keeps household data in a named volume across image updates.

Preview captures are in `artifacts/wall.png` and `artifacts/phone.png`. They use temporary local reminders and sample household data in a disposable test database, not production records.

## First-version limits

- Calendar feeds are read-only. The calendar provider remains the source of truth.
- The app supports one household per deployment.
- CI is configured; automatic deployment waits for a named Git host and deployment target.

## Security notes

- Passwords use Node.js scrypt with per-password salts.
- Session and pairing tokens are stored as SHA-256 digests. Session cookies are HttpOnly, SameSite=Strict, and Secure when `APP_ORIGIN` uses HTTPS.
- State-changing API calls require the configured same origin and a CSRF request header.
- Every household record query is scoped to the authenticated household.
- Calendar feed URLs are bearer secrets stored in SQLite. Normal APIs and the frontend never return them after save.
- This first version assumes one household per deployment. Do not expose it without HTTPS, backups, and normal host security updates.
