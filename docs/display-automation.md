# Display automation

The standalone `scripts/install-display.sh` owns the browser wrapper and user
service. It works without Ansible. Host tools can call the same installer; do
not maintain a second copy of its browser flags or service definition.

## Run from a host tool

1. Select a reviewed Family Hub commit and copy its installer to the host.
   Record the commit and the installer's SHA-256 checksum. Avoid downloading
   `main` during each automated run.
2. Install Chromium with the host's package tool.
3. Sign in to the display's graphical desktop. Run the installer as that
   graphical account, with its `HOME` and `XDG_CONFIG_HOME`. From a remote tool,
   also set `XDG_RUNTIME_DIR=/run/user/<uid>` and
   `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus` for that account.
4. Pass the display URL as one argument. It must match the application's
   `SITE_URL`. Omit it only when preserving a saved URL.
5. Verify `systemctl --user is-active family-hub-display.service`, then check
   that the screen loads the application.

The installer requires the existing graphical session and user systemd manager.
It does not configure desktop autologin or enable lingering. A running user
manager alone does not prove that a graphical session is available.

## Repeat runs and recovery

- An unchanged, enabled, active display is not restarted.
- Changes to generated configuration restart an existing display service.
- An inactive service is started, even when its configuration is unchanged.
- A disabled service is enabled again.
- The Chromium profile at `~/.config/family-hub-kiosk` is retained, including
  display pairing. The installer does not read or export that profile.
- Successful runs end with `Family Hub display changed: true` or
  `Family Hub display changed: false`. Host tools can use this line to report
  change status. A failed command returns a nonzero exit status.

The Labgeek repository provides an optional playbook for its own inventory and
accounts. Other users can run this installer manually or through their own host
tools. Application container deployment is separate from display configuration.
