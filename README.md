# Family Hub

A private household calendar and task app for one home. It runs as one service with a local database.

## Run it

Use the published image and `compose.yaml`. You choose the host tool. Family Hub does not install or update the host for you.

1. Copy `.env.example` to `.env`.
2. Set `SITE_URL` to the address you type in the browser, such as `http://hub.home.example:3000`. Do not add a trailing slash.
3. Set `FAMILY_HUB_VERSION` to an immutable image tag.
4. Run `docker compose pull` and `docker compose up -d`.
5. Open that same address. Restore a backup or create the first adult.

Keep port 3000 on your private network. Use HTTPS before phones install the app or you use it across networks. Do not forward port 3000 to the internet.

Backups are downloaded from **Settings**, then **Access**. A backup is the whole household. Keep it private.

See the [published image guide](docs/published-image.md) and the [update and recovery guide](docs/update-and-recovery.md).

## Add a display

The display computer only runs Chromium. It does not run the application.

On the signed-in graphical account, run:

```sh
curl -fsSL https://raw.githubusercontent.com/3d6564/family-hub/main/scripts/install-display.sh | bash -s -- http://hub.home.example:3000/
```

Use the same address as `SITE_URL`. To read the script first, save it, then run `./install-display.sh` with that address.

The screen shows a code. On your phone, open **Settings**, then **Screens**, and enter the code. The screen does not need a keyboard. Run the installer again to update it. Leave the address off to keep the current one.

## Develop locally

Requirements: Node.js 22 and npm.

```sh
cp .env.example .env
npm install
npm start
```

Open `http://localhost:3000`. Run `npm run check` and `npm test` before a change is merged.

## Limits

- One household per deployment.
- Calendar feeds are read-only.
- The host owner deploys the image. Family Hub does not deploy a host.
