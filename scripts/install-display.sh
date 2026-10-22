#!/usr/bin/env bash
set -euo pipefail

config_home=${XDG_CONFIG_HOME:-$HOME/.config}
install -d "$config_home/family-hub" "$config_home/systemd/user"
wrapper=$config_home/family-hub/display.sh
url_file=$config_home/family-hub/url
unit=$config_home/systemd/user/family-hub-display.service
autostart=$config_home/labwc/autostart
marker='# Family Hub kiosk'
end_marker='# End Family Hub kiosk'
existing=false
[[ -f $unit || -f $wrapper || -f $url_file ]] && existing=true
changed=false
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT

# Compare generated files so an automation run does not interrupt the display.
install_changed() {
  local source=$1 destination=$2 mode=$3
  if ! cmp -s "$source" "$destination"; then
    install -m "$mode" "$source" "$destination"
    changed=true
  elif [[ $(stat -c '%a' "$destination") != "$mode" ]]; then
    chmod "$mode" "$destination"
    changed=true
  fi
}

saved_url=
legacy_url=
if [[ -f $autostart ]] && grep -Fq "$marker" "$autostart"; then
  legacy_url=$(sed -n "/^$marker\$/,/^$end_marker\$/p" "$autostart" | grep -oE 'https?://[^[:space:]'\''")]+' | head -n 1 || true)
fi
if [[ -f $url_file ]]; then
  saved_url=$(head -n 1 "$url_file")
elif [[ -f $autostart ]] && grep -Fq "$marker" "$autostart"; then
  existing=true
  saved_url=$legacy_url
fi

url=${1:-${SITE_URL:-$saved_url}}
if [[ -z $url ]]; then
  printf 'Usage: install-display.sh https://hub.example/\n' >&2
  exit 1
fi
if [[ ${SITE_URL:-} == https://* && $url != "$SITE_URL" && $url != "$SITE_URL/" ]]; then
  printf 'The display must open %s. Do not use a different HTTP address after HTTPS is enabled.\n' "$SITE_URL" >&2
  exit 1
fi

# Labwc does not always activate graphical-session.target. Keep the startup
# hook in its own marked block, preserving unrelated desktop commands.
labwc_startup=false
if [[ -d $config_home/labwc || ${XDG_CURRENT_DESKTOP:-} == *labwc* || ${DESKTOP_SESSION:-} == *labwc* ]] || command -v labwc >/dev/null 2>&1; then
  labwc_startup=true
  : >"$staging/autostart"
  : >"$staging/legacy-block"
  in_block=false
  if [[ -f $autostart ]]; then
    while IFS= read -r entry || [[ -n $entry ]]; do
      if [[ $entry == "$marker" ]]; then
        if $in_block; then
          printf 'The Family Hub startup block is incomplete. Repair its markers in %s, then retry.\n' "$autostart" >&2
          exit 1
        fi
        in_block=true
      elif [[ $entry == "$end_marker" ]]; then
        if ! $in_block; then
          printf 'The Family Hub startup block is incomplete. Repair its markers in %s, then retry.\n' "$autostart" >&2
          exit 1
        fi
        in_block=false
      elif $in_block; then
        printf '%s\n' "$entry" >>"$staging/legacy-block"
      else
        printf '%s\n' "$entry" >>"$staging/autostart"
      fi
    done <"$autostart"
    if $in_block; then
      printf 'The Family Hub startup block is incomplete. Repair its markers in %s, then retry.\n' "$autostart" >&2
      exit 1
    fi
  else
    printf '#!/bin/sh\n' >"$staging/autostart"
    # A user autostart file takes precedence over the system file. Continue
    # running the system defaults instead of replacing the rest of the desktop.
    IFS=: read -r -a system_config_dirs <<<"${XDG_CONFIG_DIRS:-/etc/xdg}"
    for directory in "${system_config_dirs[@]}"; do
      if [[ -f $directory/labwc/autostart ]]; then
        printf '/bin/sh %q &\n' "$directory/labwc/autostart" >>"$staging/autostart"
        break
      fi
    done
  fi
  cat >>"$staging/autostart" <<'EOF'
# Family Hub kiosk
(
  for name in DISPLAY WAYLAND_DISPLAY XDG_CURRENT_DESKTOP XDG_SESSION_TYPE; do
    if printenv "$name" >/dev/null; then
      systemctl --user import-environment "$name" || exit 1
    fi
  done
  systemctl --user start family-hub-display.service
) &
# End Family Hub kiosk
EOF
fi

chromium_bin=
for candidate in /usr/lib/chromium/chromium chromium chromium-browser; do
  if [[ $candidate == /* && -x $candidate ]] || command -v "$candidate" >/dev/null 2>&1; then
    chromium_bin=$candidate
    break
  fi
done
if [[ -z $chromium_bin ]]; then
  if ! command -v apt-get >/dev/null 2>&1; then
    printf 'Install Chromium, then run this installer again.\n' >&2
    exit 1
  fi
  sudo apt-get update
  sudo apt-get install -y chromium || sudo apt-get install -y chromium-browser
  chromium_bin=$(command -v chromium || command -v chromium-browser)
fi

# Migrate only a direct browser launch from a known older managed block.
# Match the account, browser name, kiosk flag, exact profile, and old URL.
# Never stop the current service's browser or use a broad Chromium process kill.
if $labwc_startup && [[ -n $legacy_url ]] && grep -Fq -- '--kiosk' "$staging/legacy-block" && grep -Fq -- '.config/family-hub-kiosk' "$staging/legacy-block"; then
  # Chromium can move its main process to a desktop scope. The service's
  # tracked MainPID still belongs to this installer even outside its group.
  systemctl --user show --property=Version >/dev/null
  current_service_pid=$(systemctl --user show family-hub-display.service --property=MainPID --value 2>/dev/null || true)
  for process in /proc/[0-9]*; do
    [[ -O $process ]] || continue
    [[ ${process##*/} != "$current_service_pid" ]] || continue
    if ! mapfile -d '' -t arguments 2>/dev/null <"$process/cmdline"; then
      continue
    fi
    case ${arguments[0]:-} in
      */chromium|*/chromium-browser|chromium|chromium-browser) ;;
      *) continue ;;
    esac
    is_kiosk=false
    same_profile=false
    same_url=false
    for argument in "${arguments[@]}"; do
      [[ $argument != --kiosk ]] || is_kiosk=true
      [[ $argument != "--user-data-dir=$HOME/.config/family-hub-kiosk" ]] || same_profile=true
      [[ $argument != "$legacy_url" ]] || same_url=true
    done
    $is_kiosk && $same_profile && $same_url || continue
    if grep -Fq '/family-hub-display.service' "$process/cgroup" 2>/dev/null; then
      continue
    fi
    pid=${process##*/}
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid"
      for _ in $(seq 1 100); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.1
      done
      if kill -0 "$pid" 2>/dev/null; then
        printf 'The old Family Hub kiosk did not exit. Stop that kiosk, then run the installer again.\n' >&2
        exit 1
      fi
      changed=true
    fi
  done
fi

printf '%s\n' "$url" >"$staging/url"
install_changed "$staging/url" "$url_file" 600

cat >"$staging/display.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
runtime=\${XDG_RUNTIME_DIR:-/run/user/\$(id -u)}
export XDG_RUNTIME_DIR=\$runtime
for _ in \$(seq 1 60); do
  if [[ -n \${WAYLAND_DISPLAY:-} || -n \${DISPLAY:-} || -S \$runtime/wayland-0 ]]; then
    break
  fi
  sleep 1
done
if [[ -z \${WAYLAND_DISPLAY:-} && -S \$runtime/wayland-0 ]]; then
  export WAYLAND_DISPLAY=wayland-0
fi
bin=$chromium_bin
args=(--disable-dev-shm-usage --user-data-dir="\$HOME/.config/family-hub-kiosk" --password-store=basic --kiosk --noerrdialogs --disable-session-crashed-bubble --disable-infobars)
if [[ -n \${WAYLAND_DISPLAY:-} ]]; then
  args+=(--ozone-platform=wayland --disable-gpu-rasterization --use-angle=gles)
fi
exec "\$bin" "\${args[@]}" $(printf '%q' "$url")
EOF
install_changed "$staging/display.sh" "$wrapper" 700

cat >"$staging/display.service" <<EOF
[Unit]
Description=Family Hub display
After=graphical-session.target
PartOf=graphical-session.target

[Service]
ExecStart=$wrapper
Restart=on-failure
RestartSec=3

[Install]
WantedBy=graphical-session.target
EOF
install_changed "$staging/display.service" "$unit" 644

if $labwc_startup; then
  install -d "$config_home/labwc"
  autostart_mode=644
  [[ ! -f $autostart ]] || autostart_mode=$(stat -c '%a' "$autostart")
  install_changed "$staging/autostart" "$autostart" "$autostart_mode"
fi

if [[ $changed == true ]]; then
  systemctl --user daemon-reload
fi
if ! systemctl --user is-enabled --quiet family-hub-display.service; then
  systemctl --user enable family-hub-display.service
  changed=true
fi
if [[ $changed == true && $existing == true ]]; then
  systemctl --user restart family-hub-display.service
  printf 'Updated the Family Hub display for %s. The browser profile was kept.\n' "$url"
elif ! systemctl --user is-active --quiet family-hub-display.service; then
  systemctl --user start family-hub-display.service
  changed=true
  printf 'Installed the Family Hub display for %s. The browser restarts if it exits.\n' "$url"
else
  printf 'The Family Hub display is already running for %s.\n' "$url"
fi
printf 'Family Hub display changed: %s\n' "$changed"
