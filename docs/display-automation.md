# Display automation

The standalone `scripts/install-display.sh` owns the browser wrapper and user
service. It works without Ansible. Host tools can call the same installer; do
not maintain a second copy of its browser flags or service definition.

The display script uses Linux, Bash, Chromium, and a user systemd manager. It
does not install Node.js or the Family Hub server. Live validation currently
covers Debian 13 ARM64 with Labwc. Other desktop environments need their own
login/startup verification.

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
that older block. The current `family-hub-display.service` main process and
process group are excluded, including when Chromium moves its main process to
a separate desktop scope. Cleanup
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

## Installer command contract

The installer runs locally on the display account. A person, Ansible, another
host tool, or a future device-install feature can deliver and call the same
script. The caller owns remote access and job delivery. The installer owns
inspection, supported migration, display configuration, and service checks.
It does not need access to the Family Hub database.

```sh
# Inspect and preview without changing the display.
bash scripts/install-display.sh --check --json https://hub.example/

# Apply the reviewed configuration and return a structured result.
bash scripts/install-display.sh --json https://hub.example/

# Keep the saved URL on later runs.
bash scripts/install-display.sh --check --json
```

`--check` reads the current configuration and service state, generates a plan in
a temporary directory, and removes that directory on exit. It does not create
display configuration directories, write the version record, install packages,
stop processes, reload units, enable services, or start/restart the browser.
It still requires access to the display user's service manager. When Chromium
is missing, the plan reports that browser installation is required; the exact
generated browser path can depend on the installed package.

An apply run uses `sudo -n` and noninteractive package installation if Chromium
is missing. It does not request a password. A caller without the required sudo
access must install Chromium first. With Chromium prepared, complete inputs,
and the correct graphical account environment, the installer needs no prompts.

### Prior-install detection

Every run checks existing installer-owned files and marked startup entries.
The record at `$XDG_CONFIG_HOME/family-hub/install-version` (normally
`~/.config/family-hub/install-version`) currently contains `1`. This is the
display configuration format version, independent of the Family Hub app's
release version.

Supported prior installs are the earlier unversioned browser-wrapper/service
setup and the older marked Labwc Chromium command. The installer also repairs
recognized partial installs. An unsupported version, unrecognized service or
wrapper, unknown marked startup block, or unmanaged startup command using the
kiosk profile stops the run before kiosk changes. Custom services outside these
known files still require the explicit handoff described above.

Adopting an otherwise unchanged unversioned install writes the version record
without reloading units or restarting a healthy browser. Known older startup
blocks and matching legacy processes are checked on every run, including after
the version record exists. Process identity is checked again before signaling
any process found during planning.

### Results and exit codes

Without `--json`, human-readable output retains the existing
`Family Hub display changed: true|false` line on successful apply. A preview
instead reports `Family Hub display would change: true|false`.

With `--json`, stdout contains one JSON result. Command messages and errors go
to stderr. The result does not include the URL, browser profile contents,
pairing information, or credentials.

| Field | Meaning |
| --- | --- |
| `status`, `phase` | `ok` or `error`, and the last stage reached |
| `mode` | `check` or `apply` |
| `changed` | Whether this run made changes; always false in check mode |
| `would_change` | Whether the initial plan requires changes |
| `installed_version`, `target_version` | Detected version (`none`, `unversioned`, or `1`) and target format version; successful apply reports installed version `1` |
| `migration_required` | Whether a recognized older install needs adoption or cleanup |
| `browser_install_required` | Whether Chromium was missing during inspection |
| `configuration_change_required` | Whether generated display files need changes, excluding version-only adoption |
| `service_action` | Planned `none`, `start`, or `restart` |
| `service_active`, `service_enabled` | Inspected state in check mode; verified state after successful apply |
| `legacy_processes` | Number of matching legacy processes found in the plan |

Exit `0` means a successful preview or apply, even when the preview finds
changes. Exit `1` means inspection, migration, application, or verification
failed. Exit `2` means invalid arguments or a missing/invalid URL. A failed apply
can report `changed: true` when earlier steps changed the device; callers must
retain that distinction. `--help` prints usage and exits successfully.

A successful service check does not establish that the page rendered or that
pairing is valid. Confirm the physical display and test login/reboot startup as
separate acceptance checks.
