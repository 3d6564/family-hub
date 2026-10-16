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

Routines are personal habits or school steps, such as brushing teeth or practicing spelling. Each assigned child checks off their own routine for the day. Routine periods can be expanded or collapsed; the current period opens by default. When a period ends, finished items leave that list. Unfinished items from earlier in the day stay open. Chores are household jobs, such as setting the table or sorting recycling; they can be assigned to someone or left for anyone. Each chore can have a reward value in $0.25 increments, shown beside its name. Assigned chore rewards are added to that child's token ledger when the chore is checked off. The Tokens screen works like an ATM: copper is $0.25, silver is $0.50, and gold is $1.00. Total earned stays on the leaderboard. Available is the amount that has not been withdrawn. A withdrawn reward cannot be unchecked. Chores assigned to anyone are not added to a token balance. Routine, chore, and reminder edits use an in-app dialog. A scheduled chore stays until it is marked done, and that completion is kept for the day. Timed calendar events show their time next to the title. Event details close when you tap outside the window. Crowded days use tighter spacing and a slightly smaller type size so every event stays in the cell. The current day uses the palette accent as a cell tint and outline, so it stays visible when that cell is full. A multi-day event appears on each day it covers, with a mark showing that it continues. A day with only a few events keeps those events compact. Calendar feeds can be reordered in Settings; events are grouped by feed order and remain chronological within each feed. During the live month's final week, the calendar starts at the current week and shows five weeks ahead. The household title in the header can be customized. The header shows the weekday, month, date, and year, plus the time on wider screens. Settings can change the color palette. The header button switches light or dark mode on each display, and the dim schedule forces dark mode during its hours. Each palette works in either mode.

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

Each paired display reports its resolution, browser viewport, scale factor, and last-seen time. Adults can review these details and a scaled calendar preview in **Settings > Screens**.

Deployment automation can create a 10-minute code for the deployment's household with `npm run pairing-code`. The command prints only the code. In Docker, run `docker compose exec family-hub npm run --silent pairing-code` to suppress npm's command banner.

The wall display gets a separate opaque device session. It can read the dashboard and calendar, and toggle today's routines and chores. It cannot change reminders, members, plans, calendar feeds, task order, or account settings. It never receives calendar feed URLs or the weather API key. Signed-in adults add a local reminder from the plus button on the calendar. A local reminder stays in Family Hub and is not added to an outside calendar. On the wall calendar, the header and outer padding are shorter, and a forecast can sit above routines and chores.

## Calendar feeds

Adults add read-only iCal feeds in **Settings** with a calendar name, iCal URL, and color. For Google Calendar, open the calendar's **Settings and sharing** page, then copy either **Public address in iCal format** for a public calendar or **Secret address in iCal format** for a private calendar. To revoke a secret address, reset it in Google Calendar and delete or replace the feed in Family Hub.

Treat an iCal URL as a bearer secret: anyone with the URL can read that calendar. The URL is hidden after save, but is stored as plain text in SQLite. Keep the database and backups private. Feed events are fetched when requested and are not copied into the local database.

Weather settings store a location, Fahrenheit or Celsius, 1 to 7 forecast days, and display choices for precipitation, wind, humidity, current temperature, and feels-like temperature. The providers are OpenWeatherMap, Open-Meteo, WeatherAPI.com, and Pirate Weather. Each provider keeps its own API key, so switching providers does not require entering the other key again. Signed-in adults can view and edit those keys in Settings. The wall display never receives a key. Open-Meteo works without a key. A saved Open-Meteo key uses its customer API. OpenWeatherMap can show up to 5 days. The other providers can show up to 7 days.

## Docker deployment

1. Create `.env` from `.env.example`. Set `SITE_URL` to the browser address, such as `https://hub.home.example`.
2. Set `FAMILY_HUB_VERSION` to an immutable image tag, then run `docker compose pull` and `docker compose up -d`.
3. Create adults inside the running service: `docker compose exec family-hub npm run bootstrap -- --email adult@example.com --name "Adult Name"`. Repeat for the second adult.
4. Port 3000 listens on the host network for private-LAN administration. Put an HTTPS reverse proxy in front of it for phone PWA installation or access across networks. Do not forward port 3000 directly to the internet.
5. Back up the Docker volume. SQLite data and calendar feed URLs are stored there. Keep the database and backups private.

The service applies numbered migrations at startup. Adults can download a backup from Settings, under Access. That file is the whole household. Keep it private. Restore from that same screen replaces the current database and restarts the service. A restored copy on another machine also needs `SITE_URL` set to the new browser address. Sign in again after a restore. Stop the service or use SQLite's online backup API when copying the database file by hand.

Before an update, read the [update and recovery guide](docs/update-and-recovery.md) and [release policy](docs/release-policy.md).

## Raspberry Pi kiosk

Use 64-bit Raspberry Pi OS Desktop on a Pi 4B or Pi 5. Install Docker Engine and the Compose plugin. Do not use the older 32-bit DAKOS installation for this deployment.

For the prepared `family-hub` Pi, provision and deploy repeatedly from this repository:

```sh
./scripts/provision-pi.sh
./scripts/deploy-pi.sh
```

`provision-pi.sh` installs Debian's Docker and Compose packages. `deploy-pi.sh` pulls pinned image `ghcr.io/3d6564/family-hub:0.1.0`, preserves the remote `.env` and Docker data volume, and replaces the container. Set `FAMILY_HUB_VERSION` to deploy another immutable tag. The script accepts another SSH destination as its first argument.

The wall display opens the same browser address as `SITE_URL`. After HTTPS is enabled, run:

```sh
SITE_URL=https://hub.home.example ./scripts/configure-kiosk.sh
```

Use `http://localhost:3000/` only while `SITE_URL` is still HTTP. Do not leave Chromium on that HTTP address after phones use HTTPS. A Secure paired-display cookie is not sent to a different HTTP address.

The script adds an idempotent Labwc autostart entry. Re-running it does not add duplicate Chromium commands.

The display connects through micro-HDMI on the Pi to HDMI on the monitor. Touch requires a separate USB upstream/data cable from the monitor to a Pi USB port; an HDMI cable does not carry touch input. The monitor also needs its specified power supply. Before buying a monitor, confirm that its touch controller supports standard Linux USB HID, that its VESA pattern and weight fit the mount, and that both the required video and USB upstream ports remain accessible after mounting. Exact support, cable types, power, and mount compatibility cannot be confirmed without the monitor model and manual.

Raspberry Pi OS does not guarantee an on-screen keyboard in Chromium kiosk mode. Prefer a dashboard that does not require typing on the wall. If wall text entry is required, install and test an on-screen keyboard such as `wvkbd` or `onboard` with the selected desktop session before mounting the display.

## HTTPS and phone installation

Terminate HTTPS at a reverse proxy such as nginx or Caddy. Use a private name with a certificate trusted by the phones and the wall display. Do not forward port 3000 to the internet. Set `SITE_URL` to the browser address, such as `https://hub.home.example`, then point the kiosk at that same address.

Open the HTTPS URL on each phone and use the browser's **Add to Home Screen** or **Install app** command. PWA installation and service workers require HTTPS except on `localhost`.

## CI and releases

`.github/workflows/ci.yml` runs syntax checks and tests for each push and pull request. `.github/workflows/release.yml` publishes the public multi-architecture image when a version tag is pushed. It does not deploy a host. The [published image guide](docs/published-image.md) describes deployment. The [Portainer guide](docs/portainer.md) remains a draft until that setup is tested.

Preview captures are in `artifacts/wall.png` and `artifacts/phone.png`. They use temporary local reminders and sample household data in a disposable test database, not production records.

## First-version limits

- Calendar feeds are read-only. The calendar provider remains the source of truth.
- The app supports one household per deployment.
- CI is configured; automatic deployment waits for a named Git host and deployment target.

## Security notes

- Passwords use Node.js scrypt with per-password salts.
- Session and pairing tokens are stored as SHA-256 digests. Session cookies are HttpOnly, SameSite=Strict, and Secure when `SITE_URL` uses HTTPS.
- Update checks are off by default. Set `FAMILY_HUB_UPDATE_CHECK=1` to let adults see a newer GitHub release. The server checks GitHub, browsers do not, and Family Hub never installs the update. A check reveals the server address and check time to GitHub. The repository is private, so the check also needs `FAMILY_HUB_UPDATE_TOKEN` with release read access. That token is not shown in Settings.
- State-changing API calls require the configured same origin and a CSRF request header.
- Every household record query is scoped to the authenticated household.
- Calendar feed URLs are bearer secrets stored in SQLite. Normal APIs and the frontend never return them after save.
- This first version assumes one household per deployment. Do not expose it without HTTPS, backups, and normal host security updates.
