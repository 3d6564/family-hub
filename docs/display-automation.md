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

## Desktop startup

The service is enabled under `graphical-session.target` for desktops that
activate that target. Labwc can run without activating it. When Labwc is
installed, identified by the session environment, or already has a user
configuration directory, the installer also manages a marked block in
`~/.config/labwc/autostart` (under `XDG_CONFIG_HOME` when set).

The block imports the available graphical display variables into the user
service manager, then starts `family-hub-display.service`. It contains no second
browser command. Existing commands outside the marked block and the file's
permissions are retained. When creating a user autostart file, the installer
keeps the system's existing Labwc autostart running as well.

Test a fresh desktop login or reboot after installation. An active service
alone does not prove that the physical screen loaded the application.

## Migration from older kiosk installs

The installer replaces only blocks between `# Family Hub kiosk` and
`# End Family Hub kiosk`. Incomplete markers stop installation so unrelated
startup commands are not removed.

When an older block directly launches Chromium, cleanup sends a termination
signal only to matching processes owned by the current account. A process must
have a Chromium browser name, `--kiosk`, the exact
`--user-data-dir=$HOME/.config/family-hub-kiosk` argument, and the URL saved in
that older block. The current `family-hub-display.service` is excluded. Cleanup
waits up to ten seconds for a matching process to exit and stops installation
if it does not exit. It does not force-kill browsers or remove profile files.

Unrelated Chromium windows, other profiles, and browser processes without a
known older startup block are left alone. Custom services and temporary services
such as Labgeek's `family-hub-kiosk.service` need an explicit host-specific
handoff before running the installer. Confirm their launch command and profile,
then stop the old service before starting the replacement. A service name alone
does not establish that it belongs to this installer.

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
