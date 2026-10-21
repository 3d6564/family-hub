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
if [[ -f $url_file ]]; then
  saved_url=$(head -n 1 "$url_file")
elif [[ -f $autostart ]] && grep -Fq "$marker" "$autostart"; then
  existing=true
  saved_url=$(sed -n "/$marker/,/$end_marker/p" "$autostart" | grep -oE 'https?://[^[:space:]'\''")]+' | head -n 1 || true)
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

if [[ -f $autostart ]] && grep -Fq "$marker" "$autostart"; then
  retained=$(mktemp)
  in_block=false
  while IFS= read -r entry || [[ -n $entry ]]; do
    if [[ $entry == "$marker" ]]; then
      in_block=true
      continue
    fi
    if [[ $entry == "$end_marker" ]]; then
      in_block=false
      continue
    fi
    $in_block || printf '%s\n' "$entry" >>"$retained"
  done <"$autostart"
  mv "$retained" "$autostart"
  changed=true
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
