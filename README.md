# Family Hub

A private household calendar and task PWA. It runs as one Node.js service with SQLite. Google Calendar events remain in Google and are fetched read-only when a month is opened.

## Local setup

Requirements: Node.js 22+, npm, and build tools supported by `better-sqlite3` if a prebuilt binary is unavailable.

1. Run `cp .env.example .env`.
2. Generate the token key with `openssl rand -base64 32` and put it in `TOKEN_ENCRYPTION_KEY`.
3. Run `npm install`.
4. Create each adult account separately. Run `npm run bootstrap -- --email adult@example.com --name "Adult Name"`, enter a password of at least 12 characters, then repeat for the second adult.
5. Run `npm start`.
6. Open `http://localhost:3000`.

No sample household records are created. Add children, routines, chores, budgets, plans, reminders, and Google accounts after sign-in. Create the first two adults with the local bootstrap command. Adults can add more household members in Settings.

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

The wall display gets a separate opaque device session. It can read the dashboard and calendar, and toggle today's routines and chores. It cannot change groceries, reminders, trips, members, budgets, plans, or account settings. It never receives a personal Google session or Google token.

## Google Cloud setup

1. Open Google Cloud Console and create or select a project.
2. Enable **Google Calendar API**.
3. Configure the OAuth consent screen. Choose **Internal** for Google Workspace, or **External** and add each adult Google account as a test user while the app is in testing.
4. Add only these scopes: `openid`, `email`, and `https://www.googleapis.com/auth/calendar.readonly`.
5. Create an **OAuth client ID** with application type **Web application**.
6. Add `http://localhost:3000/api/google/callback` as an authorized redirect URI for local use.
7. Put the client ID and secret in `.env`. Set `GOOGLE_REDIRECT_URI` to the exact redirect URI.
8. Restart the app. Sign in as an adult, open **Settings**, select **Connect Google account**, and select visible calendars after authorization.

For a deployed domain, add `https://family.example.com/api/google/callback` to the same OAuth client and use that exact value in `GOOGLE_REDIRECT_URI`. Set `APP_ORIGIN=https://family.example.com`. OAuth may require Google verification if used outside an organization or test-user list.

## Docker deployment

1. Create `.env` from `.env.example`. Use the public HTTPS URL for `APP_ORIGIN` and `GOOGLE_REDIRECT_URI`.
2. Run `docker compose up -d --build`.
3. Create adults inside the running service: `docker compose exec family-hub npm run bootstrap -- --email adult@example.com --name "Adult Name"`. Repeat for the second adult.
4. Put an HTTPS reverse proxy in front of `127.0.0.1:3000`. Forward the original `Host` and protocol. Do not expose port 3000 directly to the internet.
5. Back up the Docker volume. SQLite data and encrypted Google tokens are stored there. Back up `TOKEN_ENCRYPTION_KEY` separately. Losing this key requires reconnecting Google accounts.

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

Terminate HTTPS at a reverse proxy such as Caddy on the homelab. Use a private DNS name with a certificate trusted by both phones, or use a secure private-network product that supplies a trusted HTTPS name. Do not forward the app directly to the public internet. Set `APP_ORIGIN` and `GOOGLE_REDIRECT_URI` to the exact HTTPS origin, then add that redirect URI in Google Cloud.

Open the HTTPS URL on each phone and use the browser's **Add to Home Screen** or **Install app** command. PWA installation and service workers require HTTPS except on `localhost`.

## CI and releases

`.github/workflows/ci.yml` runs syntax checks and tests for each push and pull request. A deployment workflow is intentionally not included because the Git remote, target host, registry, and secret store are not yet defined. The production unit is the Docker image built by `Dockerfile`; `compose.yaml` keeps household data in a named volume across image updates.

Preview captures are in `artifacts/wall.png` and `artifacts/phone.png`. They use temporary local reminders and sample household data in a disposable test database, not production records.

## First-version limits

- Google Calendar is read-only. Google remains the source of truth.
- Real Google OAuth cannot be verified until client credentials and an approved redirect URI are configured.
- Grocery spending is manual. There is no bank or retailer integration.
- The app supports one household per deployment.
- CI is configured; automatic deployment waits for a named Git host and deployment target.

## Security notes

- Passwords use Node.js scrypt with per-password salts.
- Session and pairing tokens are stored as SHA-256 digests. Session cookies are HttpOnly, SameSite=Strict, and Secure when `APP_ORIGIN` uses HTTPS.
- State-changing API calls require the configured same origin and a CSRF request header.
- Every household record query is scoped to the authenticated household.
- Google tokens use AES-256-GCM encryption with `TOKEN_ENCRYPTION_KEY`.
- This first version assumes one household per deployment. Do not expose it without HTTPS, backups, and normal host security updates.
